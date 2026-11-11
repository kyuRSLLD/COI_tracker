import express from 'express'
import type { NextFunction, Response } from 'express'
import jwt from 'jsonwebtoken'
import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { dbAll } from '../db/db.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { privateLocalPath, signedPrivateFileUrl } from '../services/storage.ts'
import { acceptInvitation, createInvitation, draftReview, gcDraft, gcDrafts, gcInvitations, initDraftAccess, ownedProject, previewInvitation, revokePermission, subPermissions, validToken } from '../services/draftAccess.ts'

// Mount at /api/draft-review. All operations, including document redemption, require
// a current DB-backed role via requireAuth; no client-share route is involved.
export const draftReviewRouter = express.Router()
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const token = z.string().refine(validToken)
const empty = z.object({}).strict()
const asyncRoute = (handler: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (req: AuthRequest, res: Response) => { void handler(req, res).catch(() => { if (!res.headersSent) res.status(503).json({ error: 'Draft review temporarily unavailable' }); else res.end() }) }
const role = (required: 'gc' | 'sub') => (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.user?.role !== required) return res.status(403).json({ error: 'Account role not permitted' })
  next()
}
const paramsOk = (req: AuthRequest, ...names: string[]) => names.every(name => id.safeParse(req.params[name]).success)
const notFound = (res: Response) => res.status(404).json({ error: 'Not found or unavailable' })
const bad = (res: Response) => res.status(400).json({ error: 'Invalid request' })

draftReviewRouter.use(requireAuth)
draftReviewRouter.use((req, res, next) => {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  if (Object.keys(req.query).length) return bad(res) // capabilities must never be placed in query strings
  next()
})
draftReviewRouter.use((req, res, next) => { void initDraftAccess().then(() => next(), () => res.status(503).json({ error: 'Draft review temporarily unavailable' })) })

draftReviewRouter.post('/projects/:projectId/invitations', role('gc'), asyncRoute(async (req, res) => {
  const body = z.object({ expires_in_hours: z.number().int().min(1).max(168) }).strict().safeParse(req.body)
  if (!paramsOk(req, 'projectId') || !body.success) return bad(res)
  const invitation = await createInvitation(req.params.projectId, req.user!.id, body.data.expires_in_hours)
  if (!invitation) return notFound(res)
  // The capability is returned exactly once. Transfer it through an authenticated,
  // confidential channel; possession does not itself grant any document access.
  return res.status(201).json({ invitation })
}))
draftReviewRouter.get('/projects/:projectId/invitations', role('gc'), asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'projectId')) return bad(res)
  if (!await ownedProject(req.params.projectId, req.user!.id)) return notFound(res)
  return res.json({ invitations: await gcInvitations(req.params.projectId, req.user!.id) })
}))
draftReviewRouter.post('/invitations/preview', role('sub'), asyncRoute(async (req, res) => {
  const body = z.object({ token }).strict().safeParse(req.body)
  if (!body.success) return bad(res)
  const invitation = await previewInvitation(body.data.token)
  return invitation ? res.json({ invitation }) : notFound(res)
}))
draftReviewRouter.get('/my/drafts', role('sub'), asyncRoute(async (req, res) => {
  const drafts = await dbAll(`SELECT id, certificate_name, certificate_mime, certificate_size, created_at, ocr_status
    FROM sub_coi_drafts WHERE owner_user_id = ? ORDER BY created_at DESC`, [req.user!.id])
  return res.json({ drafts })
}))
draftReviewRouter.post('/permissions', role('sub'), asyncRoute(async (req, res) => {
  const body = z.object({ token, project_id: id, draft_id: id, consent: z.literal(true) }).strict().safeParse(req.body)
  if (!body.success) return bad(res)
  const permission = await acceptInvitation(body.data.token, body.data.draft_id, req.user!.id, body.data.project_id)
  return permission ? res.status(201).json({ permission }) : notFound(res)
}))
draftReviewRouter.get('/my/permissions', role('sub'), asyncRoute(async (req, res) => {
  return res.json({ permissions: await subPermissions(req.user!.id) })
}))
draftReviewRouter.post('/permissions/:permissionId/revoke', asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'permissionId') || !empty.safeParse(req.body).success) return bad(res)
  if (req.user!.role !== 'sub' && req.user!.role !== 'gc') return res.status(403).json({ error: 'Account role not permitted' })
  const result = await revokePermission(req.params.permissionId, req.user!.id, req.user!.role)
  return result.changes ? res.json({ revoked: true }) : notFound(res)
}))
draftReviewRouter.get('/projects/:projectId/drafts', role('gc'), asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'projectId')) return bad(res)
  if (!await ownedProject(req.params.projectId, req.user!.id)) return notFound(res)
  return res.json({ drafts: await gcDrafts(req.params.projectId, req.user!.id) })
}))
draftReviewRouter.get('/projects/:projectId/drafts/:permissionId', role('gc'), asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'projectId', 'permissionId')) return bad(res)
  const row = await gcDraft(req.params.projectId, req.user!.id, req.params.permissionId)
  if (!row) return notFound(res)
  const review = await draftReview(row, req.params.projectId)
  if (!await gcDraft(req.params.projectId, req.user!.id, req.params.permissionId)) return notFound(res)
  return res.json({ review })
}))

