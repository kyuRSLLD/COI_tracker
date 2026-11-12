import express from 'express'; const Router = express.Router
import crypto from 'crypto'
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { storeFile } from '../services/storage.ts'
import { sendEmail } from '../services/email.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
})

export const uploadPortalRouter = Router()

// The legacy table has no owner column. New tokens carry an opaque random
// secret plus an explicit GC identity; the database row remains authoritative.
export function makeScopedUploadToken(gcId: string) {
  return `gc1.${Buffer.from(gcId, 'utf8').toString('base64url')}.${crypto.randomBytes(24).toString('hex')}`
}

export async function gcSettingsForUser(gc: any): Promise<any | null> {
  const settings = await dbAll('SELECT * FROM gc_settings WHERE user_id = ?', [gc.id])
  if (settings.length > 1) return null
  // Never use a global settings row whose owner is unknown or another GC.
  return settings[0] || { company_name: gc.company_name || 'General Contractor', email: gc.email }
}

async function resolveUploadContext(request: any) {
  if (typeof request.requested_by_email !== 'string' || !request.requested_by_email.trim()) return null
  const email = request.requested_by_email.trim().toLowerCase()
  let gc: any
  const scoped = /^gc1\.([A-Za-z0-9_-]+)\.([a-f0-9]{48})$/.exec(request.token)
  if (scoped) {
    const id = Buffer.from(scoped[1], 'base64url').toString('utf8')
    if (!id || Buffer.from(id, 'utf8').toString('base64url') !== scoped[1]) return null
    gc = await dbGet('SELECT id, email, company_name FROM users WHERE id = ? AND role = ?', [id, 'gc'])
    if (!gc || typeof gc.email !== 'string' || gc.email.trim().toLowerCase() !== email) return null
  } else {
    // The old creator accepted requested_by_email from the caller. Even a
    // unique email match cannot prove who created the request or that the
    // creator was connected to this sub; old links therefore need reissuing.
    return null
  }
  const connection = await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc.id, request.subcontractor_id])
  if (!connection) return null
  const settings = await gcSettingsForUser(gc)
  return settings ? { gc, settings } : null
}

async function validRequest(token: string) {
  const request = await dbGet('SELECT * FROM upload_requests WHERE token = ?', [token])
  if (!request) return { error: 'Invalid upload link', status: 404 } as const
  if (request.used !== 0 && request.used !== '0' && request.used != null && request.used !== false)
    return { error: 'This upload link has already been used. Please ask for a new link.', status: 410 } as const
  if (request.expires_at != null) {
    const expires = Date.parse(request.expires_at)
    if (!Number.isFinite(expires) || expires <= Date.now())
      return { error: 'This upload link has expired. Please ask for a new link.', status: 410 } as const
  }
  const context = await resolveUploadContext(request)
  if (!context) return { error: 'Invalid upload link', status: 404 } as const
  return { request, context } as const
}

uploadPortalRouter.get('/validate/:token', async (req, res) => {
  try {
    const checked = await validRequest(req.params.token)
    if ('error' in checked) return res.status(checked.status ?? 404).json({ error: checked.error })
    const { request, context } = checked
    const sub = await dbGet('SELECT id, company_name, trade, contact_person, phone, email, address FROM subcontractors WHERE id = ?', [request.subcontractor_id])
    if (!sub) return res.status(404).json({ error: 'Invalid upload link' })
    const gcSettings = context.settings
    res.set('Cache-Control', 'no-store')
    res.json({
      subcontractor: sub,
      gc: {
        company_name: gcSettings.company_name || 'General Contractor',
        license_number: gcSettings.license_number, address: gcSettings.address, phone: gcSettings.phone,
        email: gcSettings.email, additional_insured_wording: gcSettings.additional_insured_wording,
        required_gl_limit: gcSettings.required_gl_limit, required_auto_limit: gcSettings.required_auto_limit,
        required_wc_limit: gcSettings.required_wc_limit, required_umbrella_limit: gcSettings.required_umbrella_limit,
        expiration_warning_days: gcSettings.expiration_warning_days,
      },
      request: { token: request.token, requested_by_email: request.requested_by_email,
        message: request.message, used: Boolean(request.used), created_at: request.created_at },
    })
  } catch {
    res.status(500).json({ error: 'Unable to validate upload link' })
  }
})

