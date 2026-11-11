import express from 'express'; const Router = express.Router
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { storeFile, getFileViewUrl } from '../services/storage.ts'
import { requireAuth } from '../middleware/auth.ts'
import { isSimulatedCarrierCOI, labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
})

export const coisRouter = Router()

coisRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { sub_id, status } = req.query as { sub_id?: string; status?: string }
    let sql = `
      SELECT c.*, s.company_name, s.trade, s.contact_person
      FROM cois c
      JOIN subcontractors s ON s.id = c.subcontractor_id
      WHERE 1=1
    `
    const params: any[] = []
    if (sub_id) {
      sql += ' AND c.subcontractor_id = ?'
      params.push(sub_id)
    }
    sql += ' ORDER BY c.expiration_date ASC'
    const allRows = (await dbAll(sql, params)).map(labelSimulatedCarrierCOI)
    const rows = status && status !== 'all' ? allRows.filter((c) => c.status === status) : allRows
    const enriched = await Promise.all(
      rows.map(async (c) => {
        const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [c.id])
        const viewUrl = c.certificate_key ? await getFileViewUrl(c.certificate_key, c.certificate_url) : null
        return { ...labelSimulatedCarrierCOI(c), coverages, certificate_url: viewUrl || c.certificate_url }
      })
    )
    res.json({ cois: enriched })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.get('/alerts/expiring', requireAuth, async (req, res) => {
  try {
    const days = Number(req.query.days) || 30
    const today = new Date()
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + days)
    const todayStr = today.toISOString().slice(0, 10)
    const horizonStr = horizon.toISOString().slice(0, 10)

    const rows = await dbAll(
      `SELECT c.*, s.company_name, s.trade, s.phone, s.email, s.contact_person
       FROM cois c
       JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.expiration_date >= ? AND c.expiration_date <= ? AND c.status != 'rejected'
       ORDER BY c.expiration_date ASC`,
      [todayStr, horizonStr]
    )
    res.json({ alerts: rows.map(labelSimulatedCarrierCOI), window_days: days })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const coi = await dbGet(
      `SELECT c.*, s.company_name, s.trade, s.phone, s.email, s.contact_person
       FROM cois c
       JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.id = ?`,
      [req.params.id]
    )
    if (!coi) return res.status(404).json({ error: 'COI not found' })
    const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    const viewUrl = coi.certificate_key ? await getFileViewUrl(coi.certificate_key, coi.certificate_url) : null
    res.json({ coi: { ...labelSimulatedCarrierCOI(coi), coverages, certificate_url: viewUrl || coi.certificate_url } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.post('/', requireAuth, upload.single('certificate'), async (req, res) => {
  try {
    const {
      subcontractor_id,
      carrier,
      am_best_rating,
      policy_number,
      effective_date,
      expiration_date,
      status,
      reviewer_notes,
    } = req.body || {}

    if (!subcontractor_id || !carrier || !effective_date || !expiration_date) {
      return res.status(400).json({ error: 'subcontractor_id, carrier, effective_date, and expiration_date are required' })
    }

    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }

    const id = uuidv4()
    const now = new Date().toISOString()
    await dbRun(
      `INSERT INTO cois (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        subcontractor_id,
        carrier,
        am_best_rating || null,
        policy_number || null,
        effective_date,
        expiration_date,
        status || 'pending_review',
        reviewer_notes || null,
        stored ? stored.url : null,
        stored ? stored.key : null,
        stored ? stored.filename : null,
        stored ? stored.size : null,
        stored ? stored.mime : null,
        now,
        now,
      ]
    )

    // parse coverages JSON if provided
    let coverages: any[] = []
    if (req.body.coverages) {
      try {
        coverages = JSON.parse(req.body.coverages)
      } catch {}
    }
    for (const cv of coverages) {
      await dbRun(
        `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          id,
          cv.type || 'General Liability',
          cv.per_occurrence_limit || null,
          cv.aggregate_limit || null,
          cv.additional_insured ? 1 : 0,
          cv.waiver_of_subrogation ? 1 : 0,
          cv.notes || null,
        ]
      )
    }

    const created = await dbGet('SELECT * FROM cois WHERE id = ?', [id])
    res.status(201).json({ coi: labelSimulatedCarrierCOI(created) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id', requireAuth, upload.single('certificate'), async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM cois WHERE id = ?', [req.params.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })

    if (isSimulatedCarrierCOI(existing)) return res.status(409).json({ error: 'Simulated records cannot be edited or approved. Upload a real certificate for review.' })
    const { carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes } = req.body || {}
    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }

    const now = new Date().toISOString()
    await dbRun(
      `UPDATE cois
       SET carrier = ?, am_best_rating = ?, policy_number = ?, effective_date = ?, expiration_date = ?, status = ?, reviewer_notes = ?, certificate_url = ?, certificate_key = ?, certificate_name = ?, certificate_size = ?, certificate_mime = ?, updated_at = ?
       WHERE id = ?`,
      [
        carrier ?? existing.carrier,
        am_best_rating ?? existing.am_best_rating,
        policy_number ?? existing.policy_number,
        effective_date ?? existing.effective_date,
        expiration_date ?? existing.expiration_date,
        status ?? existing.status,
        reviewer_notes ?? existing.reviewer_notes,
        stored ? stored.url : existing.certificate_url,
        stored ? stored.key : existing.certificate_key,
        stored ? stored.filename : existing.certificate_name,
        stored ? stored.size : existing.certificate_size,
        stored ? stored.mime : existing.certificate_mime,
        now,
        req.params.id,
      ]
    )
    const updated = await dbGet('SELECT * FROM cois WHERE id = ?', [req.params.id])
    res.json({ coi: labelSimulatedCarrierCOI(updated) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id/review', requireAuth, async (req, res) => {
  try {
    const { status, reviewer_notes } = req.body || {}
    if (!status || !['compliant', 'needs_revision', 'rejected', 'pending_review'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required: compliant, needs_revision, rejected, pending_review' })
    }
    const existing = await dbGet('SELECT * FROM cois WHERE id = ?', [req.params.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })

    if (isSimulatedCarrierCOI(existing)) return res.status(409).json({ error: 'Simulated records cannot be edited or approved. Upload a real certificate for review.' })
    const now = new Date().toISOString()
    await dbRun(
      `UPDATE cois
       SET status = ?, reviewer_notes = ?, review_date = ?, updated_at = ?
       WHERE id = ?`,
      [status, reviewer_notes ?? existing.reviewer_notes, now, now, req.params.id]
    )
    const updated = await dbGet('SELECT * FROM cois WHERE id = ?', [req.params.id])
    res.json({ coi: labelSimulatedCarrierCOI(updated) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM coi_coverages WHERE coi_id = ?', [req.params.id])
    await dbRun('DELETE FROM cois WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