// Separate derived signing key/purpose: even in development there is no default key.
// The recipient must also present its access JWT, and consent/ownership are checked
// again on every document request. Signed capabilities never appear in a URL.
function documentKey(): Buffer {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32 || secret === 'dev-secret-change-in-production') throw new Error('Signing not configured')
  return createHmac('sha256', secret).update('coi-draft-gc-document-v1').digest()
}
draftReviewRouter.post('/projects/:projectId/drafts/:permissionId/document-link', role('gc'), asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'projectId', 'permissionId') || !empty.safeParse(req.body).success) return bad(res)
  const row = await gcDraft(req.params.projectId, req.user!.id, req.params.permissionId)
  if (!row) return notFound(res)
  if (!['local', 's3'].includes(row.storage_backend) || (row.storage_backend === 'local' && process.env.NODE_ENV === 'production')) return res.status(503).json({ error: 'Private document unavailable' })
  const capability = jwt.sign({ purpose: 'gc-draft-document', gc: req.user!.id, project: req.params.projectId, permission: req.params.permissionId, draft: row.draft_id }, documentKey(), { algorithm: 'HS256', expiresIn: 120 })
  return res.json({ path: `/api/draft-review/projects/${encodeURIComponent(req.params.projectId)}/drafts/${encodeURIComponent(req.params.permissionId)}/document`, capability, expires_in_seconds: 120 })
}))
draftReviewRouter.get('/projects/:projectId/drafts/:permissionId/document', role('gc'), asyncRoute(async (req, res) => {
  if (!paramsOk(req, 'projectId', 'permissionId')) return bad(res)
  const capability = req.get('X-Draft-Document-Capability')
  if (!capability || capability.length > 2048) return notFound(res)
  let payload: any
  try { payload = jwt.verify(capability, documentKey(), { algorithms: ['HS256'], maxAge: '120s' }) } catch { return notFound(res) }
  if (payload.purpose !== 'gc-draft-document' || payload.gc !== req.user!.id || payload.project !== req.params.projectId || payload.permission !== req.params.permissionId) return notFound(res)
  const row = await gcDraft(req.params.projectId, req.user!.id, req.params.permissionId)
  if (!row || payload.draft !== row.draft_id || !['application/pdf', 'image/png', 'image/jpeg'].includes(row.certificate_mime) || !Number.isSafeInteger(row.certificate_size) || row.certificate_size < 1 || row.certificate_size > 25 * 1024 * 1024) return notFound(res)
  res.set({ 'Content-Type': row.certificate_mime, 'Content-Disposition': 'attachment', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' })
  if (row.storage_backend === 'local' && process.env.NODE_ENV !== 'production') {
    return res.sendFile(privateLocalPath(row.storage_key), (err) => { if (err && !res.headersSent) res.status(404).end() })
  }
  if (row.storage_backend !== 's3') return notFound(res)
  // Fetch the short-lived private S3 URL on the server; never return it to the caller.
  const url = await signedPrivateFileUrl(row.storage_key)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok || !response.body) return notFound(res)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    length += item.value.length
    if (length > 25 * 1024 * 1024 || length > row.certificate_size) { await reader.cancel(); return notFound(res) }
    chunks.push(item.value)
  }
  if (length !== row.certificate_size) return notFound(res)
  return res.send(Buffer.concat(chunks))
}))
