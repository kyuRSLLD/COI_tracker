import express from 'express'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { dbGet, dbAll, dbRun, isPostgres, lockConnectionUsers, withTransaction } from '../db/db.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { getFileViewUrl } from '../services/storage.ts'

export const coiFieldsRouter = express.Router()

// Every nested object is strict and partial: unextracted/unknown fields may be
// omitted, but arbitrary keys, nulls, oversized strings and arrays are rejected.
const producer = z.object({
  name: z.string().max(256).optional(), address: z.string().max(2000).optional(),
  phone: z.string().max(128).optional(), email: z.string().max(254).optional(),
}).strict()
const insured = z.object({ name: z.string().max(256).optional(), address: z.string().max(2000).optional() }).strict()
const insurer = z.object({
  letter: z.string().max(32).optional(), name: z.string().max(256).optional(), naic: z.string().max(64).optional(),
}).strict()
const limit = z.object({ label: z.string().max(256).optional(), amount: z.string().max(128).optional() }).strict()
const policy = z.object({
  type: z.string().max(256).optional(), insurerLetter: z.string().max(32).optional(),
  policyNumber: z.string().max(256).optional(), effectiveDate: z.string().max(64).optional(),
  expirationDate: z.string().max(64).optional(), limits: z.array(limit).max(20).optional(),
}).strict()
const detailsSchema = z.object({
  producer: producer.optional(), insured: insured.optional(), insurers: z.array(insurer).max(10).optional(),
  policies: z.array(policy).max(20).optional(), source: z.enum(['ocr', 'manual', 'mixed']).optional(),
}).strict()
const putSchema = z.object({ sourceTag: z.string().max(128), reviewRevision: z.string().max(128), details: detailsSchema }).strict()

type AccessRow = {
  id: string
  certificate_key: string | null
  owner_gc_user_id: string | null
  owner_sub_user_id: string | null
  profile_id: string
  profile_user_id: string | null
  actor_role: string
  source_tag: string | null
  details_json: string | null
  revision: string | null
}

// A stable digest, scoped to this COI, including an explicit null sentinel for
// a certificate-less record. The key and any legacy URL never leave the server.
export function sourceTag(id: string, key: string | null): string {
  return createHash('sha256').update(JSON.stringify(['coi-field-review-v1', id, key]), 'utf8').digest('hex')
}

// The sub portal uses the first owned profile; never infer ownership from an
// email or from users.subcontractor_id. Dual-owned and ownerless rows fail both
// branches. A GC may see only its own or its connected sub's owned record.
const joins = `FROM cois c
  JOIN subcontractors s ON s.id = c.subcontractor_id
  JOIN users actor ON actor.id = ?
  LEFT JOIN users sub_owner ON sub_owner.id = c.owner_sub_user_id AND sub_owner.role = 'sub'
  LEFT JOIN users gc_owner ON gc_owner.id = c.owner_gc_user_id AND gc_owner.role = 'gc'`
const access = `(
  (actor.role = 'gc' AND EXISTS (SELECT 1 FROM gc_sub_connections g
      WHERE g.gc_user_id = actor.id AND g.subcontractor_id = c.subcontractor_id)
    AND ((c.owner_gc_user_id = actor.id AND c.owner_sub_user_id IS NULL)
      OR (c.owner_gc_user_id IS NULL AND c.owner_sub_user_id IS NOT NULL
        AND c.owner_sub_user_id = s.user_id AND sub_owner.id IS NOT NULL)))
  OR (actor.role = 'sub' AND s.user_id = actor.id
    AND s.id = (SELECT sp.id FROM subcontractors sp WHERE sp.user_id = actor.id ORDER BY sp.created_at, sp.id LIMIT 1)
    AND ((c.owner_sub_user_id = actor.id AND c.owner_gc_user_id IS NULL)
      OR (c.owner_sub_user_id IS NULL AND c.owner_gc_user_id IS NOT NULL AND gc_owner.id IS NOT NULL
        AND EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.gc_user_id = c.owner_gc_user_id
          AND g.subcontractor_id = c.subcontractor_id))))
)`
const selectAccess = `SELECT c.id, c.certificate_key, c.owner_gc_user_id, c.owner_sub_user_id,
    s.id AS profile_id, s.user_id AS profile_user_id, actor.role AS actor_role, r.source_tag, r.details_json, v.revision
  ${joins} LEFT JOIN coi_field_reviews r ON r.coi_id = c.id
  LEFT JOIN coi_field_review_versions v ON v.coi_id = c.id
  WHERE c.id = ? AND ${access}`

