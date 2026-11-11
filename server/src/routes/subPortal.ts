import express from 'express'
const Router = express.Router
import multer from 'multer'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { requireAuth, signToken } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { storePrivateFile, deletePrivateFile, privateLocalPath, signedPrivateFileUrl } from '../services/storage.ts'
import { ensureDraftTable, startDraftOcr, refreshDraftOcr } from '../services/coiOcr.ts'
import { listCarriers } from '../services/carriers.ts'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'
import jwt from 'jsonwebtoken'
import type { NextFunction, Response } from 'express'
import { sendEmail, buildCOIShareEmail } from '../services/email.ts'
import { isSimulatedCarrierCOI, labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

export const subPortalRouter = Router()

// Resolve only a profile actually bound to the authenticated database user, never by email
// or by a stale JWT subcontractor_id. No cross-account implicit claiming.
async function resolveSubProfile(user: { id: string; email: string; name: string; subcontractor_id?: string | null }) {
  const actual = await dbGet('SELECT id, role, name, email, subcontractor_id FROM users WHERE id = ?', [user.id])
  if (!actual || actual.role !== 'sub') throw new Error('Subcontractor account required')
  const byUser = await dbGet('SELECT * FROM subcontractors WHERE user_id = ? LIMIT 1', [actual.id])
  if (byUser) return byUser
  if (actual.subcontractor_id) {
    const linked = await dbGet('SELECT * FROM subcontractors WHERE id = ? AND user_id IS NULL', [actual.subcontractor_id])
    if (linked) return linked
    throw new Error('Subcontractor profile ownership mismatch')
  }
  const subId = uuidv4()
  const now = new Date().toISOString()
  await dbRun(`INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, email, created_at, updated_at)
    VALUES (?, ?, ?, 'Trade to be specified', ?, ?, ?, ?)`, [subId, actual.id, actual.name, actual.name, actual.email.toLowerCase(), now, now])
  await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', [subId, actual.id])
  return dbGet('SELECT * FROM subcontractors WHERE id = ? AND user_id = ?', [subId, actual.id])
}
async function requireSub(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-in-production')) {
      return res.status(503).json({ error: 'Subcontractor access is not configured' })
    }
    const user = await dbGet('SELECT id, role FROM users WHERE id = ?', [req.user!.id])
    if (!user || user.role !== 'sub') return res.status(403).json({ error: 'Subcontractor access required' })
    next()
  } catch { res.status(503).json({ error: 'Unable to authorize request' }) }
}
function safeFilename(name: string): string {
  return name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || 'certificate'
}
async function validateCertificate(file: Express.Multer.File): Promise<string> {
  const b = file.buffer
  if (!b || !b.length) throw new Error('Invalid file')
  if (b.subarray(0, 5).toString('ascii') === '%PDF-') {
    const pdf = await PDFDocument.load(b, { throwOnInvalidObject: true, updateMetadata: false })
    if (pdf.isEncrypted || pdf.getPageCount() < 1 || pdf.getPageCount() > 500) throw new Error('Invalid PDF')
    return 'application/pdf'
  }
  const png = b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpeg = b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
  if (!png && !jpeg) throw new Error('Unsupported file')
  // Decode the actual image, not just the header. Restrict decompressed dimensions.
  const image = sharp(b, { failOn: 'error', limitInputPixels: 30000000 })
  const metadata = await image.metadata()
  if (metadata.format !== (png ? 'png' : 'jpeg') || !metadata.width || !metadata.height || (metadata.pages || 1) !== 1) throw new Error('Invalid image')
  await image.resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).raw().toBuffer()
  return png ? 'image/png' : 'image/jpeg'
}
async function draftResponse(row: any, withUrl = true) {
  let certificateUrl: string | null = null
  if (withUrl) {
    try {
      if (row.storage_backend === 's3') certificateUrl = await signedPrivateFileUrl(row.storage_key)
      else if (row.storage_backend === 'local' && process.env.NODE_ENV !== 'production') {
        const token = jwt.sign({ purpose: 'coi-draft-view', draft: row.id, owner: row.owner_user_id }, process.env.JWT_SECRET || 'dev-secret-change-in-production', { expiresIn: '5m' })
        certificateUrl = `/api/sub/quick-upload/${encodeURIComponent(row.id)}/document?token=${encodeURIComponent(token)}`
      }
    } catch { /* fail closed: no URL */ }
  }
  return { id: row.id, subcontractor_id: row.subcontractor_id, carrier: null, policy_number: null,
    effective_date: null, expiration_date: null, status: 'pending_review', coverages: [],
    certificate_url: certificateUrl, certificate_name: row.certificate_name, certificate_size: row.certificate_size,
    certificate_mime: row.certificate_mime, created_at: row.created_at, updated_at: row.updated_at,
    ocr_status: row.ocr_status }
}

