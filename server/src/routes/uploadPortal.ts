import express from 'express'; const Router = express.Router
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

/**
 * PUBLIC — validate a magic upload link
 */
uploadPortalRouter.get('/validate/:token', async (req, res) => {
  try {
    const request = await dbGet('SELECT * FROM upload_requests WHERE token = ?', [req.params.token])
    if (!request) return res.status(404).json({ error: 'This upload link is invalid' })

    if (request.expires_at && new Date(request.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This upload link has expired. Please ask for a new link.' })
    }

    const sub = await dbGet('SELECT id, company_name, trade, contact_person, phone, email, address FROM subcontractors WHERE id = ?', [
      request.subcontractor_id,
    ])
    if (!sub) return res.status(404).json({ error: 'Subcontractor record not found' })

    const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}

    res.json({
      subcontractor: sub,
      gc: {
        company_name: gcSettings.company_name || 'General Contractor',
        license_number: gcSettings.license_number,
        address: gcSettings.address,
        phone: gcSettings.phone,
        email: gcSettings.email,
        additional_insured_wording: gcSettings.additional_insured_wording,
        required_gl_limit: gcSettings.required_gl_limit,
        required_auto_limit: gcSettings.required_auto_limit,
        required_wc_limit: gcSettings.required_wc_limit,
        required_umbrella_limit: gcSettings.required_umbrella_limit,
        expiration_warning_days: gcSettings.expiration_warning_days,
      },
      request: {
        token: request.token,
        requested_by_email: request.requested_by_email,
        message: request.message,
        used: Boolean(request.used),
        created_at: request.created_at,
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * PUBLIC — submit COI wizard (self-service by subcontractor)
 */
uploadPortalRouter.post('/submit/:token', upload.single('certificate'), async (req, res) => {
  try {
    const request = await dbGet('SELECT * FROM upload_requests WHERE token = ?', [req.params.token])
    if (!request) return res.status(404).json({ error: 'Invalid upload link' })

    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [request.subcontractor_id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })

    const {
      carrier,
      am_best_rating,
      policy_number,
      effective_date,
      expiration_date,
      contact_person,
      phone,
      email,
      address,
      coverages: coveragesRaw,
    } = req.body || {}

    if (!carrier || !effective_date || !expiration_date) {
      return res.status(400).json({ error: 'Carrier, effective date, and expiration date are required' })
    }

    // optionally update sub contact info if provided
    const now = new Date().toISOString()
    await dbRun(
      `UPDATE subcontractors
       SET contact_person = COALESCE(?, contact_person),
           phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           address = COALESCE(?, address),
           status = 'pending_review',
           updated_at = ?
       WHERE id = ?`,
      [contact_person || null, phone || null, email || null, address || null, now, sub.id]
    )

    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }

    const coiId = uuidv4()
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?)`,
      [
        coiId,
        sub.id,
        carrier,
        am_best_rating || null,
        policy_number || null,
        effective_date,
        expiration_date,
        stored ? stored.url : null,
        stored ? stored.key : null,
        stored ? stored.filename : null,
        stored ? stored.size : null,
        stored ? stored.mime : null,
        now,
        now,
      ]
    )

    let coverages: any[] = []
    if (coveragesRaw) {
      try {
        coverages = typeof coveragesRaw === 'string' ? JSON.parse(coveragesRaw) : coveragesRaw
      } catch {}
    }
    for (const cv of coverages) {
      await dbRun(
        `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          coiId,
          cv.type || 'General Liability',
          cv.per_occurrence_limit || null,
          cv.aggregate_limit || null,
          cv.additional_insured ? 1 : 0,
          cv.waiver_of_subrogation ? 1 : 0,
          cv.notes || null,
        ]
      )
    }

    await dbRun(
      'UPDATE upload_requests SET used = 1, used_at = ? WHERE token = ?',
      [now, req.params.token]
    )

    // email confirmation (simulated)
    const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}
    const gcCompany = gcSettings.company_name || 'General Contractor'
    const targetEmail = email || sub.email
    if (targetEmail) {
      await sendEmail({
        to: targetEmail,
        subject: `COI received — thank you (${gcCompany})`,
        body: `Hello ${sub.company_name},

We have received your Certificate of Insurance submission (Carrier: ${carrier}, Policy #${policy_number || 'n/a'}).
Our team is reviewing it now and will follow up if anything is missing.

Expiration on file: ${expiration_date}

Thank you,
${gcCompany}`,
        type: 'general',
      })
    }

    const created = await dbGet('SELECT * FROM cois WHERE id = ?', [coiId])
    res.json({ success: true, coi: created })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * PUBLIC — subcontractor can view their past submissions
 */
uploadPortalRouter.get('/my/:token', async (req, res) => {
  try {
    const request = await dbGet('SELECT subcontractor_id FROM upload_requests WHERE token = ?', [req.params.token])
    if (!request) return res.status(404).json({ error: 'Invalid link' })
    const cois = await dbAll(
      'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
      [request.subcontractor_id]
    )
    const enriched = await Promise.all(
      cois.map(async (c) => ({
        ...labelSimulatedCarrierCOI(c),
        coverages: await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [c.id]),
      }))
    )
    res.json({ cois: enriched })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
