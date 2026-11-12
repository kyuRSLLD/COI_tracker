import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { isPostgres, lockConnectionUsers, withTransaction } from '../db/db.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'

export const subConnectionQrRouter = express.Router()
const lock = isPostgres ? ' FOR UPDATE' : ''
const lifetimeMs = 15 * 60 * 1000
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')
const validToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)

type QrRow = {
  issuer_user_id: string; subcontractor_id: string; expires_at: string
  redeemed_by_gc_user_id: string | null; revoked_at: string | null
}

subConnectionQrRouter.use(requireAuth)

// Creation is the subcontractor's explicit consent to share ALL current and
// future sub-owned COIs with one GC. The caller cannot nominate another profile.
subConnectionQrRouter.post('/', async (req: AuthRequest, res) => {
  if (req.user!.role !== 'sub') return res.status(403).json({ error: 'Subcontractor account required' })
  if (!req.body || req.body.consent !== true || Object.keys(req.body).some(k => k !== 'consent')) {
    return res.status(400).json({ error: 'Explicit consent is required' })
  }
  try {
    const result = await withTransaction(async tx => {
      const users = await lockConnectionUsers(tx, [req.user!.id])
      if (users.get(req.user!.id)?.role !== 'sub') return { status: 403 as const }
      // Match the portal's deterministic profile choice, but do not create or
      // claim legacy records based on an email or users.subcontractor_id.
      const sub = await tx.get<{ id: string }>(`SELECT id FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1${lock}`, [req.user!.id])
      if (!sub) return { status: 404 as const }
      const token = randomBytes(32).toString('base64url')
      const created = Date.now()
      const expiresAt = new Date(created + lifetimeMs).toISOString()
      await tx.run(`INSERT INTO sub_connection_qr_tokens
        (token_hash, issuer_user_id, subcontractor_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [hashToken(token), req.user!.id, sub.id, new Date(created).toISOString(), expiresAt])
      return { status: 200 as const, token, expiresAt }
    })
    if (result.status === 403) return res.status(403).json({ error: 'Subcontractor account required' })
    if (result.status === 404) return res.status(404).json({ error: 'Owned subcontractor profile required' })
    return res.json({ token: result.token, expiresAt: result.expiresAt })
  } catch {
    return res.status(500).json({ error: 'Unable to create connection code' })
  }
})

subConnectionQrRouter.post('/redeem', async (req: AuthRequest, res) => {
  if (req.user!.role !== 'gc') return res.status(403).json({ error: 'GC account required' })
  if (!validToken(req.body?.token)) return res.status(400).json({ error: 'Invalid connection code' })
  try {
    const result = await withTransaction(async tx => {
      const tokenHash = hashToken(req.body.token)
      // Discovery does not confer authority. Re-read the locked row after the
      // user locks, and reject a changed issuer rather than lock another user.
      const discovered = await tx.get<{ issuer_user_id: string }>('SELECT issuer_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [tokenHash])
      if (!discovered) return { status: 404 as const }
      const users = await lockConnectionUsers(tx, [discovered.issuer_user_id, req.user!.id])
      if (users.get(req.user!.id)?.role !== 'gc') return { status: 403 as const }
      if (users.get(discovered.issuer_user_id)?.role !== 'sub') return { status: 404 as const }
      const qr = await tx.get<QrRow>(`SELECT issuer_user_id, subcontractor_id, expires_at, redeemed_by_gc_user_id, revoked_at
        FROM sub_connection_qr_tokens WHERE token_hash = ?${lock}`, [tokenHash])
      if (!qr || qr.issuer_user_id !== discovered.issuer_user_id) return { status: 404 as const }
      const sub = await tx.get<{ id: string; company_name: string }>(
        `SELECT id, company_name FROM subcontractors WHERE id = ? AND user_id = ?${lock}`,
        [qr.subcontractor_id, qr.issuer_user_id])
      if (!sub || qr.revoked_at) return { status: 404 as const }
      if (qr.redeemed_by_gc_user_id) {
        // A retry succeeds only for the original recipient and only while its
        // original link still exists; replay never recreates a removed link.
        if (qr.redeemed_by_gc_user_id !== req.user!.id) return { status: 404 as const }
        const existing = await tx.get('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [req.user!.id, sub.id])
        return existing ? { status: 200 as const, sub } : { status: 404 as const }
      }
      const now = new Date().toISOString()
      if (qr.expires_at <= now) return { status: 404 as const }
      // Conflict is safe only for this exact GC/sub pair. Both writes commit or
      // roll back together; no other GC can consume this locked token.
      await tx.run(`INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at)
        VALUES (?, ?, ?) ON CONFLICT(gc_user_id, subcontractor_id) DO NOTHING`, [req.user!.id, sub.id, now])
      await tx.run(`UPDATE sub_connection_qr_tokens SET redeemed_by_gc_user_id = ?, redeemed_at = ? WHERE token_hash = ?`, [req.user!.id, now, tokenHash])
      return { status: 200 as const, sub }
    })
    if (result.status === 403) return res.status(403).json({ error: 'GC account required' })
    if (result.status === 404) return res.status(404).json({ error: 'Connection code unavailable' })
    return res.json({ success: true, subcontractor: result.sub })
  } catch {
    return res.status(500).json({ error: 'Unable to redeem connection code' })
  }
})

subConnectionQrRouter.post('/revoke', async (req: AuthRequest, res) => {
  if (req.user!.role !== 'sub') return res.status(403).json({ error: 'Subcontractor account required' })
  if (!validToken(req.body?.token)) return res.status(400).json({ error: 'Invalid connection code' })
  try {
    const result = await withTransaction(async tx => {
      const tokenHash = hashToken(req.body.token)
      const users = await lockConnectionUsers(tx, [req.user!.id])
      if (users.get(req.user!.id)?.role !== 'sub') return 403
      const qr = await tx.get<QrRow>(`SELECT issuer_user_id, subcontractor_id, expires_at, redeemed_by_gc_user_id, revoked_at
        FROM sub_connection_qr_tokens WHERE token_hash = ?${lock}`, [tokenHash])
      if (!qr || qr.issuer_user_id !== req.user!.id) return 404
      if (qr.redeemed_by_gc_user_id) return 404
      if (!qr.revoked_at) await tx.run('UPDATE sub_connection_qr_tokens SET revoked_at = ? WHERE token_hash = ?', [new Date().toISOString(), tokenHash])
      return 200
    })
    if (result === 403) return res.status(403).json({ error: 'Subcontractor account required' })
    if (result === 404) return res.status(404).json({ error: 'Connection code unavailable' })
    return res.json({ success: true })
  } catch {
    return res.status(500).json({ error: 'Unable to revoke connection code' })
  }
})
