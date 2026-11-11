import express from 'express'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dbTransaction, relationshipPrototypeEnvironmentSafe } from '../db/db.ts'
import type { DbTransaction } from '../db/db.ts'
import { requireAuth, stagedInvitationAuthConfigured } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const relationshipPrototypeRouter = express.Router()
const VERSION = 'coi-all-current-future-v1'
const DISCLOSURE = {
  version: VERSION,
  scope: 'I agree to share ALL of my current and future COI information with the connected general contractor, including policy details, coverages and review notes. This continues until I revoke the connection. Certificate files and file links are not available in this prototype, and link-like metadata may be omitted. This does not grant access to the general contractor’s clients.',
  qr: 'A QR code is a bearer capability: any qualifying signed-in general contractor who obtains and scans it before it expires can connect and receive this information, without another approval from me. Share it only deliberately.',
  invitation: 'By accepting, I authorize the specific general contractor identified on the invitation preview to receive this information.',
}
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
// Even free-text notes can contain a direct link. Conservatively suppress
// URL-shaped strings rather than accidentally giving the GC a public file URL.
// This is not a replacement for private storage or a general DLP system.
function withoutLinks(value: any): any {
  if (typeof value === 'string') {
    return /[\\/]|\b[a-z][a-z0-9+.-]*:|\bwww\.|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(value) ? '[link-like content omitted]' : value
  }
  if (Array.isArray(value)) return value.map(withoutLinks)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutLinks(item)]))
  return value
}
class HttpError extends Error {
  status: number
  response: object
  constructor(status: number, response: object) { super('prototype error'); this.status = status; this.response = response }
}
const fail = (status: number, error: string): never => { throw new HttpError(status, { error }) }

relationshipPrototypeRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' })
  if (!relationshipPrototypeEnvironmentSafe() || !stagedInvitationAuthConfigured()) return res.status(503).json({ error: 'Development prototype unavailable' })
  next()
})
relationshipPrototypeRouter.use(requireAuth)

type Handler = (req: AuthRequest, res: express.Response) => Promise<void>
function handle(fn: Handler): express.RequestHandler {
  return (req, res) => { void fn(req as AuthRequest, res).catch((err) => {
    if (err instanceof HttpError) return res.status(err.status).json(err.response)
    return res.status(503).json({ error: 'Development prototype unavailable' })
  }) }
}
async function actor(tx: DbTransaction, req: AuthRequest, role: 'gc' | 'sub') {
  if (!req.user?.id || req.user.role !== role) return fail(403, `${role} access required`)
  const user = await tx.get<any>('SELECT id, role, company_name, subcontractor_id FROM users WHERE id = ?', [req.user.id])
  if (!user || user.role !== role) return fail(403, `${role} access required`)
  return user
}
async function gcProfile(tx: DbTransaction, id: string) {
  const user = await tx.get<any>("SELECT id, company_name FROM users WHERE id = ? AND role = 'gc'", [id])
  const settings = await tx.all<any>('SELECT id FROM gc_settings WHERE user_id = ?', [id])
  return user?.company_name?.trim() && settings.length === 1 ? user : undefined
}
// The existing data model is not a trusted tenant system. For this synthetic
// experiment only, require an unambiguous two-way association at every read.
async function subProfile(tx: DbTransaction, id: string) {
  const user = await tx.get<any>("SELECT id, company_name, subcontractor_id FROM users WHERE id = ? AND role = 'sub'", [id])
  if (!user?.company_name?.trim() || !user.subcontractor_id) return undefined
  const profiles = await tx.all<any>('SELECT id, company_name, trade FROM subcontractors WHERE user_id = ?', [id])
  const users = await tx.all<any>('SELECT id FROM users WHERE subcontractor_id = ?', [user.subcontractor_id])
  return profiles.length === 1 && profiles[0].id === user.subcontractor_id && users.length === 1 && users[0].id === id ? profiles[0] : undefined
}
function consent(body: any) {
  if (body?.consent !== true || body?.consent_version !== VERSION) fail(400, 'Explicit consent to the current disclosure is required')
}
function tokenValue(body: any): string {
  if (typeof body?.token !== 'string' || !tokenPattern.test(body.token)) return fail(404, 'Capability unavailable')
  return body.token
}
async function capability(tx: DbTransaction, token: string, kind: string) {
  const row = await tx.get<any>('SELECT * FROM prototype_relationship_capabilities WHERE token_hash = ? AND kind = ?', [hash(token), kind])
  if (!row || row.revoked_at || row.consumed_at || row.expires_at <= now()) return fail(404, 'Capability unavailable')
  return row
}
async function issue(tx: DbTransaction, ownerId: string, kind: 'gc_invite' | 'sub_qr', profileId: string | null) {
  const token = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const created = now()
  const expires = new Date(Date.parse(created) + (kind === 'sub_qr' ? 10 * 60_000 : 24 * 60 * 60_000)).toISOString()
  await tx.run(`INSERT INTO prototype_relationship_capabilities
    (id, token_hash, kind, owner_user_id, sub_profile_id, consent_version, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, hash(token), kind, ownerId, profileId, kind === 'sub_qr' ? VERSION : null, created, expires])
  return { id, token, expires_at: expires }
}
async function connect(tx: DbTransaction, cap: any, gcId: string, gcCompanyName: string, subId: string, profileId: string, consentedAt: string) {
  const connectedAt = now()
  if (cap.expires_at <= connectedAt) return fail(404, 'Capability unavailable')
  const consumed = await tx.run('UPDATE prototype_relationship_capabilities SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [connectedAt, cap.id, connectedAt])
  if (consumed.changes !== 1) return fail(404, 'Capability unavailable')
  await tx.run(`INSERT INTO prototype_relationships (gc_user_id, sub_user_id, sub_profile_id, active, connected_at, revoked_at, consent_version, source, source_id)
    VALUES (?, ?, ?, 1, ?, NULL, ?, ?, ?)
    ON CONFLICT (gc_user_id, sub_user_id) DO UPDATE SET sub_profile_id = excluded.sub_profile_id,
    active = 1, connected_at = excluded.connected_at, revoked_at = NULL, consent_version = excluded.consent_version,
    source = excluded.source, source_id = excluded.source_id`, [gcId, subId, profileId, connectedAt, VERSION, cap.kind, cap.id])
  await tx.run(`INSERT INTO prototype_consent_events (id, gc_user_id, sub_user_id, sub_profile_id, gc_company_name, consent_version, source, source_id, consented_at, connected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), gcId, subId, profileId, gcCompanyName, VERSION, cap.kind, cap.id, consentedAt, connectedAt])
}

