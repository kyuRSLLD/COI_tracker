import express from 'express'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dbAll, dbGet, dbRun, dbTransaction, isPostgres } from '../db/db.ts'
import type { DbTransaction } from '../db/db.ts'
import { requireAuth, stagedInvitationAuthConfigured } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const stagedInvitationsRouter = express.Router()
const TTL_MS = 24 * 60 * 60 * 1000
const SUB_QR_TTL_MS = 10 * 60 * 1000
const PUBLIC_LIMIT = 120 // Shared global budget per minute, across instances.
const badToken = { error: 'Invitation unavailable' }
const tokenFormat = /^[A-Za-z0-9_-]{43}$/
const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')
class InvitationUnavailable extends Error {}

// Opt-in only. Never enable this staged API on a production deployment. The
// app's development fallback secret would allow anyone to forge existing JWTs.
stagedInvitationsRouter.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' })
  if (process.env.NODE_ENV === 'production' || process.env.STAGED_INVITES_ENABLED !== 'true' || !stagedInvitationAuthConfigured()) {
    return res.status(503).json({ error: 'Staged invitations unavailable' })
  }
  next()
})

// A database-backed, global fixed-window budget, rather than an in-memory
// limiter that multiplies across workers. Database errors fail closed. A global
// budget can be exhausted by an attacker; deploy a proper edge limiter before
// production, preferably with per-client and global quotas.
async function publicRateLimit(_req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const window = Math.floor(Date.now() / 60000)
    const hits = await dbTransaction(async tx => {
      await tx.run(`INSERT INTO staged_invite_rate_limit (id, window_start, hits) VALUES ('public', ?, 1)
        ON CONFLICT (id) DO UPDATE SET
          hits = CASE WHEN staged_invite_rate_limit.window_start < excluded.window_start THEN 1 ELSE staged_invite_rate_limit.hits + 1 END,
          window_start = CASE WHEN staged_invite_rate_limit.window_start < excluded.window_start THEN excluded.window_start ELSE staged_invite_rate_limit.window_start END`, [window])
      return Number((await tx.get<{ hits: number }>('SELECT hits FROM staged_invite_rate_limit WHERE id = ?', ['public']))!.hits)
    })
    if (hits > PUBLIC_LIMIT) return res.status(429).json({ error: 'Too many requests' })
    next()
  } catch {
    res.status(503).json({ error: 'Staged invitations unavailable' })
  }
}

async function actor(req: AuthRequest, role: 'gc' | 'sub') {
  if (!req.user?.id || req.user.role !== role) return undefined
  const user = await dbGet<{ id: string, role: string, company_name: string | null, subcontractor_id: string | null }>(
    'SELECT id, role, company_name, subcontractor_id FROM users WHERE id = ?', [req.user.id])
  return user?.role === role ? user : undefined
}

// A profile is considered owned only when user_id explicitly matches and is
// unambiguous. This is not verification of a real-world business identity.
async function ownedProfile(gcId: string) {
  const profiles = await dbAll<{ id: string }>('SELECT id FROM gc_settings WHERE user_id = ?', [gcId])
  return profiles.length === 1 ? profiles[0] : undefined
}

async function validOwner(tx: DbTransaction, gcId: string, profileId: string) {
  const gc = await tx.get<{ company_name: string | null }>('SELECT company_name FROM users WHERE id = ? AND role = ?', [gcId, 'gc'])
  const count = await tx.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM gc_settings WHERE user_id = ?', [gcId])
  const profile = await tx.get<{ id: string }>('SELECT id FROM gc_settings WHERE id = ? AND user_id = ?', [profileId, gcId])
  return gc?.company_name?.trim() && Number(count?.n) === 1 && profile ? gc.company_name.trim() : undefined
}

