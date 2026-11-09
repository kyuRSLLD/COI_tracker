import express from 'express'
import { dbGet, dbAll, dbRun, planToMRR, PLAN_PRICES } from '../db/db.ts'
import { requireAdmin, requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const adminRouter = express.Router()

// Platform overview: users, revenue, platform KPIs, growth
adminRouter.get('/overview', requireAdmin, async (_req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
    const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString()

    const totalUsersRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM users')
    const adminsRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
    const gcsRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role != 'admin' OR role IS NULL")
    const newThisMonthRow = await dbGet<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE created_at >= ?',
      [thirtyDaysAgo]
    )

    const companiesRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM companies')
    const subsRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM subcontractors')
    const coisRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM cois')
    const sharesRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM client_share_links')
    const pendingCoisRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM cois WHERE status = 'pending_review'")
    const verifiedCoisRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM cois WHERE status = 'verified'")

    const mrrRow = await dbGet<{ total: number }>("SELECT COALESCE(SUM(mrr), 0) AS total FROM companies WHERE status = 'active'")
    const payingRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM companies WHERE status = 'active' AND mrr > 0")
    const mrr = Number(mrrRow?.total || 0)
    const paying = Number(payingRow?.count || 0)

    const plans = await dbAll<{ plan: string; count: number; total_mrr: number }>(
      `SELECT plan, COUNT(*) AS count, COALESCE(SUM(mrr), 0) AS total_mrr
       FROM companies GROUP BY plan ORDER BY total_mrr DESC`
    )

    // 6-month growth trend (SUBSTR + param is portable across SQLite and PostgreSQL)
    const growth = await dbAll<{ month: string; new_users: number }>(
      `SELECT SUBSTR(created_at, 1, 7) AS month, COUNT(*) AS new_users
       FROM users
       WHERE created_at >= ?
       GROUP BY month
       ORDER BY month ASC`,
      [sixMonthsAgo]
    )

    res.json({
      users: {
        total: Number(totalUsersRow?.count || 0),
        new_this_month: Number(newThisMonthRow?.count || 0),
        admins: Number(adminsRow?.count || 0),
        gcs: Number(gcsRow?.count || 0),
      },
      revenue: {
        mrr,
        arr: mrr * 12,
        paying_subscribers: paying,
        arpu: paying > 0 ? Math.round(mrr / paying) : 0,
        plan_breakdown: plans.map((p) => ({
          plan: p.plan,
          count: Number(p.count),
          mrr: Number(p.total_mrr),
        })),
        available_plans: Object.entries(PLAN_PRICES).map(([plan, price]) => ({ plan, price })),
      },
      platform: {
        companies: Number(companiesRow?.count || 0),
        subcontractors: Number(subsRow?.count || 0),
        cois: Number(coisRow?.count || 0),
        client_share_links: Number(sharesRow?.count || 0),
        pending_reviews: Number(pendingCoisRow?.count || 0),
        verified_cois: Number(verifiedCoisRow?.count || 0),
      },
      growth: growth.map((g) => ({ month: g.month, new_users: Number(g.new_users) })),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Companies list with stats
adminRouter.get('/companies', requireAdmin, async (_req, res) => {
  try {
    const companies = await dbAll(
      `SELECT c.*,
              u.name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM subcontractors s WHERE s.user_id = c.owner_user_id) AS subcontractor_count,
              (SELECT COUNT(*) FROM projects p WHERE p.user_id = c.owner_user_id) AS project_count,
              (SELECT COUNT(*) FROM client_share_links sl JOIN projects pr ON sl.project_id = pr.id WHERE pr.user_id = c.owner_user_id) AS share_count
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_user_id
       ORDER BY c.created_at DESC`
    )
    res.json({
      companies: companies.map((c) => ({
        ...c,
        subcontractor_count: Number(c.subcontractor_count || 0),
        project_count: Number(c.project_count || 0),
        share_count: Number(c.share_count || 0),
      })),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Update company plan (changes plan + mrr)
adminRouter.put('/companies/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body || {}
    if (!plan) return res.status(400).json({ error: 'plan is required' })
    const mrr = planToMRR(plan)
    await dbRun('UPDATE companies SET plan = ?, mrr = ? WHERE id = ?', [plan, mrr, req.params.id])
    const company = await dbGet('SELECT * FROM companies WHERE id = ?', [req.params.id])
    res.json({ company })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Delete a company
adminRouter.delete('/companies/:id', requireAdmin, async (req, res) => {
  try {
    await dbRun('DELETE FROM companies WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// All users list
adminRouter.get('/users', requireAdmin, async (_req, res) => {
  try {
    const users = await dbAll(
      `SELECT u.id, u.email, u.name, u.company_name, u.role, u.created_at,
              c.plan AS company_plan, c.mrr AS company_mrr
       FROM users u
       LEFT JOIN companies c ON c.owner_user_id = u.id
       ORDER BY u.created_at DESC`
    )
    res.json({ users })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Promote / demote a user
adminRouter.put('/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {}
    if (!['admin', 'gc'].includes(role)) {
      return res.status(400).json({ error: "role must be 'admin' or 'gc'" })
    }
    await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id])
    const user = await dbGet('SELECT id, email, name, role, company_name FROM users WHERE id = ?', [req.params.id])
    res.json({ user })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Delete a user (cannot delete yourself, cannot delete the last admin)
adminRouter.delete('/users/:id', requireAdmin, async (req: AuthRequest, res) => {
  try {
    if (req.user!.id === req.params.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' })
    }
    const target = await dbGet<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = ?', [
      req.params.id,
    ])
    if (!target) return res.status(404).json({ error: 'User not found' })
    if (target.role === 'admin') {
      const adminCount = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
      if (Number(adminCount?.count || 0) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only admin' })
      }
    }
    await dbRun('DELETE FROM companies WHERE owner_user_id = ?', [req.params.id])
    await dbRun('DELETE FROM users WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Reset entire database to fresh demo data (admin only)
adminRouter.post('/danger/reset', requireAdmin, async (_req, res) => {
  try {
    const { seed } = await import('../seed.ts')
    await seed()
    res.json({ success: true, message: 'Database reset to demo data' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Bootstrap helper: if no admin exists yet, promote the caller
adminRouter.post('/make-me-admin', requireAuth, async (req: AuthRequest, res) => {
  try {
    const adminCount = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
    if (Number(adminCount?.count || 0) > 0) {
      return res.status(403).json({ error: 'An admin already exists. Ask an existing admin to grant access.' })
    }
    await dbRun("UPDATE users SET role = 'admin' WHERE id = ?", [req.user!.id])
    const user = await dbGet('SELECT id, email, name, role FROM users WHERE id = ?', [req.user!.id])
    res.json({ user, message: 'You are now an admin. Re-login to refresh your token.' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
