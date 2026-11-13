import express from 'express'
const Router = express.Router
import type { NextFunction, Response } from 'express'
import multer from 'multer'
import { createHash, randomBytes } from 'node:crypto'
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import { dbAll, dbGet, dbRun, isPostgres, lockConnectionUsers, withTransaction } from '../db/db.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { getFileViewUrl, storeFile } from '../services/storage.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'
import { sourceTag } from './coiFields.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

export const subPortalRouter = Router()

// Only literal true enables the rollout guard; no unrelated portal operations are paused.
const disconnectPaused = () => process.env.DISCONNECT_PAUSED?.trim().toLowerCase() === 'true'
const requireJoinSession = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.hasSessionJti) {
    res.set('Cache-Control', 'no-store')
    res.status(401).json({ error: 'Please sign out and sign in again to connect to this invitation.', code: 'JOIN_SESSION_REAUTH_REQUIRED' })
    return
  }
  next()
}

// The signed token establishes only the user id; the current role and profile
// ownership always come from the database, not mutable JWT claims.
function requireSub(req: AuthRequest, res: Response, next: NextFunction): void {
  void requireAuth(req, res, async () => {
    try {
      const user = await dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [req.user?.id])
      if (!user) { res.status(401).json({ error: 'Authentication required' }); return }
      if (user.role !== 'sub') { res.status(403).json({ error: 'Subcontractor account required' }); return }
      req.user = user
      next()
    } catch {
      res.status(500).json({ error: 'Unable to verify account' })
    }
  })
}