// QR identity is the signed-in sub user, not an unsafe global subcontractor
// record. Only the sub-supplied trade and its own account company are shared.
async function qrSubOwner(tx: DbTransaction, subId: string, companyName: string, lock = false) {
  const user = await tx.get<{ company_name: string | null }>(
    `SELECT company_name FROM users WHERE id = ? AND role = ?${lock && isPostgres ? ' FOR UPDATE' : ''}`, [subId, 'sub'])
  return Boolean(user?.company_name?.trim() && user.company_name.trim() === companyName)
}

async function qrGcOwner(tx: DbTransaction, gcId: string, lock = false) {
  const suffix = lock && isPostgres ? ' FOR UPDATE' : ''
  const gc = await tx.get<{ company_name: string | null }>(`SELECT company_name FROM users WHERE id = ? AND role = ?${suffix}`, [gcId, 'gc'])
  if (!gc?.company_name?.trim()) return false
  const count = await tx.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM gc_settings WHERE user_id = ?', [gcId])
  if (Number(count?.n) !== 1) return false
  return Boolean(await tx.get(`SELECT id FROM gc_settings WHERE user_id = ?${suffix}`, [gcId]))
}

stagedInvitationsRouter.post('/sub-qr', publicRateLimit, requireAuth, async (req: AuthRequest, res) => {
  try {
    const sub = await actor(req, 'sub')
    if (!sub) return res.status(403).json({ error: 'Subcontractor access required' })
    const trade = req.body?.trade
    if (typeof trade !== 'string' || !trade.trim() || trade.trim().length > 120 || /[\x00-\x1f\x7f]/.test(trade)) {
      return res.status(400).json({ error: 'A trade of 1 to 120 characters is required' })
    }
    const companyName = sub.company_name?.trim()
    if (!companyName) return res.status(409).json({ error: 'An account company name is required' })
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + SUB_QR_TTL_MS).toISOString()
    const issued = await dbTransaction(async tx => {
      if (!await qrSubOwner(tx, sub.id, companyName, true)) return false
      await tx.run(`INSERT INTO staged_sub_qr_capabilities
        (id, token_hash, sub_user_id, company_name, trade, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, hash(token), sub.id, companyName, trade.trim(), now.toISOString(), expiresAt])
      return true
    })
    if (!issued) return res.status(409).json({ error: 'Subcontractor account changed' })
    res.status(201).json({ id, token, expires_at: expiresAt })
  } catch { res.status(503).json({ error: 'Staged invitations unavailable' }) }
})

stagedInvitationsRouter.post('/sub-qr/info', publicRateLimit, requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    const token = req.body?.token
    if (typeof token !== 'string' || !tokenFormat.test(token)) return res.status(404).json(badToken)
    const result = await dbTransaction(async tx => {
      if (!await qrGcOwner(tx, gc.id)) return { invalidGc: true }
      const qr = await tx.get<any>(`SELECT sub_user_id, company_name, trade FROM staged_sub_qr_capabilities
        WHERE token_hash = ? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ?`, [hash(token), new Date().toISOString()])
      if (!qr || !await qrSubOwner(tx, qr.sub_user_id, qr.company_name)) return undefined
      return { company_name: qr.company_name, trade: qr.trade }
    })
    if (result?.invalidGc) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile and company name are required' })
    if (!result) return res.status(404).json(badToken)
    res.json(result)
  } catch { res.status(503).json({ error: 'Staged invitations unavailable' }) }
})

stagedInvitationsRouter.post('/sub-qr/accept', publicRateLimit, requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    const token = req.body?.token
    if (typeof token !== 'string' || !tokenFormat.test(token)) return res.status(404).json(badToken)
    const result = await dbTransaction(async tx => {
      const qr = await tx.get<any>(`SELECT id, sub_user_id, company_name, expires_at, revoked_at, consumed_at
        FROM staged_sub_qr_capabilities WHERE token_hash = ?${isPostgres ? ' FOR UPDATE' : ''}`, [hash(token)])
      if (!qr || qr.revoked_at || qr.consumed_at || qr.expires_at <= new Date().toISOString()) return undefined
      if (!await qrGcOwner(tx, gc.id, true)) return { invalidGc: true }
      if (!await qrSubOwner(tx, qr.sub_user_id, qr.company_name, true)) return undefined
      const inserted = await tx.run(`INSERT INTO staged_gc_sub_relationships (gc_user_id, sub_user_id, created_at, source, source_id)
        VALUES (?, ?, ?, 'sub_qr', ?) ON CONFLICT (gc_user_id, sub_user_id) DO NOTHING`, [gc.id, qr.sub_user_id, new Date().toISOString(), qr.id])
      // A conflict can block until after expiry. Throw to roll back both writes.
      const now = new Date().toISOString()
      if (qr.expires_at <= now) throw new InvitationUnavailable()
      const consumed = await tx.run(`UPDATE staged_sub_qr_capabilities SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, [now, qr.id, now])
      if (consumed.changes !== 1) throw new InvitationUnavailable()
      // Even an existing relationship consumes the QR: it is strictly one-use.
      return { status: 'staged', created: inserted.changes === 1 }
    })
    if (result?.invalidGc) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile and company name are required' })
    if (!result) return res.status(404).json(badToken)
    res.json(result)
  } catch (error) {
    if (error instanceof InvitationUnavailable) return res.status(404).json(badToken)
    res.status(503).json({ error: 'Staged invitations unavailable' })
  }
})

