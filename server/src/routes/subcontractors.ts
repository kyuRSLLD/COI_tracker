import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, labelSimulatedCarrierCOI } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'

export const subcontractorsRouter = Router()

subcontractorsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { trade, status, search, expiring_days } = req.query as {
      trade?: string
      status?: string
      search?: string
      expiring_days?: string
    }

    let sql = 'SELECT * FROM subcontractors WHERE 1=1'
    const params: any[] = []

    if (trade && trade !== 'all') {
      sql += ' AND trade = ?'
      params.push(trade)
    }
    if (search) {
      sql += ' AND (company_name LIKE ? OR contact_person LIKE ? OR trade LIKE ?)'
      params.push(`%${search}%`, `%${search}%`, `%${search}%`)
    }
    sql += ' ORDER BY company_name ASC'

    const rows = await dbAll(sql, params)
    const warningDays = Number(expiring_days) || 30

    // enrich each sub with latest COI and computed status
    const enriched = await Promise.all(
      rows.map(async (sub) => {
        const cois = await dbAll(
          'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
          [sub.id]
        )
        const computed = computeSubcontractorStatus(sub, cois, warningDays)
        return {
          ...sub,
          computed_status: computed.status,
          best_coi: computed.bestCOI ? labelSimulatedCarrierCOI(computed.bestCOI) : null,
          days_left: computed.daysLeft,
          coi_count: cois.length,
        }
      })
    )

    const filtered = status && status !== 'all'
      ? enriched.filter((s) => s.computed_status === status)
      : enriched

    res.json({ subcontractors: filtered })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [req.params.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    const cois = await dbAll(
      'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
      [sub.id]
    )
    const enrichedCois = await Promise.all(
      cois.map(async (c) => {
        const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [c.id])
        return { ...labelSimulatedCarrierCOI(c), coverages }
      })
    )
    const computed = computeSubcontractorStatus(sub, cois, 30)
    const uploadReqs = await dbAll(
      'SELECT * FROM upload_requests WHERE subcontractor_id = ? ORDER BY created_at DESC',
      [sub.id]
    )
    res.json({
      subcontractor: {
        ...sub,
        computed_status: computed.status,
        best_coi: computed.bestCOI ? labelSimulatedCarrierCOI(computed.bestCOI) : null,
        days_left: computed.daysLeft,
        cois: enrichedCois,
        upload_requests: uploadReqs,
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.post('/', requireAuth, async (req, res) => {
  try {
    const { company_name, trade, contact_person, phone, email, address, notes, status } = req.body || {}
    if (!company_name || !trade) {
      return res.status(400).json({ error: 'Company name and trade are required' })
    }
    const id = uuidv4()
    const now = new Date().toISOString()
    await dbRun(
      `INSERT INTO subcontractors (id, company_name, trade, contact_person, phone, email, address, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, company_name, trade, contact_person || null, phone || null, email || null, address || null, notes || null, status || 'pending_review', now, now]
    )
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [id])
    res.status(201).json({ subcontractor: sub })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { company_name, trade, contact_person, phone, email, address, notes, status } = req.body || {}
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [req.params.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    const now = new Date().toISOString()
    await dbRun(
      `UPDATE subcontractors
       SET company_name = ?, trade = ?, contact_person = ?, phone = ?, email = ?, address = ?, notes = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        company_name ?? sub.company_name,
        trade ?? sub.trade,
        contact_person ?? sub.contact_person,
        phone ?? sub.phone,
        email ?? sub.email,
        address ?? sub.address,
        notes ?? sub.notes,
        status ?? sub.status,
        now,
        req.params.id,
      ]
    )
    const updated = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [req.params.id])
    res.json({ subcontractor: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM project_subcontractors WHERE subcontractor_id = ?', [req.params.id])
    const cois = await dbAll('SELECT id FROM cois WHERE subcontractor_id = ?', [req.params.id])
    for (const c of cois) {
      await dbRun('DELETE FROM coi_coverages WHERE coi_id = ?', [c.id])
    }
    await dbRun('DELETE FROM cois WHERE subcontractor_id = ?', [req.params.id])
    await dbRun('DELETE FROM upload_requests WHERE subcontractor_id = ?', [req.params.id])
    await dbRun('DELETE FROM subcontractors WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