// Legacy records with only an email or a users.subcontractor_id pointer are
// deliberately not claimed: neither proves ownership of existing documents.
async function resolveSubProfile(identity: { id: string }) {
  const user = await dbGet('SELECT id, email, name, company_name, role FROM users WHERE id = ?', [identity.id])
  if (!user || user.role !== 'sub') throw new Error('Subcontractor account required')
  let sub = await dbGet('SELECT * FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1', [user.id])
  if (sub) return sub
  // Stable id and conflict handling prevent simultaneous first requests from
  // creating multiple profiles for the same previously unprofiled user.
  const subId = uuidv5(`sub-profile:${user.id}`, '9da886b2-9907-4ccd-84fb-8690dc5ac3bd')
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, email, created_at, updated_at)
     SELECT ?, ?, ?, 'Trade to be specified', ?, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM subcontractors WHERE user_id = ?)
     ON CONFLICT(id) DO NOTHING`,
    [subId, user.id, user.company_name || user.name || 'My Company', user.name, user.email.toLowerCase(), now, now, user.id]
  )
  sub = await dbGet('SELECT * FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1', [user.id])
  if (!sub) throw new Error('Unable to resolve subcontractor profile')
  await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ? AND role = ?', [sub.id, user.id, 'sub'])
  return sub
}

// A legacy ownerless or ambiguous invite cannot safely identify a GC.
async function findInviteGc(inviteCode: string) {
  // Older codes were short, predictable, or hard-coded. Require regeneration.
  if (!/^join-[0-9a-f]{36}$/.test(inviteCode)) return undefined
  const rows = await dbAll('SELECT * FROM gc_settings WHERE invite_code = ?', [inviteCode])
  if (rows.length !== 1 || !rows[0].user_id) return undefined
  const owner = await dbGet('SELECT id FROM users WHERE id = ? AND role = ?', [rows[0].user_id, 'gc'])
  return owner ? rows[0] : undefined
}

// Subcontractor dashboard: my profile, my COIs, requests, connected GCs
subPortalRouter.get('/my', requireSub, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const cois = await dbAll(
      `SELECT c.* FROM cois c WHERE c.subcontractor_id = ? AND (
        (c.owner_gc_user_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM gc_sub_connections g
          WHERE g.gc_user_id = c.owner_gc_user_id AND g.subcontractor_id = c.subcontractor_id
        )) OR
        (c.owner_gc_user_id IS NULL AND c.owner_sub_user_id = ?)
       ) ORDER BY c.created_at DESC`,
      [sub.id, req.user!.id]
    )
    for (const coi of cois) {
      coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
      for (const coverage of coi.coverages) delete coverage.notes
      // The stored URL may be a legacy simulation marker, so label it before
      // replacing the stored URL with a safe view URL.
      Object.assign(coi, labelSimulatedCarrierCOI(coi))
      coi.certificate_url = coi.certificate_key ? await getFileViewUrl(coi.certificate_key, coi.certificate_url) : null
      delete coi.certificate_key
      delete coi.reviewer_notes
      delete coi.review_date
    }
    const requests = await dbAll(
      `SELECT ur.*, NULL AS gc_company_name, NULL AS gc_phone
       FROM upload_requests ur
       WHERE ur.subcontractor_id = ?
       ORDER BY ur.created_at DESC LIMIT 10`,
      [sub.id]
    )
    const gcs = await dbAll(
      `SELECT u.id AS gc_id,
              COALESCE((SELECT company_name FROM gc_settings WHERE user_id = u.id ORDER BY id LIMIT 1), u.company_name, u.name) AS company_name,
              COALESCE((SELECT email FROM gc_settings WHERE user_id = u.id ORDER BY id LIMIT 1), u.email) AS email,
              COALESCE((SELECT phone FROM gc_settings WHERE user_id = u.id ORDER BY id LIMIT 1), u.phone) AS phone
       FROM gc_sub_connections c
       JOIN users u ON u.id = c.gc_user_id AND u.role = 'gc'
       WHERE c.subcontractor_id = ? ORDER BY company_name, u.id`,
      [sub.id]
    )
    res.set('Cache-Control', 'no-store')
    res.json({
      subcontractor: sub,
      cois: cois.map(labelSimulatedCarrierCOI),
      requests,
      connected_gcs: gcs,
      disconnect_available: !disconnectPaused(),
      // Keep the existing field shape, but never publish a raw profile id as a share link.
      public_share_url: '/api/sub/public/unavailable',
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Removing a link is scoped to the same owned profile shown by /my. Lock the
// issuer and profile under the same user lock used by QR redemption, so a concurrent
// redemption and deletion serialize. The existing QR retry path checks that a
// redeemed code's connection is still present and never inserts it again. An
// unused code is not tied to any GC, so removing a link cancels all unused
// codes for this profile. NOWAIT also fails closed against external token lockers.
subPortalRouter.delete('/connections/:gcId', requireSub, async (req: AuthRequest, res) => {
  res.set('Cache-Control', 'no-store')
  if (disconnectPaused()) return res.status(503).json({ error: 'Removing connections is temporarily unavailable. Please try again later.', code: 'CONNECTION_REMOVAL_UNAVAILABLE' })
  try {
    const removed = await withTransaction(async tx => {
      const lock = isPostgres ? ' FOR UPDATE' : ''
      const user = (await lockConnectionUsers(tx, [req.user!.id])).get(req.user!.id)
      if (!user || user.role !== 'sub') return false
      const sub = await tx.get<{ id: string }>(`SELECT id FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1${lock}`, [user.id])
      if (!sub) return false
      const connection = await tx.get(`SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?${lock}`, [req.params.gcId, sub.id])
      if (!connection) return false
      const result = await tx.run(`DELETE FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?
        AND EXISTS (SELECT 1 FROM subcontractors s WHERE s.id = gc_sub_connections.subcontractor_id AND s.user_id = ?)
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.role = 'sub')`, [req.params.gcId, sub.id, user.id, user.id])
      if (result.changes !== 1) return false
      await tx.run(`INSERT INTO sub_join_versions (user_id, version) VALUES (?, 1)
        ON CONFLICT(user_id) DO UPDATE SET version = sub_join_versions.version + 1`, [user.id])
      // PostgreSQL's SELECT locks every matching row even though tx.get returns
      // only the first one. If any external transaction holds a token row,
      // fail and let the caller retry rather than hold the user's lock waiting.
      await tx.get(`SELECT token_hash FROM sub_connection_qr_tokens
        WHERE issuer_user_id = ? AND subcontractor_id = ? AND redeemed_by_gc_user_id IS NULL AND revoked_at IS NULL
        ORDER BY token_hash${isPostgres ? ' FOR UPDATE NOWAIT' : ''}`, [user.id, sub.id])
      await tx.run(`UPDATE sub_connection_qr_tokens SET revoked_at = ?
        WHERE issuer_user_id = ? AND subcontractor_id = ? AND redeemed_by_gc_user_id IS NULL AND revoked_at IS NULL`, [new Date().toISOString(), user.id, sub.id])
      return true
    })
    if (!removed) return res.status(404).json({ error: 'Connection not found' })
    return res.json({ success: true })
  } catch (err: any) {
    if (err?.code === '55P03') return res.status(409).json({ error: 'A connection code is in use. Please try removing the connection again.' })
    return res.status(500).json({ error: 'Unable to remove connection' })
  }
})

// Quick upload of the insurance paper (one step)
subPortalRouter.post('/quick-upload', requireSub, upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A certificate file is required' })
    const validDate = (value: unknown): value is string => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const date = new Date(`${value}T00:00:00.000Z`)
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    }
    const eff = req.body?.effective_date || ''
    const exp = req.body?.expiration_date || ''
    if ((eff && !validDate(eff)) || (exp && !validDate(exp)) || (eff && exp && eff > exp)) {
      return res.status(400).json({ error: 'Provide valid coverage dates in YYYY-MM-DD format' })
    }
    const sub = await resolveSubProfile(req.user!)
    const stored = await storeFile(req.file)
    const coiId = uuidv4()
    const now = new Date().toISOString()
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coiId,
        sub.id,
        req.user!.id,
        req.body?.carrier || 'Not provided',
        req.body?.policy_number || null,
        eff,
        exp,
        'Uploaded by subcontractor; details are self-reported and not verified.',
        stored.url || null,
        stored.key || null,
        stored.filename,
        stored.size,
        stored.mime,
        now,
        now,
      ]
    )
    const coi = await dbGet('SELECT * FROM cois WHERE id = ?', [coiId])
    coi.coverages = []
    // Bind the tag to this upload's inserted key, not a later re-read which
    // could already contain a concurrent replacement's key.
    coi.fields_source_tag = sourceTag(coiId, stored.key || null)
    coi.certificate_url = coi.certificate_key ? await getFileViewUrl(coi.certificate_key, coi.certificate_url) : null
    delete coi.certificate_key
    delete coi.reviewer_notes
    delete coi.review_date
    res.set('Cache-Control', 'no-store')
    res.json(coi)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Disabled for every caller: no carrier integration exists and no policy is verified.
subPortalRouter.post('/carrier-connect', (_req, res) => {
  res.status(503).json({ error: 'Insurance carrier connections are unavailable. Please upload your certificate instead.' })
})

// Update sub profile details
subPortalRouter.post('/profile', requireSub, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const { company_name, trade, contact_person, email, phone, address, website } = req.body || {}
    await dbRun(
      `UPDATE subcontractors SET company_name = COALESCE(?, company_name), trade = COALESCE(?, trade),
        contact_person = COALESCE(?, contact_person), email = COALESCE(?, email), phone = COALESCE(?, phone),
        address = COALESCE(?, address), website = COALESCE(?, website), updated_at = ?
       WHERE id = ?`,
      [company_name || null, trade || null, contact_person || null, email ? email.toLowerCase() : null, phone || null, address || null, website || null, new Date().toISOString(), sub.id]
    )
    res.json(await dbGet('SELECT * FROM subcontractors WHERE id = ?', [sub.id]))
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Raw sub ids are not consent or a secure sharing capability.
subPortalRouter.get('/public/:subId', (_req, res) => {
  res.status(410).json({ error: 'Public subcontractor sharing is unavailable' })
})

// QR code onboarding: public info about the GC hosting the invite
subPortalRouter.get('/join-info/:inviteCode', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    const gc = await findInviteGc(req.params.inviteCode)
    if (!gc) return res.status(404).json({ error: 'Invite not found' })
    res.json({
      valid: true,
      invite_code: gc.invite_code,
      gc: {
        company_name: gc.company_name,
        email: gc.email,
        phone: gc.phone,
        logo_url: gc.logo_url,
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: 'Unable to load invitation' })
  }
})

// Intent is an opaque, short-lived snapshot of the current disconnect generation.
// It is issued BEFORE the checkbox can be selected, bound to one exact session,
// identity and invite, and consumed atomically with the connection. A logout or
// account switch cannot transfer the intent to another session.
const joinHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const joinLock = isPostgres ? ' FOR UPDATE' : ''
const intentError = 'This connection request is no longer valid. Review the sharing terms and consent again.'

subPortalRouter.post('/join-intent/:inviteCode', requireSub, requireJoinSession, async (req: AuthRequest, res) => {
  res.set('Cache-Control', 'no-store')
  try {
    const gc = await findInviteGc(req.params.inviteCode)
    if (!gc) return res.status(404).json({ error: 'Invite not found' })
    const token = randomBytes(32).toString('base64url')
    const result = await withTransaction(async tx => {
      const users = await lockConnectionUsers(tx, [req.user!.id, gc.user_id])
      const user = users.get(req.user!.id)
      if (user?.role !== 'sub' || users.get(gc.user_id)?.role !== 'gc') return false
      const settings = await tx.get(`SELECT id FROM gc_settings WHERE id = ? AND user_id = ? AND invite_code = ?${joinLock}`,
        [gc.id, gc.user_id, req.params.inviteCode])
      if (!settings) return false
      await tx.run('INSERT INTO sub_join_versions (user_id, version) VALUES (?, 0) ON CONFLICT(user_id) DO NOTHING', [user.id])
      const state = await tx.get<{ version: number }>('SELECT version FROM sub_join_versions WHERE user_id = ?', [user.id])
      const now = new Date().toISOString()
      await tx.run('DELETE FROM sub_join_intents WHERE user_id = ? AND expires_at <= ?', [user.id, now])
      await tx.run(`INSERT INTO sub_join_intents
        (token_hash, user_id, session_hash, gc_user_id, gc_settings_id, invite_code, version, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [joinHash(token), user.id, joinHash(req.headers.authorization!), gc.user_id,
        gc.id, req.params.inviteCode, state!.version, new Date(Date.now() + 10 * 60_000).toISOString()])
      return true
    })
    if (!result) return res.status(409).json({ error: intentError })
    return res.json({ intent: token })
  } catch {
    console.error('[auth] Invitation intent failed')
    return res.status(500).json({ error: 'Unable to prepare connection' })
  }
})