// Public preview traffic must not prevent an authenticated owner from revoking.
stagedInvitationsRouter.delete('/sub-qr/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sub = await actor(req, 'sub')
    if (!sub) return res.status(403).json({ error: 'Subcontractor access required' })
    const result = await dbRun('UPDATE staged_sub_qr_capabilities SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND sub_user_id = ?', [new Date().toISOString(), req.params.id, sub.id])
    if (!result.changes) return res.status(404).json(badToken)
    res.json({ revoked: true })
  } catch { res.status(503).json({ error: 'Staged invitations unavailable' }) }
})

stagedInvitationsRouter.post('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    const profile = await ownedProfile(gc.id)
    if (!profile || !gc.company_name?.trim()) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile and company name are required' })
    const maxUses = req.body?.max_uses ?? 1
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) return res.status(400).json({ error: 'max_uses must be an integer from 1 to 10' })
    const token = randomBytes(32).toString('base64url')
    const id = randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + TTL_MS).toISOString()
    await dbRun(`INSERT INTO staged_gc_invitations (id, token_hash, gc_user_id, gc_settings_id, created_at, expires_at, max_uses, uses)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`, [id, hash(token), gc.id, profile.id, now.toISOString(), expiresAt, maxUses])
    res.status(201).json({ id, token, expires_at: expiresAt, max_uses: maxUses })
  } catch {
    res.status(500).json({ error: 'Unable to create staged invitation' })
  }
})

stagedInvitationsRouter.post('/info', publicRateLimit, async (req, res) => {
  try {
    const token = req.body?.token
    if (typeof token !== 'string' || !tokenFormat.test(token)) return res.status(404).json(badToken)
    const result = await dbTransaction(async tx => {
      const invite = await tx.get<any>(`SELECT gc_user_id, gc_settings_id, expires_at FROM staged_gc_invitations
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses`, [hash(token), new Date().toISOString()])
      if (!invite) return undefined
      const companyName = await validOwner(tx, invite.gc_user_id, invite.gc_settings_id)
      return companyName ? { gc_company_name: companyName, expires_at: invite.expires_at } : undefined
    })
    if (!result) return res.status(404).json(badToken)
    res.json(result)
  } catch {
    res.status(503).json({ error: 'Staged invitations unavailable' })
  }
})