relationshipPrototypeRouter.get('/disclosure', handle(async (req, res) => {
  await dbTransaction(tx => actor(tx, req, 'sub'))
  res.json(DISCLOSURE)
}))

relationshipPrototypeRouter.post('/gc-invitations', handle(async (req, res) => {
  const result = await dbTransaction(async tx => {
    const gc = await actor(tx, req, 'gc')
    if (!await gcProfile(tx, gc.id)) return fail(409, 'Unambiguous GC profile required')
    return issue(tx, gc.id, 'gc_invite', null)
  })
  res.status(201).json(result)
}))
relationshipPrototypeRouter.post('/gc-invitations/preview', handle(async (req, res) => {
  const result = await dbTransaction(async tx => {
    const sub = await actor(tx, req, 'sub')
    if (!await subProfile(tx, sub.id)) return fail(409, 'Unambiguous account-owned subcontractor profile required')
    const cap = await capability(tx, tokenValue(req.body), 'gc_invite')
    const gc = await gcProfile(tx, cap.owner_user_id)
    if (!gc) return fail(404, 'Capability unavailable')
    return { gc_user_id: gc.id, gc_company_name: withoutLinks(gc.company_name.trim()), expires_at: cap.expires_at, disclosure: DISCLOSURE }
  })
  res.json(result)
}))
relationshipPrototypeRouter.post('/gc-invitations/accept', handle(async (req, res) => {
  consent(req.body)
  await dbTransaction(async tx => {
    const sub = await actor(tx, req, 'sub')
    const profile = await subProfile(tx, sub.id)
    if (!profile) return fail(409, 'Unambiguous account-owned subcontractor profile required')
    const cap = await capability(tx, tokenValue(req.body), 'gc_invite')
    const gc = await gcProfile(tx, cap.owner_user_id)
    if (!gc || req.body?.gc_user_id !== gc.id || req.body?.gc_company_name !== gc.company_name.trim() || withoutLinks(gc.company_name.trim()) !== gc.company_name.trim()) return fail(404, 'Capability unavailable')
    await connect(tx, cap, gc.id, gc.company_name.trim(), sub.id, profile.id, now())
  })
  res.json({ status: 'connected' })
}))
relationshipPrototypeRouter.post('/sub-qr', handle(async (req, res) => {
  consent(req.body)
  const result = await dbTransaction(async tx => {
    const sub = await actor(tx, req, 'sub')
    const profile = await subProfile(tx, sub.id)
    if (!profile) return fail(409, 'Unambiguous account-owned subcontractor profile required')
    return issue(tx, sub.id, 'sub_qr', profile.id)
  })
  res.status(201).json(result)
}))
relationshipPrototypeRouter.post('/sub-qr/preview', handle(async (req, res) => {
  const result = await dbTransaction(async tx => {
    const gc = await actor(tx, req, 'gc')
    if (!await gcProfile(tx, gc.id)) return fail(409, 'Unambiguous GC profile required')
    const cap = await capability(tx, tokenValue(req.body), 'sub_qr')
    const profile = await subProfile(tx, cap.owner_user_id)
    if (!profile || profile.id !== cap.sub_profile_id || cap.consent_version !== VERSION) return fail(404, 'Capability unavailable')
    return { company_name: withoutLinks(profile.company_name), trade: withoutLinks(profile.trade), expires_at: cap.expires_at }
  })
  res.json(result)
}))
relationshipPrototypeRouter.post('/sub-qr/accept', handle(async (req, res) => {
  await dbTransaction(async tx => {
    const gc = await actor(tx, req, 'gc')
    const owner = await gcProfile(tx, gc.id)
    if (!owner) return fail(409, 'Unambiguous GC profile required')
    const cap = await capability(tx, tokenValue(req.body), 'sub_qr')
    const profile = await subProfile(tx, cap.owner_user_id)
    if (!profile || profile.id !== cap.sub_profile_id || cap.consent_version !== VERSION) return fail(404, 'Capability unavailable')
    await connect(tx, cap, gc.id, owner.company_name.trim(), cap.owner_user_id, profile.id, cap.created_at)
  })
  res.json({ status: 'connected' })
}))
// Owners can cancel unused codes. Revoking a connection also cancels every
// outstanding QR from that sub, preventing a stale code from undoing revocation.
relationshipPrototypeRouter.delete('/capabilities/:id', handle(async (req, res) => {
  await dbTransaction(async tx => {
    const role = req.user?.role
    if (role !== 'gc' && role !== 'sub') return fail(403, 'Access denied')
    const user = await actor(tx, req, role)
    const updated = await tx.run('UPDATE prototype_relationship_capabilities SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND owner_user_id = ? AND kind = ?', [now(), req.params.id, user.id, role === 'gc' ? 'gc_invite' : 'sub_qr'])
    if (!updated.changes) return fail(404, 'Capability unavailable')
  })
  res.json({ revoked: true })
}))
relationshipPrototypeRouter.get('/sub/connections', handle(async (req, res) => {
  const connections = await dbTransaction(async tx => {
    const sub = await actor(tx, req, 'sub')
    const profile = await subProfile(tx, sub.id)
    if (!profile) return fail(409, 'Unambiguous account-owned subcontractor profile required')
    const rows = await tx.all<any>(`SELECT r.gc_user_id, r.connected_at, r.source FROM prototype_relationships r
      WHERE r.sub_user_id = ? AND r.sub_profile_id = ? AND r.active = 1 ORDER BY r.connected_at`, [sub.id, profile.id])
    const result = []
    for (const row of rows) {
      const gc = await gcProfile(tx, row.gc_user_id)
      // Show revoked/unqualified GC identities too, so the sub can revoke them.
      result.push({ ...row, gc_company_name: gc?.company_name?.trim() || null })
    }
    return result
  })
  res.json({ connections: withoutLinks(connections) })
}))
relationshipPrototypeRouter.delete('/sub/connections/:gcId', handle(async (req, res) => {
  await dbTransaction(async tx => {
    const sub = await actor(tx, req, 'sub')
    const changed = await tx.run('UPDATE prototype_relationships SET active = 0, revoked_at = COALESCE(revoked_at, ?) WHERE sub_user_id = ? AND gc_user_id = ?', [now(), sub.id, req.params.gcId])
    if (!changed.changes) return fail(404, 'Connection unavailable')
    await tx.run("UPDATE prototype_relationship_capabilities SET revoked_at = COALESCE(revoked_at, ?) WHERE owner_user_id = ? AND kind = 'sub_qr' AND consumed_at IS NULL", [now(), sub.id])
  })
  res.json({ revoked: true })
}))
relationshipPrototypeRouter.get('/gc/connections', handle(async (req, res) => {
  const connections = await dbTransaction(async tx => {
    const gc = await actor(tx, req, 'gc')
    if (!await gcProfile(tx, gc.id)) return fail(409, 'Unambiguous GC profile required')
    const rows = await tx.all<any>(`SELECT sub_user_id, sub_profile_id, connected_at FROM prototype_relationships
      WHERE gc_user_id = ? AND active = 1 ORDER BY connected_at`, [gc.id])
    const result = []
    for (const row of rows) {
      const profile = await subProfile(tx, row.sub_user_id)
      if (!profile || profile.id !== row.sub_profile_id) continue
      // Explicit allowlist, never SELECT * and never return certificate URL or key.
      const cois = await tx.all<any>(`SELECT id, carrier, am_best_rating, policy_number, effective_date, expiration_date,
        status, reviewer_notes, review_date, certificate_name, certificate_size, certificate_mime, created_at, updated_at
        FROM cois WHERE subcontractor_id = ? ORDER BY created_at, id`, [profile.id])
      for (const coi of cois) coi.coverages = await tx.all(`SELECT id, type, per_occurrence_limit, aggregate_limit,
        additional_insured, waiver_of_subrogation, notes FROM coi_coverages WHERE coi_id = ? ORDER BY id`, [coi.id])
      result.push({ sub_user_id: row.sub_user_id, company_name: profile.company_name, trade: profile.trade, connected_at: row.connected_at, cois })
    }
    return result
  })
  res.json({ connections: withoutLinks(connections) })
}))
