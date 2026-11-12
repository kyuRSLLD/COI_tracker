import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, projectComplianceScore, labelSimulatedCarrierCOI } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import type { NextFunction, Response } from 'express'

// JWT roles can be stale; authorize against the current database record.
export async function requireCurrentGC(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await dbGet('SELECT role FROM users WHERE id = ?', [req.user!.id])
    if (!user || user.role !== 'gc') return res.status(403).json({ error: 'General contractor access required' })
    next()
  } catch { res.status(500).json({ error: 'Unable to verify account role' }) }
}
async function ownedProject(id: string, userId: string) {
  return dbGet('SELECT * FROM projects WHERE id = ? AND user_id = ?', [id, userId])
}
async function connectedLinks(projectId: string, userId: string) {
  return dbAll(`SELECT ps.* FROM project_subcontractors ps
    JOIN subcontractors s ON s.id = ps.subcontractor_id
    WHERE ps.project_id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = s.id)`, [projectId, userId])
}

export const projectsRouter = Router()
projectsRouter.use(requireAuth, requireCurrentGC)

projectsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const projects = await dbAll('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC', [req.user!.id])
    const enriched = await Promise.all(
      projects.map(async (p) => {
        const subLinks = await connectedLinks(p.id, req.user!.id)
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

projectsRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const project = await ownedProject(req.params.id, req.user!.id)
    if (!project) return res.status(404).json({ error: 'Project not found' })

    const subLinks = await connectedLinks(project.id, req.user!.id)
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

projectsRouter.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, code, address, client_name, client_email, start_date, end_date, notes } = req.body || {}
    if (!name) return res.status(400).json({ error: 'Project name is required' })
    const id = uuidv4()
    await dbRun(
      `INSERT INTO projects (id, user_id, name, code, address, client_name, client_email, start_date, end_date, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user!.id, name, code || null, address || null, client_name || null, client_email || null, start_date || null, end_date || null, notes || null, new Date().toISOString()]
    )
    const p = await ownedProject(id, req.user!.id)
    res.status(201).json({ project: p })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.put('/:id', async (req: AuthRequest, res) => {
  try {
    const { name, code, address, client_name, client_email, start_date, end_date, notes } = req.body || {}
    const p = await ownedProject(req.params.id, req.user!.id)
    if (!p) return res.status(404).json({ error: 'Project not found' })
    await dbRun(
      `UPDATE projects
       SET name = ?, code = ?, address = ?, client_name = ?, client_email = ?, start_date = ?, end_date = ?, notes = ?
       WHERE id = ? AND user_id = ?`,
      [name ?? p.name, code ?? p.code, address ?? p.address, client_name ?? p.client_name, client_email ?? p.client_email, start_date ?? p.start_date, end_date ?? p.end_date, notes ?? p.notes, req.params.id, req.user!.id]
    )
    const updated = await ownedProject(req.params.id, req.user!.id)
    res.json({ project: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    if (!await ownedProject(req.params.id, req.user!.id)) return res.status(404).json({ error: 'Project not found' })
    await dbRun('DELETE FROM project_subcontractors WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)', [req.params.id, req.params.id, req.user!.id])
    await dbRun('DELETE FROM client_share_links WHERE project_id = ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND user_id = ?)', [req.params.id, req.params.id, req.user!.id])
    await dbRun('DELETE FROM projects WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.post('/:id/subcontractors', async (req: AuthRequest, res) => {
  try {
    const { subcontractor_id } = req.body || {}
    if (!subcontractor_id) return res.status(400).json({ error: 'subcontractor_id is required' })
    if (!await ownedProject(req.params.id, req.user!.id)) return res.status(404).json({ error: 'Project not found' })
    const connected = await dbGet(`SELECT s.id FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = s.id)`, [subcontractor_id, req.user!.id])
    if (!connected) return res.status(404).json({ error: 'Connected subcontractor not found' })
    const existing = await dbGet(
      'SELECT id FROM project_subcontractors WHERE project_id = ? AND subcontractor_id = ?',
      [req.params.id, subcontractor_id]
    )
    if (existing) return res.json({ already: true })
    const result = await dbRun(`INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at)
      SELECT ?, p.id, s.id, ? FROM projects p JOIN subcontractors s ON s.id = ?
      WHERE p.id = ? AND p.user_id = ? AND EXISTS
        (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = p.user_id AND c.subcontractor_id = s.id)`,
      [uuidv4(), new Date().toISOString(), subcontractor_id, req.params.id, req.user!.id])
    if (!result.changes) return res.status(404).json({ error: 'Project or connected subcontractor not found' })
    res.status(201).json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/:id/subcontractors/:subId', async (req: AuthRequest, res) => {
  try {
    const result = await dbRun(`DELETE FROM project_subcontractors WHERE project_id = ? AND subcontractor_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.user_id = ?)
      AND EXISTS (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = ?)`,
      [req.params.id, req.params.subId, req.params.id, req.user!.id, req.user!.id, req.params.subId])
    if (!result.changes) return res.status(404).json({ error: 'Connected project subcontractor not found' })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Share links
projectsRouter.post('/:id/share', async (req: AuthRequest, res) => {
  try {
    if (!await ownedProject(req.params.id, req.user!.id)) return res.status(404).json({ error: 'Project not found' })
    const { expires_in_days, note } = req.body || {}
    const token = crypto.randomBytes(24).toString('hex')
    let expiresAt: string | null = null
    if (expires_in_days && Number(expires_in_days) > 0) {
      const d = new Date()
      d.setDate(d.getDate() + Number(expires_in_days))
      expiresAt = d.toISOString()
    }
    const id = uuidv4()
    const result = await dbRun(`INSERT INTO client_share_links (id, project_id, token, expires_at, created_at, note)
      SELECT ?, p.id, ?, ?, ?, ? FROM projects p WHERE p.id = ? AND p.user_id = ?`,
      [id, token, expiresAt, new Date().toISOString(), note || null, req.params.id, req.user!.id])
    if (!result.changes) return res.status(404).json({ error: 'Project not found' })
    const link = await dbGet('SELECT * FROM client_share_links WHERE id = ?', [id])
    res.status(201).json({ share: link, url: `/share/${token}` })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.get('/:id/shares', async (req: AuthRequest, res) => {
  try {
    if (!await ownedProject(req.params.id, req.user!.id)) return res.status(404).json({ error: 'Project not found' })
    const rows = await dbAll(
      'SELECT * FROM client_share_links WHERE project_id = ? ORDER BY created_at DESC',
      [req.params.id]
    )
    res.json({ shares: rows })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

projectsRouter.delete('/shares/:id', async (req: AuthRequest, res) => {
  try {
    const result = await dbRun(`DELETE FROM client_share_links WHERE id = ? AND EXISTS
      (SELECT 1 FROM projects p WHERE p.id = client_share_links.project_id AND p.user_id = ?)`, [req.params.id, req.user!.id])
    if (!result.changes) return res.status(404).json({ error: 'Share link not found' })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
