import express from 'express'
const Router = express.Router
import multer from 'multer'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { requireAuth, signToken } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { storeFile } from '../services/storage.ts'
import { sendEmail, buildCOIShareEmail } from '../services/email.ts'
import { isSimulatedCarrierCOI, labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

export const subPortalRouter = Router()

// Helper: resolve subcontractor profile for the current user (auto-create if missing)
async function resolveSubProfile(user: { id: string; email: string; name: string; subcontractor_id?: string | null }) {
  if (user.subcontractor_id) {
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [user.subcontractor_id])
    if (sub) return sub
  }
  const byUser = await dbGet('SELECT * FROM subcontractors WHERE user_id = ? LIMIT 1', [user.id])
  if (byUser) return byUser
  const byEmail = await dbGet('SELECT * FROM subcontractors WHERE LOWER(email) = ? LIMIT 1', [user.email.toLowerCase()])
  if (byEmail) return byEmail
  // auto-create a minimal profile
  const subId = uuidv4()
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, email, created_at, updated_at)
     VALUES (?, ?, ?, 'Trade to be specified', ?, ?, ?, ?)`,
    [subId, user.id, user.name || 'My Company', user.name, user.email.toLowerCase(), now, now]
  )
  await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', [subId, user.id])
  return dbGet('SELECT * FROM subcontractors WHERE id = ?', [subId])
}

// Subcontractor dashboard: my profile, my COIs, requests, connected GCs
subPortalRouter.get('/my', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const cois = await dbAll(
      `SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY created_at DESC`,
      [sub.id]
    )
    for (const coi of cois) {
      coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    }
    const requests = await dbAll(
      `SELECT ur.*, gcs.company_name AS gc_company_name, gcs.phone AS gc_phone
       FROM upload_requests ur
       LEFT JOIN gc_settings gcs ON LOWER(gcs.email) = LOWER(ur.requested_by_email)
       WHERE ur.subcontractor_id = ?
       ORDER BY ur.created_at DESC LIMIT 10`,
      [sub.id]
    )
    const gcs = await dbAll(
      `SELECT DISTINCT gcs.company_name, gcs.email, gcs.phone
       FROM upload_requests ur
       LEFT JOIN gc_settings gcs ON LOWER(gcs.email) = LOWER(ur.requested_by_email)
       WHERE ur.subcontractor_id = ? AND gcs.company_name IS NOT NULL`,
      [sub.id]
    )
    res.json({
      subcontractor: sub,
      cois: cois.map(labelSimulatedCarrierCOI),
      requests,
      connected_gcs: gcs,
      public_share_url: `/sub/share/${sub.id}`,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Quick upload of the insurance paper (one step)
subPortalRouter.post('/quick-upload', requireAuth, upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }
    const coiId = uuidv4()
    const now = new Date().toISOString()
    const eff = req.body?.effective_date || now.slice(0, 10)
    const exp = req.body?.expiration_date || new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, carrier, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        coiId,
        sub.id,
        req.body?.carrier || 'Carrier verification pending',
        req.body?.policy_number || 'Pending broker confirmation',
        eff,
        exp,
        'Uploaded via subcontractor quick-upload portal',
        stored?.url || null,
        stored?.key || null,
        req.file?.originalname || null,
        req.file?.size || null,
        req.file?.mimetype || null,
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
subPortalRouter.post('/profile', requireAuth, async (req: AuthRequest, res) => {
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

// Public share page for a subcontractor's verified COI (for sending to any GC)
subPortalRouter.get('/public/:subId', async (req, res) => {
  try {
    const sub = await dbGet(
      'SELECT id, company_name, trade, created_at FROM subcontractors WHERE id = ?',
      [req.params.subId]
    )
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    const coi = await dbGet(
      `SELECT id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, created_at, certificate_url, reviewer_notes
       FROM cois WHERE subcontractor_id = ? ORDER BY created_at DESC LIMIT 1`,
      [sub.id]
    )
    if (coi) {
      coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    }
    if (coi && isSimulatedCarrierCOI(coi)) {
      coi.status = 'pending_review'
      coi.simulated_carrier_connect = true
      coi.coverages = []
    }
    // These fields are only used to identify the former simulation.
    if (coi) { delete coi.certificate_url; delete coi.reviewer_notes }
    res.json({ subcontractor: sub, coi })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// QR code onboarding: public info about the GC hosting the invite
subPortalRouter.get('/join-info/:inviteCode', async (req, res) => {
  try {
    const gc = await dbGet('SELECT * FROM gc_settings WHERE invite_code = ?', [req.params.inviteCode])
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
subPortalRouter.post('/join/:inviteCode', async (req: AuthRequest, res) => {
  try {
    const gc = await dbGet('SELECT * FROM gc_settings WHERE invite_code = ?', [req.params.inviteCode])
    if (!gc) return res.status(404).json({ error: 'Invite not found' })

    const now = new Date().toISOString()
    const linkSubToGc = async (sub: any, gcEmail: string | null) => {
      const existing = await dbGet(
        'SELECT id FROM upload_requests WHERE subcontractor_id = ? AND requested_by_email = ?',
        [sub.id, gcEmail || null]
      )
      if (!existing) {
        await dbRun(
          `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, created_at)
           VALUES (?, ?, ?, ?, 'Joined via QR code invitation', ?, ?)`,
          [uuidv4(), sub.id, 'joinreq-' + uuidv4().slice(0, 8), gcEmail || null, new Date(Date.now() + 60 * 86400000).toISOString(), now]
        )
      }
    }

    // Branch A: already authenticated user (Bearer token)
    const header = req.headers.authorization
    if (header && header.startsWith('Bearer ')) {
      const tokenStr = header.slice(7)
      try {
        const payload = (await import('jsonwebtoken')).default.verify(tokenStr, process.env.JWT_SECRET || 'dev-secret-change-in-production') as any
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [payload.id])
        if (!user) return res.status(404).json({ error: 'User not found' })
        const sub = await resolveSubProfile(user)
        await linkSubToGc(sub, gc.email)
        return res.json({ linked: true, mode: 'authenticated', subcontractor: sub, gc_company_name: gc.company_name })
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' })
      }
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
      const sub = await resolveSubProfile(existingUser)
      await linkSubToGc(sub, gc.email)
      const token = signToken({ id: existingUser.id, email: existingUser.email, role: existingUser.role, name: existingUser.name, subcontractor_id: existingUser.subcontractor_id || null })
      return res.json({ token, user: existingUser, linked: true, mode: 'existing', subcontractor: sub, gc_company_name: gc.company_name })
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
    await linkSubToGc(sub, gc.email)
    const token = signToken({ id: userId, email: email.toLowerCase(), role: 'sub', name, subcontractor_id: subId })
    return res.json({ token, user: { id: userId, email: email.toLowerCase(), name, role: 'sub', subcontractor_id: subId }, linked: true, mode: 'new', subcontractor: sub, gc_company_name: gc.company_name })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Email the sub's verified COI to any contractor (even one without an account)
subPortalRouter.post('/send-coi-email', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { to_email, gc_company_name, message, coi_id } = req.body || {}
    if (!to_email || !to_email.includes('@')) {
      return res.status(400).json({ error: 'A valid contractor email address is required' })
    }
    const sub = await resolveSubProfile(req.user!)
    let coi = null
    if (coi_id) {
      coi = await dbGet('SELECT * FROM cois WHERE id = ? AND subcontractor_id = ?', [coi_id, sub.id])
    }
    if (!coi) {
      coi = await dbGet('SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY created_at DESC LIMIT 1', [sub.id])
    }
    if (!coi) {
      return res.status(400).json({ error: 'You don\'t have any insurance certificates on file yet. Upload one first.' })
    }
    if (isSimulatedCarrierCOI(coi)) {
      return res.status(409).json({ error: 'This record was created by a simulation and is not verified. Upload a real certificate before sharing.' })
    }
    const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    const baseUrl = (process.env.CLIENT_URL || 'https://safecoi.com').replace(/\/$/, '')
    const verifyUrl = `${baseUrl}/sub/share/${sub.id}`
    const signUpUrl = `${baseUrl}/login?role=gc&email=${encodeURIComponent(to_email)}&ref=${encodeURIComponent(sub.company_name)}`
    const { subject, body } = buildCOIShareEmail({
      subName: sub.company_name,
      trade: sub.trade,
      carrier: coi.carrier || 'Carrier on file',
      policyNumber: coi.policy_number,
      expirationDate: coi.expiration_date,
      coverages,
      verifyUrl,
      signUpUrl,
      gcCompany: gc_company_name || null,
      personalMessage: message ? String(message).slice(0, 1000) : null,
    })
    const { id: logId } = await sendEmail({ to: to_email.toLowerCase().trim(), subject, body, type: 'general' })
    // If a GC with that email already exists, link them now
    const existingGc = await dbGet('SELECT * FROM users WHERE LOWER(email) = ? AND role = ?', [to_email.toLowerCase().trim(), 'gc'])
    if (existingGc && existingGc.email) {
      const already = await dbGet(
        'SELECT id FROM upload_requests WHERE subcontractor_id = ? AND LOWER(requested_by_email) = ?',
        [sub.id, existingGc.email.toLowerCase()]
      )
      if (!already) {
        await dbRun(
          `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, created_at)
           VALUES (?, ?, ?, ?, 'COI shared via email', ?, ?)`,
          [uuidv4(), sub.id, 'share-' + uuidv4().slice(0, 8), existingGc.email.toLowerCase(), new Date(Date.now() + 60 * 86400000).toISOString(), new Date().toISOString()]
        )
      }
    }
    console.log(`[sub] COI emailed to contractor ${to_email} for sub ${sub.company_name}`)
    res.json({ ok: true, email_log_id: logId, sent_to: to_email.toLowerCase().trim(), subject, verify_url: verifyUrl })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// List emails this subcontractor has sent to contractors
subPortalRouter.get('/sent-emails', requireAuth, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const pattern = `Certificate of Insurance from ${sub.company_name}%`
    const rows = await dbAll(
      `SELECT id, to_email, subject, status, sent_at FROM email_logs
       WHERE subject LIKE ? ORDER BY sent_at DESC LIMIT 30`,
      [pattern]
    )
    res.json({ emails: rows })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