stagedInvitationsRouter.post('/accept', publicRateLimit, requireAuth, async (req: AuthRequest, res) => {
  try {
    const sub = await actor(req, 'sub')
    if (!sub) return res.status(403).json({ error: 'Subcontractor access required' })
    // Do not resolve by email or create/reassign any legacy sub profile.
    const ownProfile = sub.subcontractor_id && await dbGet('SELECT id FROM subcontractors WHERE id = ? AND user_id = ?', [sub.subcontractor_id, sub.id])
    if (!ownProfile) return res.status(409).json({ error: 'An account-owned subcontractor profile is required' })
    const token = req.body?.token
    if (typeof token !== 'string' || !tokenFormat.test(token)) return res.status(404).json(badToken)
    const result = await dbTransaction(async tx => {
      // Row lock prevents racing redemption/revocation on PostgreSQL. SQLite's
      // BEGIN IMMEDIATE already excludes other writers.
      const invite = await tx.get<any>(`SELECT id, gc_user_id, gc_settings_id, expires_at, max_uses, uses, revoked_at FROM staged_gc_invitations WHERE token_hash = ?${isPostgres ? ' FOR UPDATE' : ''}`, [hash(token)])
      if (!invite || invite.revoked_at || invite.expires_at <= new Date().toISOString() || Number(invite.uses) >= Number(invite.max_uses)) return undefined
      if (!await validOwner(tx, invite.gc_user_id, invite.gc_settings_id)) return undefined
      // Recheck the account and owned profile within the same transaction.
      const current = await tx.get('SELECT u.id FROM users u JOIN subcontractors s ON s.id = u.subcontractor_id AND s.user_id = u.id WHERE u.id = ? AND u.role = ?', [sub.id, 'sub'])
      if (!current) return undefined
      const inserted = await tx.run(`INSERT INTO staged_gc_sub_relationships (gc_user_id, sub_user_id, created_at, source, source_id)
        VALUES (?, ?, ?, 'gc_invite', ?) ON CONFLICT (gc_user_id, sub_user_id) DO NOTHING`, [invite.gc_user_id, sub.id, new Date().toISOString(), invite.id])
      // PostgreSQL may have waited on a conflicting pair; do not commit a
      // relationship if the capability expired while that insert waited.
      if (invite.expires_at <= new Date().toISOString()) throw new InvitationUnavailable()
      if (inserted.changes) await tx.run('UPDATE staged_gc_invitations SET uses = uses + 1 WHERE id = ?', [invite.id])
      return { status: 'staged', created: inserted.changes === 1 }
    })
    if (!result) return res.status(404).json(badToken)
    res.json(result)
  } catch (error) {
    if (error instanceof InvitationUnavailable) return res.status(404).json(badToken)
    res.status(503).json({ error: 'Staged invitations unavailable' })
  }
})

stagedInvitationsRouter.get('/relationships', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    if (!await ownedProfile(gc.id)) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile is required' })
    const relationships = await dbAll('SELECT sub_user_id, created_at, source FROM staged_gc_sub_relationships WHERE gc_user_id = ? ORDER BY created_at DESC', [gc.id])
    res.json({ relationships })
  } catch { res.status(500).json({ error: 'Unable to list staged relationships' }) }
})

stagedInvitationsRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    if (!await ownedProfile(gc.id)) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile is required' })
    const invitations = await dbAll(`SELECT id, created_at, expires_at, max_uses, uses, revoked_at
      FROM staged_gc_invitations WHERE gc_user_id = ? ORDER BY created_at DESC`, [gc.id])
    res.json({ invitations })
  } catch { res.status(500).json({ error: 'Unable to list staged invitations' }) }
})

stagedInvitationsRouter.delete('/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await actor(req, 'gc')
    if (!gc) return res.status(403).json({ error: 'GC access required' })
    if (!await ownedProfile(gc.id)) return res.status(409).json({ error: 'An unambiguous owner-scoped GC profile is required' })
    const result = await dbRun('UPDATE staged_gc_invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND gc_user_id = ?', [new Date().toISOString(), req.params.id, gc.id])
    if (!result.changes) return res.status(404).json({ error: 'Invitation unavailable' })
    res.json({ revoked: true })
  } catch { res.status(500).json({ error: 'Unable to revoke staged invitation' }) }
})