// Legacy email/password joins cannot safely establish when consent was given.
// Login/registration first is required; no account or connection is created here.
subPortalRouter.post('/join/:inviteCode', (req: AuthRequest, res, next) => {
  res.set('Cache-Control', 'no-store')
  if (!req.headers.authorization) return res.status(409).json({ error: 'Sign in or create an account first, then review and consent to connect.' })
  return requireSub(req, res, next)
}, requireJoinSession, async (req: AuthRequest, res) => {
  const { intent, consent } = req.body || {}
  if (consent !== true || typeof intent !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(intent) ||
      Object.keys(req.body || {}).some(key => key !== 'intent' && key !== 'consent')) {
    return res.status(400).json({ error: 'Explicit consent and a valid connection request are required' })
  }
  try {
    const result = await withTransaction(async tx => {
      // Discover the second user without taking a row lock, then revalidate
      // the complete intent after locking both users in the shared order.
      const discovered = await tx.get<any>('SELECT * FROM sub_join_intents WHERE token_hash = ?', [joinHash(intent)])
      if (!discovered || discovered.user_id !== req.user!.id || discovered.session_hash !== joinHash(req.headers.authorization!) ||
          discovered.invite_code !== req.params.inviteCode) return null
      const users = await lockConnectionUsers(tx, [req.user!.id, discovered.gc_user_id])
      const user = users.get(req.user!.id)
      if (user?.role !== 'sub' || users.get(discovered.gc_user_id)?.role !== 'gc') return null
      const ticket = await tx.get<any>(`SELECT * FROM sub_join_intents WHERE token_hash = ?${joinLock}`, [joinHash(intent)])
      const version = await tx.get<{ version: number }>('SELECT version FROM sub_join_versions WHERE user_id = ?', [user.id])
      if (!ticket || ticket.gc_user_id !== discovered.gc_user_id || ticket.user_id !== user.id || ticket.session_hash !== joinHash(req.headers.authorization!) ||
          ticket.invite_code !== req.params.inviteCode || ticket.expires_at <= new Date().toISOString() ||
          !version || Number(ticket.version) !== Number(version.version)) return null
      const gc = await tx.get<any>(`SELECT id, user_id, company_name FROM gc_settings WHERE id = ? AND user_id = ? AND invite_code = ?${joinLock}`,
        [ticket.gc_settings_id, ticket.gc_user_id, ticket.invite_code])
      const duplicates = await tx.get<{ count: number }>('SELECT COUNT(*) AS count FROM gc_settings WHERE invite_code = ?', [ticket.invite_code])
      if (!gc || Number(duplicates?.count) !== 1) return null
      let sub = await tx.get<any>(`SELECT * FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1${joinLock}`, [user.id])
      const now = new Date().toISOString()
      if (!sub) {
        const subId = uuidv5(`sub-profile:${user.id}`, '9da886b2-9907-4ccd-84fb-8690dc5ac3bd')
        await tx.run(`INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, email, created_at, updated_at)
          VALUES (?, ?, ?, 'Trade to be specified', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          [subId, user.id, user.company_name || user.name || 'My Company', user.name, user.email.toLowerCase(), now, now])
        sub = await tx.get<any>(`SELECT * FROM subcontractors WHERE user_id = ? ORDER BY created_at, id LIMIT 1${joinLock}`, [user.id])
        if (!sub) throw new Error('Profile unavailable')
        await tx.run('UPDATE users SET subcontractor_id = ? WHERE id = ? AND role = ?', [sub.id, user.id, 'sub'])
      }
      await tx.run(`INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at)
        VALUES (?, ?, ?) ON CONFLICT(gc_user_id, subcontractor_id) DO NOTHING`, [gc.user_id, sub.id, now])
      await tx.run('DELETE FROM sub_join_intents WHERE token_hash = ?', [joinHash(intent)])
      return { sub, company: gc.company_name }
    })
    if (!result) return res.status(409).json({ error: intentError })
    return res.json({ linked: true, mode: 'authenticated', subcontractor: result.sub, gc_company_name: result.company })
  } catch {
    console.error('[auth] Invitation join failed')
    return res.status(500).json({ error: 'Unable to join' })
  }
})

// The old action sent an ID-based public link and described unreviewed details
// as verified. Do not send it until an explicit, consent-based share exists.
subPortalRouter.post('/send-coi-email', requireSub, (_req, res) => {
  res.status(503).json({ error: 'COI email sharing is unavailable' })
})

// List emails this subcontractor has sent to contractors
subPortalRouter.get('/sent-emails', requireSub, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const rows = await dbAll(
      `SELECT e.id, e.to_email, e.subject, e.status, e.sent_at
       FROM email_logs e JOIN sub_email_logs l ON l.email_log_id = e.id
       WHERE l.subcontractor_id = ? ORDER BY e.sent_at DESC LIMIT 30`,
      [sub.id]
    )
    res.json({ emails: rows })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
