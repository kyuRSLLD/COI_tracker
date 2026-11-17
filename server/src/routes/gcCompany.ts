import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import crypto from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { storeFile, getFileViewUrl } from '../services/storage.ts'
import { prepareUploadFile } from '../services/imageFormat.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/heic',
      'image/heif',
      'application/octet-stream',
    ]
    cb(null, allowed.includes(file.mimetype))
  },
})

const Router = express.Router
export const gcCompanyRouter = Router()
gcCompanyRouter.use(requireAuth)

// Role guard: GC and Pro GC only
gcCompanyRouter.use((req: AuthRequest, res, next) => {
  if (req.user?.role !== 'gc' && req.user?.role !== 'pro_gc') {
    return res.status(403).json({ error: 'Only general contractors can manage the company certificate' })
  }
  next()
})

async function getOrCreateCompanySub(gcUserId: string): Promise<any> {
  const existing = await dbGet(
    `SELECT s.* FROM subcontractors s
     JOIN gc_sub_connections g ON g.subcontractor_id = s.id
     WHERE g.gc_user_id = ? AND s.is_company = 1
     ORDER BY s.created_at ASC LIMIT 1`,
    [gcUserId],
  )
  if (existing) return existing
  const user = await dbGet<any>('SELECT name, company_name, phone, email FROM users WHERE id = ?', [gcUserId])
  const name = user?.company_name?.trim() || user?.name || 'Company Certificate'
  const id = uuidv4()
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO subcontractors (id, company_name, trade, phone, email, is_company, created_at, updated_at)
     VALUES (?, ?, 'General Contracting', ?, ?, 1, ?, ?)`,
    [id, name, user?.phone || null, user?.email || null, now, now],
  )
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [
    gcUserId,
    id,
    now,
  ])
  return dbGet('SELECT * FROM subcontractors WHERE id = ?', [id])
}

async function enrichCoi(coi: any) {
  if (!coi) return null
  coi.coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
  try {
    const r = await dbGet<any>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [coi.id])
    coi.review_details = r?.details_json ? JSON.parse(r.details_json) : null
  } catch {
    coi.review_details = null
  }
  coi.review_source_tag = (
    await dbGet<any>('SELECT source_tag FROM coi_field_reviews WHERE coi_id = ?', [coi.id])
  )?.source_tag || null
  try {
    coi.certificate_url = coi.certificate_key
      ? await getFileViewUrl(coi.certificate_key, coi.certificate_url)
      : coi.certificate_url || null
  } catch {
    /* non-fatal */
  }
  delete coi.certificate_key
  return labelSimulatedCarrierCOI(coi)
}

function parseAnyDate(s?: string | null): Date | null {
  if (!s || typeof s !== 'string') return null
  const t = s.trim()
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t)
  const iso = m ? `${m[3]}-${m[1]}-${m[2]}` : t
  const d = new Date(iso + 'T00:00:00Z')
  return isNaN(d.getTime()) ? null : d
}

// GET /api/gc/my-coi
gcCompanyRouter.get('/my-coi', async (req: AuthRequest, res) => {
  try {
    const sub = await getOrCreateCompanySub(req.user!.id)
    const coi = await dbGet<any>(
      `SELECT c.* FROM cois c
       WHERE c.owner_gc_user_id = ? AND c.subcontractor_id = ?
       ORDER BY c.created_at DESC LIMIT 1`,
      [req.user!.id, sub.id],
    )
    const share = await dbGet<any>(
      `SELECT * FROM company_share_links WHERE gc_user_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 1`,
      [req.user!.id, new Date().toISOString()],
    )
    const u = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [req.user!.id])
    res.set('Cache-Control', 'no-store')
    res.json({
      company_name: u?.company_name || u?.name || 'Your Company',
      company_subcontractor_id: sub.id,
      coi: await enrichCoi(coi),
      share: share
        ? { token: share.token, url: `/share/company/${share.token}`, expires_at: share.expires_at }
        : null,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/gc/my-coi/upload
gcCompanyRouter.post('/my-coi/upload', upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Certificate file required' })
    const sub = await getOrCreateCompanySub(req.user!.id)
    const file = await prepareUploadFile(req.file)
    const stored = await storeFile(file)
    const carrierVal = (typeof req.body?.carrier === 'string' && req.body.carrier.trim()) || 'Not provided'
    const policyVal = (typeof req.body?.policy_number === 'string' && req.body.policy_number.trim()) || null
    const effVal = typeof req.body?.effective_date === 'string' ? req.body.effective_date : ''
    const expVal = typeof req.body?.expiration_date === 'string' ? req.body.expiration_date : ''
    const id = uuidv4()
    const now = new Date().toISOString()
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, is_company_coi, carrier, policy_number,
         effective_date, expiration_date, status, certificate_url, certificate_key, certificate_name,
         certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?)`,
      [id, sub.id, req.user!.id, carrierVal, policyVal, effVal, expVal, stored?.url || null, stored?.key || null, stored?.filename || null,
       stored?.size ?? req.file.size, stored?.mime || req.file.mimetype, now, now],
    )
    // Run AI extraction in background
    if (file?.buffer && stored) {
      try {
        const { tryAnalyzeCoiDocument, isTextractConfigured } = await import('../services/textract.ts')
        const { saveExtractedReview } = await import('./coiFields.ts')
        const { normalizeImage, isTextractCompatible } = await import('../services/imageFormat.ts')
        if (isTextractConfigured()) {
          const norm = await normalizeImage(file.buffer, file.originalname)
          if (norm && isTextractCompatible(norm.mime)) {
            const r = await tryAnalyzeCoiDocument(norm.buffer)
            if (r) await saveExtractedReview(id, stored.key || null, r, { overwrite: false, uploaderGcUserId: req.user!.id })
          }
        }
      } catch (e: any) {
        console.warn('[gcCompany] extraction warning for', id, e?.message)
      }
    }
    const fresh = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [id])
    res.set('Cache-Control', 'no-store')
    res.status(201).json({ coi: await enrichCoi(fresh) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/gc/my-coi/validate (one-click mark own COI compliant)
gcCompanyRouter.post('/my-coi/validate', async (req: AuthRequest, res) => {
  try {
    const sub = await getOrCreateCompanySub(req.user!.id)
    const coi = await dbGet<any>(
      `SELECT c.* FROM cois c
       WHERE c.owner_gc_user_id = ? AND c.subcontractor_id = ?
       ORDER BY c.created_at DESC LIMIT 1`,
      [req.user!.id, sub.id],
    )
    if (!coi) return res.status(404).json({ error: 'No company COI on file' })
    const exp = parseAnyDate(coi.expiration_date)
    const eff = parseAnyDate(coi.effective_date)
    if (exp && exp.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Expired certificates cannot be validated' })
    }
    if (eff && exp && eff.getTime() > exp.getTime()) {
      return res.status(400).json({ error: 'Effective date must be on or before expiration date' })
    }
    const now = new Date().toISOString()
    await dbRun(
      `UPDATE cois SET status = 'compliant', reviewer_notes = NULL, review_date = ?, updated_at = ? WHERE id = ?`,
      [now, now, coi.id],
    )
    const fresh = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [coi.id])
    res.set('Cache-Control', 'no-store')
    res.json({ coi: await enrichCoi(fresh) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/gc/my-coi/share (create public share link)
gcCompanyRouter.post('/my-coi/share', async (req: AuthRequest, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.body?.expires_in_days) || 90))
    const token = crypto.randomBytes(32).toString('hex')
    const id = uuidv4()
    const now = new Date().toISOString()
    const exp = new Date(Date.now() + days * 86400000).toISOString()
    await dbRun(
      `INSERT INTO company_share_links (id, gc_user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      [id, req.user!.id, token, exp, now],
    )
    res.status(201).json({ token, url: `/share/company/${token}`, expires_at: exp })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Public company-share endpoint (no auth)
export const gcPublicRouter = Router()

gcPublicRouter.get('/company-share/:token', async (req, res) => {
  try {
    const share = await dbGet<any>('SELECT * FROM company_share_links WHERE token = ?', [req.params.token])
    if (!share) return res.status(404).json({ error: 'Share link not found' })
    if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This share link has expired' })
    }
    const u = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [share.gc_user_id])
    const sub = await dbGet<any>(
      `SELECT s.* FROM subcontractors s
       JOIN gc_sub_connections g ON g.subcontractor_id = s.id
       WHERE g.gc_user_id = ? AND s.is_company = 1
       ORDER BY s.created_at ASC LIMIT 1`,
      [share.gc_user_id],
    )
    if (!sub) return res.status(404).json({ error: 'Company record not found' })
    const coi = await dbGet<any>(
      `SELECT c.* FROM cois c
       WHERE c.owner_gc_user_id = ? AND c.subcontractor_id = ?
       ORDER BY c.created_at DESC LIMIT 1`,
      [share.gc_user_id, sub.id],
    )
    if (!coi) return res.status(404).json({ error: 'No certificate on file' })
    const enriched = await enrichCoi(coi)
    await dbRun(
      'UPDATE company_share_links SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?',
      [new Date().toISOString(), share.id],
    )
    res.set('Cache-Control', 'no-store')
    res.json({
      company: { company_name: u?.company_name || u?.name || 'Company Certificate' },
      coi: {
        carrier: enriched.carrier,
        am_best_rating: enriched.am_best_rating,
        policy_number: enriched.policy_number,
        effective_date: enriched.effective_date,
        expiration_date: enriched.expiration_date,
        status: enriched.status,
        coverages: enriched.coverages || [],
        certificate_name: enriched.certificate_name,
        created_at: enriched.created_at,
        days_left: (() => {
          const d = parseAnyDate(enriched.expiration_date)
          return d ? Math.round((d.getTime() - Date.now()) / 86400000) : null
        })(),
      },
      share: { expires_at: share.expires_at, created_at: share.created_at },
      generated_at: new Date().toISOString(),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