function editable(row: AccessRow, userId: string): boolean {
  return (row.actor_role === 'gc' && row.owner_gc_user_id === userId && row.owner_sub_user_id === null) ||
    (row.actor_role === 'sub' && row.owner_sub_user_id === userId && row.owner_gc_user_id === null)
}
// This sentinel is outside the UUID token space. Legacy reviews without a
// version remain readable and use it until their first successful save.
const NO_REVIEW_REVISION = 'no-review'
function responseFor(row: AccessRow, userId: string) {
  const tag = sourceTag(row.id, row.certificate_key)
  let details: z.infer<typeof detailsSchema> | null = null
  if (row.source_tag === tag && typeof row.details_json === 'string') {
    try {
      const parsed = detailsSchema.safeParse(JSON.parse(row.details_json))
      if (parsed.success) details = parsed.data
    } catch { /* malformed stored reviews are never exposed */ }
  }
  return { details, sourceTag: tag,
    reviewRevision: details !== null && row.revision ? row.revision : NO_REVIEW_REVISION,
    editable: editable(row, userId) }
}
function validKey(row: AccessRow): boolean {
  return row.certificate_key === null || typeof row.certificate_key === 'string'
}

// Match cois.publicCOI's allowlist exactly; never pass a persisted URL to the
// storage service. Local storage returns an authenticated local URL, while S3
// returns a fresh signed URL. Signing failure must not expose the key.
async function certificateUrl(key: string | null): Promise<string | null> {
  if (typeof key !== 'string' || !/^(?:cois\/[a-zA-Z0-9._-]+|[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(key)) return null
  try { return await getFileViewUrl(key) } catch { return null }
}

coiFieldsRouter.use(requireAuth)
coiFieldsRouter.get('/:coiId', async (req: AuthRequest, res) => {
  try {
    const row = await dbGet<AccessRow>(selectAccess, [req.user!.id, req.params.coiId])
    if (!row || !validKey(row)) return res.status(404).json({ error: 'COI not found' })
    return res.json({ ...responseFor(row, req.user!.id), certificateUrl: await certificateUrl(row.certificate_key) })
  } catch {
    return res.status(500).json({ error: 'Unable to load field review' })
  }
})

coiFieldsRouter.put('/:coiId', async (req: AuthRequest, res) => {
  const parsed = putSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid field review' })
  try {
    const outcome = await withTransaction(async tx => {
      // Discovery is non-locking. Lock users in the shared connection-flow
      // order, then the profile and connection, and finally the COI. Recheck
      // all authorization and identity facts after locks are acquired.
      const initial = await tx.get<AccessRow>(selectAccess, [req.user!.id, req.params.coiId])
      if (!initial || !validKey(initial)) return { status: 404 as const }
      if (!editable(initial, req.user!.id)) return { status: 403 as const }
      const userIds = [req.user!.id, initial.profile_user_id].filter((id): id is string => typeof id === 'string' && !!id)
      await lockConnectionUsers(tx, userIds)
      const lock = isPostgres ? ' FOR UPDATE' : ''
      const profile = await tx.get<{ id: string; user_id: string | null }>(
        `SELECT s.id, s.user_id FROM subcontractors s JOIN cois c ON c.subcontractor_id = s.id WHERE c.id = ?${isPostgres ? ' FOR UPDATE OF s' : ''}`,
        [req.params.coiId])
      if (!profile || profile.id !== initial.profile_id || profile.user_id !== initial.profile_user_id) return { status: 404 as const }
      if (initial.actor_role === 'gc') {
        const connection = await tx.get(`SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?${lock}`,
          [req.user!.id, profile.id])
        if (!connection) return { status: 404 as const }
      }
      // This row lock serializes against every ordinary certificate replacement
      // UPDATE, so the digest check and child upsert cannot race that update.
      const locked = await tx.get(`SELECT id FROM cois WHERE id = ?${lock}`, [req.params.coiId])
      if (!locked) return { status: 404 as const }
      const row = await tx.get<AccessRow>(selectAccess, [req.user!.id, req.params.coiId])
      if (!row || !validKey(row) || row.profile_id !== initial.profile_id || row.profile_user_id !== initial.profile_user_id ||
          row.actor_role !== initial.actor_role) return { status: 404 as const }
      if (!editable(row, req.user!.id)) return { status: 403 as const }
      const current = responseFor(row, req.user!.id)
      const tag = current.sourceTag
      if (parsed.data.sourceTag !== tag || parsed.data.reviewRevision !== current.reviewRevision) return { status: 409 as const }
      // Repeat both current ownership/connection authorization and the exact
      // key condition in the write itself, in addition to the locks above.
      const changed = await tx.run(`INSERT INTO coi_field_reviews (coi_id, source_tag, details_json)
        SELECT c.id, ?, ? ${joins} WHERE c.id = ? AND ${access}
        AND ((actor.role = 'gc' AND c.owner_gc_user_id = actor.id AND c.owner_sub_user_id IS NULL)
          OR (actor.role = 'sub' AND c.owner_sub_user_id = actor.id AND c.owner_gc_user_id IS NULL))
        AND (c.certificate_key = ? OR (c.certificate_key IS NULL AND CAST(? AS TEXT) IS NULL))
        ON CONFLICT(coi_id) DO UPDATE SET source_tag = excluded.source_tag, details_json = excluded.details_json`,
        [tag, JSON.stringify(parsed.data.details), req.user!.id, req.params.coiId, row.certificate_key, row.certificate_key])
      if (changed.changes !== 1) return { status: 404 as const }
      // The COI lock serializes writers, and both child writes commit or roll
      // back together. Even identical successful saves advance the revision.
      const revision = randomUUID()
      await tx.run(`INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)
        ON CONFLICT(coi_id) DO UPDATE SET revision = excluded.revision`, [row.id, revision])
      return { status: 200 as const, key: row.certificate_key,
        body: { details: parsed.data.details, sourceTag: tag, reviewRevision: revision, editable: true } }
    })
    if (outcome.status === 200) return res.json({ ...outcome.body, certificateUrl: await certificateUrl(outcome.key) })
    if (outcome.status === 409) return res.status(409).json({ error: 'Certificate or review changed; reload the field review' })
    if (outcome.status === 403) return res.status(403).json({ error: 'Only the owner can edit this review' })
    return res.status(404).json({ error: 'COI not found' })
  } catch {
    return res.status(500).json({ error: 'Unable to save field review' })
  }
})


// Save machine-extracted fields on behalf of the system (post-upload). Never overwrites
// an existing review and only succeeds while the certificate key still matches the
// moment of extraction. Bumps the review revision exactly like a user save.
export async function saveExtractedReview(coiId: string, certificateKey: string | null, details: unknown): Promise<boolean> {
  const parsed = detailsSchema.safeParse(details)
  if (!parsed.success) return false
  const tag = sourceTag(coiId, certificateKey)
  const rows = await dbAll<AccessRow>(
    `SELECT c.id FROM cois c WHERE c.id = ? AND (c.certificate_key = ? OR (c.certificate_key IS NULL AND CAST(? AS TEXT) IS NULL))`,
    [coiId, certificateKey, certificateKey],
  )
  if (rows.length !== 1) return false
  try {
    const res = await dbRun(
      `INSERT OR REPLACE INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, ?, ?)`,
      [coiId, tag, JSON.stringify(parsed.data)],
    )
    await dbRun(`INSERT OR REPLACE INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)`, [coiId, randomUUID()])
    return true
  } catch { return false }
}
export { detailsSchema }


// Re-run Textract on the certificate of any authorized COI record and persist the
// machine review (best-effort; failures report empty fields). Available to either owner.
coiFieldsRouter.post('/:coiId/extract', async (req: AuthRequest, res) => {
  try {
    const row = await dbGet<AccessRow>(selectAccess, [req.user!.id, req.params.coiId])
    if (!row || !validKey(row)) return res.status(404).json({ error: 'COI not found' })
    if (!editable(row, req.user!.id)) return res.status(403).json({ error: 'Only the owner can run extraction on this review' })
    const { getFileBuffer } = await import('../services/storage.ts')
    const { tryAnalyzeCoiDocument, isTextractConfigured } = await import('../services/textract.ts')
    if (!isTextractConfigured) return res.status(503).json({ error: 'Extraction service is not configured' })
    if (!row.certificate_key) return res.status(400).json({ error: 'This certificate has no stored file to extract' })
    const buffer = await getFileBuffer(row.certificate_key)
    if (!buffer) return res.status(502).json({ error: 'Could not fetch the stored certificate' })
    const fields = await tryAnalyzeCoiDocument(buffer)
    if (!fields) return res.status(502).json({ error: 'Textract could not extract fields from this document' })
    const ok = await saveExtractedReview(req.params.coiId, row.certificate_key, fields)
    if (!ok) return res.status(500).json({ error: 'Could not persist extracted fields' })
    const fresh = await dbGet<AccessRow>(selectAccess, [req.user!.id, req.params.coiId])
    const body = fresh ? responseFor(fresh, req.user!.id) : null
    return res.json({ details: body?.details, sourceTag: body?.sourceTag, reviewRevision: body?.reviewRevision })
  } catch { return res.status(500).json({ error: 'Extraction failed' }) }
})
