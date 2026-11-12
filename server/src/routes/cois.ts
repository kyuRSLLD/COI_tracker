import express from 'express'; const Router = express.Router
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { storeFile, getFileViewUrl } from '../services/storage.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
})

export const coisRouter = Router()

coisRouter.use(requireAuth, async (req: AuthRequest, res, next) => {
  if (req.user?.role !== 'gc' || typeof req.user.id !== 'string' || !req.user.id) {
    return res.status(403).json({ error: 'GC access required' })
  }
  try {
    const user = await dbGet('SELECT id FROM users WHERE id = ? AND role = ?', [req.user.id, 'gc'])
    if (!user) return res.status(403).json({ error: 'GC access required' })
    next()
  } catch {
    res.status(500).json({ error: 'Unable to verify access' })
  }
})

coisRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const { sub_id, status } = req.query as { sub_id?: string; status?: string }
    let sql = `
      SELECT c.*, s.company_name, s.trade, s.contact_person
      FROM cois c
      JOIN subcontractors s ON s.id = c.subcontractor_id
      WHERE EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
    `
    const params: any[] = [req.user!.id]
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

coisRouter.get('/alerts/expiring', async (req: AuthRequest, res) => {
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
         AND EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
       ORDER BY c.expiration_date ASC`,
      [todayStr, horizonStr, req.user!.id]
    )
    res.json({ alerts: rows.map(labelSimulatedCarrierCOI), window_days: days })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const coi = await dbGet(
       `SELECT c.*, s.company_name, s.trade, s.phone, s.email, s.contact_person
       FROM cois c
       JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.id = ? AND EXISTS
         (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`,
      [req.params.id, req.user!.id]
    )
    if (!coi) return res.status(404).json({ error: 'COI not found' })
    const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
    const viewUrl = coi.certificate_key ? await getFileViewUrl(coi.certificate_key, coi.certificate_url) : null
    res.json({ coi: { ...labelSimulatedCarrierCOI(coi), coverages, certificate_url: viewUrl || coi.certificate_url } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.post('/', upload.single('certificate'), async (req: AuthRequest, res) => {
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

    const sub = await dbGet(`SELECT s.id FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [subcontractor_id, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })

    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }

    const id = uuidv4()
    const now = new Date().toISOString()
    const inserted = await dbRun(
      `INSERT INTO cois (id, subcontractor_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM gc_sub_connections g JOIN subcontractors s ON s.id = g.subcontractor_id
         WHERE g.subcontractor_id = ? AND g.gc_user_id = ?)`,
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
        subcontractor_id,
        req.user!.id,
      ]
    )
    if (!inserted.changes) return res.status(404).json({ error: 'Subcontractor not found' })

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
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM cois c JOIN gc_sub_connections g ON g.subcontractor_id = c.subcontractor_id
            WHERE c.id = ? AND g.gc_user_id = ?)`,
        [
          uuidv4(),
          id,
          cv.type || 'General Liability',
          cv.per_occurrence_limit || null,
          cv.aggregate_limit || null,
          cv.additional_insured ? 1 : 0,
          cv.waiver_of_subrogation ? 1 : 0,
          cv.notes || null,
          id,
          req.user!.id,
        ]
      )
    }

    const created = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [id, req.user!.id])
    if (!created) return res.status(404).json({ error: 'COI not found' })
    res.status(201).json({ coi: created })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id', upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    const existing = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })

    const { carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes } = req.body || {}
    let stored
    if (req.file) {
      stored = await storeFile(req.file)
    }

    const now = new Date().toISOString()
    const result = await dbRun(
      `UPDATE cois
       SET carrier = ?, am_best_rating = ?, policy_number = ?, effective_date = ?, expiration_date = ?, status = ?, reviewer_notes = ?, certificate_url = ?, certificate_key = ?, certificate_name = ?, certificate_size = ?, certificate_mime = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = cois.subcontractor_id AND g.gc_user_id = ?)`,
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
        req.user!.id,
      ]
    )
    if (!result.changes) return res.status(404).json({ error: 'COI not found' })
    const updated = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!updated) return res.status(404).json({ error: 'COI not found' })
    res.json({ coi: labelSimulatedCarrierCOI(updated) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id/review', async (req: AuthRequest, res) => {
  try {
    const { status, reviewer_notes } = req.body || {}
    if (!status || !['compliant', 'needs_revision', 'rejected', 'pending_review'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required: compliant, needs_revision, rejected, pending_review' })
    }
    const existing = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })

    const now = new Date().toISOString()
    const result = await dbRun(
      `UPDATE cois
       SET status = ?, reviewer_notes = ?, review_date = ?, updated_at = ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = cois.subcontractor_id AND g.gc_user_id = ?)`,
      [status, reviewer_notes ?? existing.reviewer_notes, now, now, req.params.id, req.user!.id]
    )
    if (!result.changes) return res.status(404).json({ error: 'COI not found' })
    const updated = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!updated) return res.status(404).json({ error: 'COI not found' })
    res.json({ coi: labelSimulatedCarrierCOI(updated) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await dbGet(`SELECT c.id, s.user_id AS sub_user_id FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id WHERE c.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })
    if (existing.sub_user_id) return res.status(403).json({ error: 'Certificates owned by subcontractor accounts cannot be deleted by a general contractor' })
    await dbRun(`DELETE FROM coi_coverages WHERE coi_id = ? AND EXISTS
      (SELECT 1 FROM cois c JOIN gc_sub_connections g ON g.subcontractor_id = c.subcontractor_id JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.id = coi_coverages.coi_id AND g.gc_user_id = ? AND s.user_id IS NULL)`, [req.params.id, req.user!.id])
    const result = await dbRun(`DELETE FROM cois WHERE id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g JOIN subcontractors s ON s.id = g.subcontractor_id WHERE g.subcontractor_id = cois.subcontractor_id AND g.gc_user_id = ? AND s.user_id IS NULL)`, [req.params.id, req.user!.id])
    if (!result.changes) return res.status(404).json({ error: 'COI not found' })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