// Subcontractor dashboard: my profile, my COIs, requests, connected GCs
subPortalRouter.get('/my', requireAuth, requireSub, async (req: AuthRequest, res) => {
  try {
    const sub = await resolveSubProfile(req.user!)
    const cois = await dbAll(
      `SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY created_at DESC`,
      [sub.id]
    )
    for (const coi of cois) {
      coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    }
    await ensureDraftTable()
    const drafts = await dbAll('SELECT * FROM sub_coi_drafts WHERE owner_user_id = ? AND subcontractor_id = ? ORDER BY created_at DESC', [req.user!.id, sub.id])
    cois.push(...await Promise.all(drafts.map(d => draftResponse(d))))
    cois.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
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
  } catch {
    res.status(500).json({ error: 'Unable to load subcontractor dashboard' })
  }
})

// One required document. Client-provided dates, coverages and policy details are never
// accepted as OCR or persisted here; a human must review the original document.
const singleCertificate = (req: AuthRequest, res: Response, next: NextFunction) => {
  upload.single('certificate')(req, res, (err: any) => {
    if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Invalid upload. Submit one PDF, JPEG or PNG under 25 MB.' })
    next()
  })
}
subPortalRouter.post('/quick-upload', requireAuth, requireSub, singleCertificate, async (req: AuthRequest, res) => {
  if (!req.file) return res.status(400).json({ error: 'A certificate file is required' })
  let mime: string
  try { mime = await validateCertificate(req.file) }
  catch { return res.status(400).json({ error: 'File must contain a valid, readable PDF, JPEG or PNG' }) }
  let stored: Awaited<ReturnType<typeof storePrivateFile>> | undefined
  try {
    const sub = await resolveSubProfile(req.user!)
    if (!sub) throw new Error('Missing profile')
    await ensureDraftTable()
    stored = await storePrivateFile(req.file, mime)
    const id = uuidv4(), now = new Date().toISOString()
    try {
      await dbRun(`INSERT INTO sub_coi_drafts (id, owner_user_id, subcontractor_id, storage_backend, storage_key, certificate_name, certificate_size, certificate_mime, status, ocr_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 'not_configured', ?, ?)`,
        [id, req.user!.id, sub.id, stored.backend, stored.key, safeFilename(req.file.originalname), req.file.size, mime, now, now])
    } catch (e) { try { await deletePrivateFile(stored) } catch {} throw e }
    const ocr = await startDraftOcr(id, stored.key, stored.backend)
    const row = await dbGet('SELECT * FROM sub_coi_drafts WHERE id = ? AND owner_user_id = ?', [id, req.user!.id])
    return res.status(201).json({ ...await draftResponse(row), ocr_status: ocr,
      message: 'Uploaded for human review. OCR, when available, is unverified and does not approve this certificate.' })
  } catch {
    return res.status(503).json({ error: 'Upload could not be completed. Check your dashboard before retrying.' })
  }
})