uploadPortalRouter.post('/submit/:token', upload.single('certificate'), async (req, res) => {
  try {
    const checked = await validRequest(req.params.token)
    if ('error' in checked) return res.status(checked.status ?? 404).json({ error: checked.error })
    const { request, context } = checked
    const sub = await dbGet('SELECT id, company_name, email FROM subcontractors WHERE id = ?', [request.subcontractor_id])
    if (!sub) return res.status(404).json({ error: 'Invalid upload link' })
    const { carrier, am_best_rating, policy_number, effective_date, expiration_date,
      email, coverages: coveragesRaw } = req.body || {}
    if (!carrier || !effective_date || !expiration_date)
      return res.status(400).json({ error: 'Carrier, effective date, and expiration date are required' })
    let coverages: any[] = []
    if (coveragesRaw) {
      try { coverages = typeof coveragesRaw === 'string' ? JSON.parse(coveragesRaw) : coveragesRaw }
      catch { return res.status(400).json({ error: 'Invalid coverages' }) }
      if (!Array.isArray(coverages) || coverages.some((cv) => !cv || typeof cv !== 'object'))
        return res.status(400).json({ error: 'Invalid coverages' })
    }

    // Claim once before side effects. The connection and expiry are rechecked
    // in the atomic update, so concurrent submits cannot both succeed.
    const now = new Date().toISOString()
    const claim = await dbRun(
      `UPDATE upload_requests SET used = 1, used_at = ? WHERE id = ? AND (used = 0 OR used IS NULL)
       AND (expires_at IS NULL OR expires_at > ?)
       AND EXISTS (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = upload_requests.subcontractor_id)`,
      [now, request.id, now, context.gc.id]
    )
    if (claim.changes !== 1) return res.status(410).json({ error: 'This upload link is no longer available. Please ask for a new link.' })

    // A GC-issued bearer link permits COI submission, not profile changes.
    // The submitted email is used only as a confirmation destination below.
    const stored = req.file ? await storeFile(req.file) : null
    const coiId = uuidv4()
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?)`,
      [coiId, sub.id, context.gc.id, carrier, am_best_rating || null, policy_number || null, effective_date, expiration_date,
        stored ? stored.url : null, stored ? stored.key : null, stored ? stored.filename : null,
        stored ? stored.size : null, stored ? stored.mime : null, now, now]
    )
    for (const cv of coverages) {
      await dbRun(
        `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), coiId, cv.type || 'General Liability', cv.per_occurrence_limit || null,
          cv.aggregate_limit || null, cv.additional_insured ? 1 : 0, cv.waiver_of_subrogation ? 1 : 0, cv.notes || null]
      )
    }
    let confirmation: { id: string; status: string } | null = null
    const gcCompany = context.settings.company_name || 'General Contractor'
    const targetEmail = email || sub.email
    if (targetEmail) {
      // Confirmation is best-effort; submission succeeded even if logging fails.
      try {
        confirmation = await sendEmail({ to: targetEmail, subject: `COI received — thank you (${gcCompany})`,
          body: `Hello ${sub.company_name},\n\nWe have received your Certificate of Insurance submission (Carrier: ${carrier}, Policy #${policy_number || 'n/a'}).\nOur team is reviewing it now and will follow up if anything is missing.\n\nExpiration on file: ${expiration_date}\n\nThank you,\n${gcCompany}`,
          type: 'general' })
      } catch { /* Do not treat a logging failure as a failed upload. */ }
    }
    // The upload link is a public bearer capability, not a certificate download
    // grant. Never return a storage key, URL, or internal reviewer fields here.
    const created = await dbGet(`SELECT id, subcontractor_id, carrier, am_best_rating, policy_number,
      effective_date, expiration_date, status, certificate_name, certificate_size, certificate_mime,
      created_at, updated_at FROM cois WHERE id = ?`, [coiId])
    res.set('Cache-Control', 'no-store')
    res.json({ success: true, coi: created, email: confirmation,
      email_delivered: confirmation?.status === 'sent' })
  } catch {
    res.status(500).json({ error: 'Unable to submit certificate. Please ask for a new link.' })
  }
})

uploadPortalRouter.get('/my/:token', async (req, res) => {
  try {
    const checked = await validRequest(req.params.token)
    if ('error' in checked) return res.status(checked.status ?? 404).json({ error: checked.error })
    // A bearer link may expose only this GC's submissions and COIs owned by
    // the actual sub account on this profile, never another GC or legacy rows.
    // GC ownership takes precedence if malformed data has both owners set.
    const cois = await dbAll(
      `SELECT c.id, c.subcontractor_id, c.carrier, c.am_best_rating, c.policy_number,
        c.effective_date, c.expiration_date, c.status, c.created_at, c.updated_at,
        CASE WHEN c.certificate_url = 'carrier-connect://verified'
          OR c.reviewer_notes = 'Instant verification via simulated carrier connect'
          THEN 1 ELSE 0 END AS simulation_marker
       FROM cois c WHERE c.subcontractor_id = ? AND (
        c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND EXISTS (
          SELECT 1 FROM subcontractors s JOIN users u ON u.id = s.user_id AND u.role = 'sub'
          WHERE s.id = c.subcontractor_id AND s.user_id = c.owner_sub_user_id
        ))
       ) ORDER BY c.expiration_date DESC`,
      [checked.request.subcontractor_id, checked.context.gc.id]
    )
    const enriched = await Promise.all(cois.map(async (c) => {
      const { simulation_marker, ...publicFields } = c
      return {
        ...labelSimulatedCarrierCOI(simulation_marker ? { ...publicFields, simulated_carrier_connect: true } : publicFields),
        coverages: await dbAll('SELECT id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation FROM coi_coverages WHERE coi_id = ?', [c.id]),
      }
    }))
    res.set('Cache-Control', 'no-store')
    res.json({ cois: enriched })
  } catch {
    res.status(500).json({ error: 'Unable to load submissions' })
  }
})
