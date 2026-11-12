import express from 'express'; const Router = express.Router
import { dbAll } from '../db/db.ts'
import { computeSubcontractorStatus } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { requireCurrentGC } from './projects.ts'

export const statsRouter = Router()

statsRouter.get('/', requireAuth, requireCurrentGC, async (req: AuthRequest, res) => {
  try {
    const subs = await dbAll(`SELECT s.* FROM subcontractors s WHERE EXISTS (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = s.id)`, [req.user!.id])
    const warningDays = 30
    let compliant = 0
    let expiring = 0
    let expired = 0
    let missing = 0
    let pending = 0
    const tradeCounts: Record<string, { total: number; compliant: number }> = {}
    const upcoming: any[] = []

    for (const sub of subs) {
      const cois = await dbAll(
        'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
        [sub.id]
      )
      const computed = computeSubcontractorStatus(sub, cois, warningDays)
      if (computed.status === 'compliant') compliant++
      else if (computed.status === 'expiring_soon') expiring++
      else if (computed.status === 'expired') expired++
      else if (computed.status === 'missing') missing++
      else pending++

      // trade aggregation
      const tr = sub.trade || 'Other'
      tradeCounts[tr] = tradeCounts[tr] || { total: 0, compliant: 0 }
      tradeCounts[tr].total++
      if (computed.status === 'compliant') tradeCounts[tr].compliant++

      // upcoming expirations (≤60 days)
      if (computed.bestCOI && computed.daysLeft !== null && computed.daysLeft <= 60 && computed.bestCOI.status !== 'rejected') {
        upcoming.push({
          sub_id: sub.id,
          company_name: sub.company_name,
          trade: sub.trade,
          carrier: computed.bestCOI.carrier,
          expiration_date: computed.bestCOI.expiration_date,
          days_left: computed.daysLeft,
          status: computed.status,
          coi_id: computed.bestCOI.id,
          phone: sub.phone,
          email: sub.email,
        })
      }
    }

    upcoming.sort((a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999))

    const total = subs.length
    const score = total === 0 ? 100 : Math.round((compliant / total) * 100)

    const projects = await dbAll('SELECT id FROM projects WHERE user_id = ?', [req.user!.id])
    const shares = await dbAll('SELECT sl.id FROM client_share_links sl JOIN projects p ON p.id = sl.project_id WHERE p.user_id = ?', [req.user!.id])

    res.json({
      totals: { total, compliant, expiring, expired, missing, pending, score },
      projects_count: projects.length,
      share_links_count: shares.length,
      trades: Object.entries(tradeCounts).map(([trade, v]) => ({ trade, ...v })),
      upcoming: upcoming.slice(0, 10),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