// GET performs one bounded poll; persisted Textract job IDs survive restarts. Nothing
// polls automatically: clients must call this endpoint until terminal status.
subPortalRouter.get('/quick-upload/:id/ocr', requireAuth, requireSub, async (req: AuthRequest, res) => {
  try {
    await ensureDraftTable()
    const row = await refreshDraftOcr(req.params.id, req.user!.id)
    if (!row) return res.status(404).json({ error: 'Certificate not found' })
    return res.json({ id: row.id, status: 'pending_review', ocr_status: row.ocr_status,
      ocr_draft: row.ocr_result ? JSON.parse(row.ocr_result) : null,
      message: 'OCR output is unverified and requires human review. Poll this endpoint to refresh processing jobs.' })
  } catch { return res.status(503).json({ error: 'OCR status is unavailable' }) }
})

// The local development link is itself a short-lived owner-scoped signed bearer
// capability. Production uses only short-lived S3 signed URLs, never local files.
subPortalRouter.get('/quick-upload/:id/document', async (req: AuthRequest, res) => {
  try {
    if (process.env.NODE_ENV === 'production' || typeof req.query.token !== 'string') return res.status(404).json({ error: 'Certificate not found' })
    const token = jwt.verify(req.query.token, process.env.JWT_SECRET || 'dev-secret-change-in-production', { algorithms: ['HS256'] }) as any
    if (token.purpose !== 'coi-draft-view' || token.draft !== req.params.id || typeof token.owner !== 'string') return res.status(404).json({ error: 'Certificate not found' })
    await ensureDraftTable()
    const row = await dbGet(`SELECT d.* FROM sub_coi_drafts d JOIN users u ON u.id = d.owner_user_id
      WHERE d.id = ? AND d.owner_user_id = ? AND d.storage_backend = 'local' AND u.role = 'sub'`, [req.params.id, token.owner])
    if (!row) return res.status(404).json({ error: 'Certificate not found' })
    res.set({ 'Content-Type': row.certificate_mime, 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' })
    return res.sendFile(privateLocalPath(row.storage_key), (err) => { if (err && !res.headersSent) res.status(404).end() })
  } catch { return res.status(404).json({ error: 'Certificate not found' }) }
})

subPortalRouter.get('/carriers', requireAuth, requireSub, (_req, res) => res.json({ carriers: listCarriers() }))
subPortalRouter.post('/carrier-connect', requireAuth, requireSub, (_req, res) => {
  // Do not read or log submitted credentials or invent carrier policy records.
  res.status(503).json({ error: 'Carrier connections are not configured. No policy has been verified.' })
})

// Update sub profile details
subPortalRouter.post('/profile', requireAuth, requireSub, async (req: AuthRequest, res) => {
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
      return requireAuth(req, res, async () => {
        if (req.user?.role !== 'sub') return res.status(403).json({ error: 'Subcontractor account required' })
        try {
          const sub = await resolveSubProfile(req.user)
          await linkSubToGc(sub, gc.email)
          return res.json({ linked: true, mode: 'authenticated', subcontractor: sub, gc_company_name: gc.company_name })
        } catch {
          return res.status(500).json({ error: 'Unable to connect to contractor' })
        }
      })
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
      await linkSubToGc(sub, gc.email)
      const payload = { id: existingUser.id, email: existingUser.email, role: existingUser.role, name: existingUser.name, subcontractor_id: existingUser.subcontractor_id || null }
      const token = signToken(payload)
      return res.json({ token, user: payload, linked: true, mode: 'existing', subcontractor: sub, gc_company_name: gc.company_name })
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
    const payload = { id: userId, email: email.toLowerCase(), role: 'sub', name, subcontractor_id: subId }
    const token = signToken(payload)
    return res.json({ token, user: { id: userId, email: email.toLowerCase(), name, role: 'sub', subcontractor_id: subId }, linked: true, mode: 'new', subcontractor: sub, gc_company_name: gc.company_name })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Email the sub's verified COI to any contractor (even one without an account)
subPortalRouter.post('/send-coi-email', requireAuth, requireSub, async (req: AuthRequest, res) => {
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
subPortalRouter.get('/sent-emails', requireAuth, requireSub, async (req: AuthRequest, res) => {
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
