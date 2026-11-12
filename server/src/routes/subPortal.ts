import express from 'express'
const Router = express.Router
import type { NextFunction, Response } from 'express'
import multer from 'multer'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { requireAuth, signToken } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { getFileViewUrl, storeFile } from '../services/storage.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

export const subPortalRouter = Router()

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
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })
}

function optionalJoinAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.headers.authorization) return requireSub(req, res, next)
  next()
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
      `SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY created_at DESC`,
      [sub.id]
    )
    for (const coi of cois) {
      coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
      coi.certificate_url = coi.certificate_key ? await getFileViewUrl(coi.certificate_key, coi.certificate_url) : null
      delete coi.certificate_key
    }
    const requests = await dbAll(
      `SELECT ur.*, NULL AS gc_company_name, NULL AS gc_phone
       FROM upload_requests ur
       WHERE ur.subcontractor_id = ?
       ORDER BY ur.created_at DESC LIMIT 10`,
      [sub.id]
    )
    const gcs = await dbAll(
      `SELECT DISTINCT COALESCE(gcs.company_name, u.company_name, u.name) AS company_name,
              COALESCE(gcs.email, u.email) AS email, COALESCE(gcs.phone, u.phone) AS phone
       FROM gc_sub_connections c
       JOIN users u ON u.id = c.gc_user_id AND u.role = 'gc'
       LEFT JOIN gc_settings gcs ON gcs.user_id = u.id
       WHERE c.subcontractor_id = ?`,
      [sub.id]
    )
    res.set('Cache-Control', 'no-store')
    res.json({
      subcontractor: sub,
      cois: cois.map(labelSimulatedCarrierCOI),
      requests,
      connected_gcs: gcs,
      // Keep the existing field shape, but never publish a raw profile id as a share link.
      public_share_url: '/api/sub/public/unavailable',
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
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
      `INSERT INTO cois (id, subcontractor_id, carrier, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coiId,
        sub.id,
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
    res.status(500).json({ error: err.message })
  }
})

// QR code onboarding join: handles both new sub sign-up AND existing account connect
subPortalRouter.post('/join/:inviteCode', optionalJoinAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await findInviteGc(req.params.inviteCode)
    if (!gc) return res.status(404).json({ error: 'Invite not found' })

    const now = new Date().toISOString()
    const linkSubToGc = async (sub: any) => {
      const inserted = await dbRun(
        `INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at)
         SELECT g.user_id, ?, ? FROM gc_settings g
         JOIN users u ON u.id = g.user_id AND u.role = 'gc'
         WHERE g.id = ? AND g.user_id = ? AND g.invite_code = ?
         ON CONFLICT(gc_user_id, subcontractor_id) DO NOTHING`,
        [sub.id, now, gc.id, gc.user_id, req.params.inviteCode]
      )
      if (!inserted.changes) {
        const current = await findInviteGc(req.params.inviteCode)
        const existing = await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc.user_id, sub.id])
        if (!current || current.id !== gc.id || !existing) throw new Error('Invite is no longer valid')
      }
    }

    // Branch A: the bearer token was checked by the same middleware as other routes.
    if (req.user) {
      const sub = await resolveSubProfile(req.user)
      await linkSubToGc(sub)
      return res.json({ linked: true, mode: 'authenticated', subcontractor: sub, gc_company_name: gc.company_name })
    }

    const { email, password, name, company_name, trade, contact_person, phone } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    // Branch B: existing account - "if they already have an account that link will just connect to GC"
    const existingUser = await dbGet('SELECT * FROM users WHERE LOWER(email) = ?', [email.toLowerCase()])
    if (existingUser) {
      const ok = await bcrypt.compare(password, existingUser.password_hash)
      if (!ok) return res.status(401).json({ error: 'Invalid credentials for existing account' })
      if (existingUser.role !== 'sub') return res.status(403).json({ error: 'Subcontractor account required' })
      const sub = await resolveSubProfile(existingUser)
      await linkSubToGc(sub)
      const user = { id: existingUser.id, email: existingUser.email, role: existingUser.role, name: existingUser.name, subcontractor_id: sub.id }
      const token = signToken(user)
      return res.json({ token, user, linked: true, mode: 'existing', subcontractor: sub, gc_company_name: gc.company_name })
    }

    // Branch C: new subcontractor sign-up - "Upon signing up, they will be linked"
    if (!name) return res.status(400).json({ error: 'Name is required for new accounts' })
    const hash = await bcrypt.hash(password, 10)
    const userId = uuidv4()
    const subId = uuidv4()
    await dbRun(
      `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, phone, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [subId, userId, company_name || name, trade || 'Trade to be specified', contact_person || name, phone || null, email.toLowerCase(), now, now]
    )
    await dbRun(
      `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at, subcontractor_id)
       VALUES (?, ?, ?, ?, ?, 'sub', ?, ?)`,
      [userId, email.toLowerCase(), hash, name, company_name || name, now, subId]
    )
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [subId])
    await linkSubToGc(sub)
    const user = { id: userId, email: email.toLowerCase(), role: 'sub', name, subcontractor_id: subId }
    const token = signToken(user)
    return res.json({ token, user, linked: true, mode: 'new', subcontractor: sub, gc_company_name: gc.company_name })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
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
