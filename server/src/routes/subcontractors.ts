import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, labelSimulatedCarrierCOI } from '../services/compliance.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { getFileViewUrl } from '../services/storage.ts'

export const subcontractorsRouter = Router()

// Connection history cannot establish who wrote legacy global notes, even if
// only one GC is currently connected. Never select them for a GC response.
const gcSubSelect = `s.id, s.user_id, s.company_name, s.trade, s.contact_person,
  s.phone, s.email, s.address, NULL AS notes, s.website, s.status, s.created_at, s.updated_at`

// Verify the current database role so a role change cannot leave GC access
// usable merely because an old token has not expired.
subcontractorsRouter.use(requireAuth, async (req: AuthRequest, res, next) => {
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

subcontractorsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const { trade, status, search, expiring_days } = req.query as {
      trade?: string
      status?: string
      search?: string
      expiring_days?: string
    }

    let sql = `SELECT ${gcSubSelect} FROM subcontractors s
      WHERE EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`
    const params: any[] = [req.user!.id]

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
          `SELECT c.* FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
            WHERE c.subcontractor_id = ? AND EXISTS
            (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
            AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))
            ORDER BY c.expiration_date DESC`,
          [sub.id, req.user!.id, req.user!.id]
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

subcontractorsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const sub = await dbGet(`SELECT ${gcSubSelect} FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    const cois = await dbAll(
      `SELECT c.* FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
        WHERE c.subcontractor_id = ? AND EXISTS
        (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
        AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))
        ORDER BY c.expiration_date DESC`,
      [sub.id, req.user!.id, req.user!.id]
    )
    const enrichedCois = await Promise.all(
      cois.map(async (c) => {
        const coverages = await dbAll(`SELECT cv.* FROM coi_coverages cv JOIN cois c ON c.id = cv.coi_id
          JOIN subcontractors s ON s.id = c.subcontractor_id
          WHERE cv.coi_id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections g
            WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
          AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))`, [c.id, req.user!.id, req.user!.id])
        const viewUrl = c.certificate_key ? await getFileViewUrl(c.certificate_key, c.certificate_url) : null
        const { certificate_key: _key, ...publicFields } = c
        return { ...labelSimulatedCarrierCOI(publicFields), coverages, certificate_url: viewUrl }
      })
    )
    const computed = computeSubcontractorStatus(sub, cois, 30)
    const uploadReqs = await dbAll(
      `SELECT u.* FROM upload_requests u WHERE u.subcontractor_id = ? AND EXISTS
        (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = u.subcontractor_id AND g.gc_user_id = ?)
        AND u.token LIKE ?
        ORDER BY u.created_at DESC`,
      [sub.id, req.user!.id, `gc1.${Buffer.from(req.user!.id, 'utf8').toString('base64url')}.%`]
    )
    res.set('Cache-Control', 'no-store')
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

subcontractorsRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { company_name, trade, contact_person, phone, email, address, notes, status } = req.body || {}
    if (notes != null) return res.status(403).json({ error: 'Subcontractor notes cannot be saved by a general contractor' })
    if (!company_name || !trade) {
      return res.status(400).json({ error: 'Company name and trade are required' })
    }
    const id = uuidv4()
    const now = new Date().toISOString()
    // Check that the connection table exists before creating a legacy row.
    await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? LIMIT 1', [req.user!.id])
    await dbRun(
      `INSERT INTO subcontractors (id, company_name, trade, contact_person, phone, email, address, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, company_name, trade, contact_person || null, phone || null, email || null, address || null, status || 'pending_review', now, now]
    )
    try {
      await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [req.user!.id, id, now])
    } catch (err) {
      // Helpers provide no shared transaction. Best-effort cleanup avoids leaving
      // an unconnected row; do not remove one that gained a connection.
      try {
        await dbRun(`DELETE FROM subcontractors WHERE id = ? AND NOT EXISTS
          (SELECT 1 FROM gc_sub_connections WHERE subcontractor_id = ?)`, [id, id])
      } catch (cleanupErr) {
        console.error('[subcontractors] Failed to clean up unconnected subcontractor', cleanupErr)
      }
      throw err
    }
    const sub = await dbGet(`SELECT ${gcSubSelect} FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [id, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    res.status(201).json({ subcontractor: sub })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { company_name, trade, contact_person, phone, email, address, notes, status } = req.body || {}
    const sub = await dbGet(`SELECT ${gcSubSelect} FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    if (notes != null) return res.status(403).json({ error: 'Subcontractor notes cannot be saved by a general contractor' })
    const now = new Date().toISOString()
    const result = await dbRun(
      `UPDATE subcontractors
       SET company_name = ?, trade = ?, contact_person = ?, phone = ?, email = ?, address = ?, status = ?, updated_at = ?
       WHERE id = ? AND user_id IS NULL
       AND EXISTS (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = subcontractors.id AND g.gc_user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM gc_sub_connections other WHERE other.subcontractor_id = subcontractors.id AND other.gc_user_id <> ?)`,
      [
        company_name ?? sub.company_name,
        trade ?? sub.trade,
        contact_person ?? sub.contact_person,
        phone ?? sub.phone,
        email ?? sub.email,
        address ?? sub.address,
        status ?? sub.status,
        now,
        req.params.id,
        req.user!.id,
        req.user!.id,
      ]
    )
    if (!result.changes) return res.status(403).json({ error: 'Shared or account-owned profiles cannot be edited by a general contractor' })
    const updated = await dbGet(`SELECT ${gcSubSelect} FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!updated) return res.status(404).json({ error: 'Subcontractor not found' })
    res.json({ subcontractor: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

subcontractorsRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const sub = await dbGet(`SELECT s.id FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [req.params.id, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    // A sub and its COIs may be shared. Unlink only this GC and its owned
    // project assignments; never destroy another GC's shared records.
    await dbRun(`DELETE FROM project_subcontractors WHERE subcontractor_id = ?
      AND project_id IN (SELECT id FROM projects WHERE user_id = ?)
      AND EXISTS (SELECT 1 FROM gc_sub_connections WHERE subcontractor_id = ? AND gc_user_id = ?)`,
      [req.params.id, req.user!.id, req.params.id, req.user!.id])
    const result = await dbRun('DELETE FROM gc_sub_connections WHERE subcontractor_id = ? AND gc_user_id = ?', [req.params.id, req.user!.id])
    if (!result.changes) return res.status(404).json({ error: 'Subcontractor not found' })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
