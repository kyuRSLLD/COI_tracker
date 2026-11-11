import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, projectComplianceScore, labelSimulatedCarrierCOI } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const projectsRouter = Router()

projectsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const projects = await dbAll('SELECT * FROM projects ORDER BY created_at DESC')
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const subLinks = await dbAll('SELECT * FROM project_subcontractors WHERE project_id = ?', [p.id])
        const subRows = await Promise.all(
          subLinks.map(async (l) => {
            const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [l.subcontractor_id])
            const cois = sub
              ? await dbAll('SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC', [sub.id])
              : []
            return { sub, cois }
          })
        )
        const scorecard = projectComplianceScore(subRows.filter((r) => r.sub))
        const shares = await dbAll('SELECT * FROM client_share_links WHERE project_id = ?', [p.id])
        return { ...p, sub_count: subLinks.length, scorecard, share_count: shares.length }
      })
    )
    res.json({ projects: enriched })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.get('/:id', requireAuth, async (req, res) => {
  try {
    const project = await dbGet('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return res.status(404).json({ error: 'Project not found' })

    const subLinks = await dbAll('SELECT * FROM project_subcontractors WHERE project_id = ?', [project.id])
    const subs = await Promise.all(
      subLinks.map(async (l) => {
        const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [l.subcontractor_id])
        if (!sub) return null
        const cois = await dbAll(
          'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
          [sub.id]
        )
        const computed = computeSubcontractorStatus(sub, cois, 30)
        return {
          ...sub,
          computed_status: computed.status,
          best_coi: computed.bestCOI ? labelSimulatedCarrierCOI(computed.bestCOI) : null,
          days_left: computed.daysLeft,
          cois: cois.map(labelSimulatedCarrierCOI),
        }
      })
    )
    const validSubs = subs.filter(Boolean)
    const subRows = validSubs.map((s: any) => ({ sub: s, cois: s.cois }))
    const scorecard = projectComplianceScore(subRows)
    const shares = await dbAll(
      'SELECT * FROM client_share_links WHERE project_id = ? ORDER BY created_at DESC',
      [project.id]
    )
    res.json({ project: { ...project, subcontractors: validSubs, scorecard, shares } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.post('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!req.user || !['gc', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'General contractor access required' })
    const { name, code, address, client_name, client_email, start_date, end_date, notes } = req.body || {}
    if (!name) return res.status(400).json({ error: 'Project name is required' })
    const id = uuidv4()
    await dbRun(
      `INSERT INTO projects (id, user_id, name, code, address, client_name, client_email, start_date, end_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, name, code || null, address || null, client_name || null, client_email || null, start_date || null, end_date || null, notes || null, new Date().toISOString()]
    )
    const p = await dbGet('SELECT * FROM projects WHERE id = ?', [id])
    res.status(201).json({ project: p })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, code, address, client_name, client_email, start_date, end_date, notes } = req.body || {}
    const p = await dbGet('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!p) return res.status(404).json({ error: 'Project not found' })
    await dbRun(
      `UPDATE projects
       SET name = ?, code = ?, address = ?, client_name = ?, client_email = ?, start_date = ?, end_date = ?, notes = ?
       WHERE id = ?`,
      [name ?? p.name, code ?? p.code, address ?? p.address, client_name ?? p.client_name, client_email ?? p.client_email, start_date ?? p.start_date, end_date ?? p.end_date, notes ?? p.notes, req.params.id]
    )
    const updated = await dbGet('SELECT * FROM projects WHERE id = ?', [req.params.id])
    res.json({ project: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM project_subcontractors WHERE project_id = ?', [req.params.id])
    await dbRun('DELETE FROM client_share_links WHERE project_id = ?', [req.params.id])
    await dbRun('DELETE FROM projects WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.post('/:id/subcontractors', requireAuth, async (req, res) => {
  try {
    const { subcontractor_id } = req.body || {}
    if (!subcontractor_id) return res.status(400).json({ error: 'subcontractor_id is required' })
    const existing = await dbGet(
      'SELECT id FROM project_subcontractors WHERE project_id = ? AND subcontractor_id = ?',
      [req.params.id, subcontractor_id]
    )
    if (existing) return res.json({ already: true })
    await dbRun(
      'INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)',
      [uuidv4(), req.params.id, subcontractor_id, new Date().toISOString()]
    )
    res.status(201).json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/:id/subcontractors/:subId', requireAuth, async (req, res) => {
  try {
    await dbRun(
      'DELETE FROM project_subcontractors WHERE project_id = ? AND subcontractor_id = ?',
      [req.params.id, req.params.subId]
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Share links
projectsRouter.post('/:id/share', requireAuth, async (req, res) => {
  try {
    const { expires_in_days, note } = req.body || {}
    const token = crypto.randomBytes(24).toString('hex')
    let expiresAt: string | null = null
    if (expires_in_days && Number(expires_in_days) > 0) {
      const d = new Date()
      d.setDate(d.getDate() + Number(expires_in_days))
      expiresAt = d.toISOString()
    }
    const id = uuidv4()
    await dbRun(
      `INSERT INTO client_share_links (id, project_id, token, expires_at, created_at, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, token, expiresAt, new Date().toISOString(), note || null]
    )
    const link = await dbGet('SELECT * FROM client_share_links WHERE id = ?', [id])
    res.status(201).json({ share: link, url: `/share/${token}` })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.get('/:id/shares', requireAuth, async (req, res) => {
  try {
    const rows = await dbAll(
      'SELECT * FROM client_share_links WHERE project_id = ? ORDER BY created_at DESC',
      [req.params.id]
    )
    res.json({ shares: rows })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/shares/:id', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM client_share_links WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
