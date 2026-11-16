import { isRealEmailConfigured, emailMode } from '../services/email.ts'
import express from 'express'
import { dbGet, dbAll, dbRun, planToMRR, PLAN_PRICES } from '../db/db.ts'
import { randomUUID } from 'crypto'
import { requireAdmin, requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'


const HOLDING_COMPANIES = [
  'cna financial', 'travelers companies', 'liberty mutual group', 'nationwide mutual group',
  'hartford financial', 'aig', 'chubb limited', 'berkshire hathaway group', 'progressive group',
  'state farm group', 'zurich insurance group', 'allstate corporation',
]
function isHoldingCompany(name?: string | null): boolean {
  if (!name) return false
  const n = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  return HOLDING_COMPANIES.some((h) => n.includes(h) || h.includes(n))
}
function normCompany(s?: string | null): string {
  if (!s) return ''
  return s.toLowerCase()
    .replace(/(llc|inc|incorporated|corp|corporation|ltd|limited|co|company)/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const adminRouter = express.Router()

// Platform overview: users, revenue, platform KPIs, growth
adminRouter.get('/overview', requireAdmin, async (req, res) => {
  try {
    const excludeTest = req.query.exclude_test === '1'
    const companyFilter = excludeTest ? 'AND (c.is_test IS NULL OR c.is_test = 0)' : ''
    const userTestFilter = excludeTest ? "AND NOT (u.email LIKE '%.demo' OR u.email LIKE '%.test' OR u.role = 'admin' OR LOWER(COALESCE(u.company_name, '')) LIKE '%demo%' OR LOWER(COALESCE(u.company_name, '')) LIKE '%test%')" : ''
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
    const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString()
    const totalUsersRow = await dbGet<{ count: number }>(`SELECT COUNT(*) AS count FROM users u WHERE 1=1 ${userTestFilter}`)
    const adminsRow = await dbGet<{ count: number }>(`SELECT COUNT(*) AS count FROM users u WHERE role = 'admin' ${userTestFilter}`)
    const gcsRow = await dbGet<{ count: number }>(`SELECT COUNT(*) AS count FROM users u WHERE (role != 'admin' OR role IS NULL) ${userTestFilter}`)
    const newThisMonthRow = await dbGet<{ count: number }>(
      `SELECT COUNT(*) AS count FROM users u WHERE created_at >= ? ${userTestFilter}`,
      [thirtyDaysAgo]
    )
    const companiesRow = await dbGet<{ count: number }>(`SELECT COUNT(*) AS count FROM companies c WHERE 1=1 ${companyFilter}`)
    const subsRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM subcontractors')
    const coisRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM cois')
    const sharesRow = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM client_share_links')
    const pendingCoisRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM cois WHERE status = 'pending_review'")
    const verifiedCoisRow = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM cois WHERE status = 'compliant'")
    const mrrRow = await dbGet<{ total: number }>(`SELECT COALESCE(SUM(mrr), 0) AS total FROM companies c WHERE status = 'active' ${companyFilter}`)
    const payingRow = await dbGet<{ count: number }>(`SELECT COUNT(*) AS count FROM companies c WHERE status = 'active' AND mrr > 0 ${companyFilter}`)
    const mrr = Number(mrrRow?.total || 0)
    const paying = Number(payingRow?.count || 0)
    const plans = await dbAll<{ plan: string; count: number; total_mrr: number }>(
      `SELECT plan, COUNT(*) AS count, COALESCE(SUM(mrr), 0) AS total_mrr
       FROM companies c WHERE 1=1 ${companyFilter} GROUP BY plan ORDER BY total_mrr DESC`
    )
    const range = String(req.query.range || '30d')
    const days = range === '7d' ? 7 : range === '90d' ? 90 : range === '12m' ? 365 : 30
    const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    const groupBy = range === '12m' ? 'SUBSTR(created_at, 1, 7)' : 'SUBSTR(created_at, 1, 10)'
    const rawGrowth = await dbAll<{ period: string; new_users: number }>(
      `SELECT ${groupBy} AS period, COUNT(*) AS new_users
       FROM users u
       WHERE created_at >= ? ${userTestFilter}
       GROUP BY period
       ORDER BY period ASC`,
      [sinceDate]
    )
    const gmap = new Map(rawGrowth.map((g) => [g.period, Number(g.new_users)]))
    const growth: Array<{ period: string; label: string; new_users: number }> = []
    if (range === '12m') {
      for (let i = 11; i >= 0; i--) {
        const d = new Date()
        d.setMonth(d.getMonth() - i)
        const key = d.toISOString().slice(0, 7)
        growth.push({ period: key, label: d.toLocaleString('en-US', { month: 'short' }), new_users: gmap.get(key) || 0 })
      }
    } else {
      for (let i = days - 1; i >= 0; i--) {
        const key = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
        growth.push({ period: key, label: key.slice(5), new_users: gmap.get(key) || 0 })
      }
    }
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
      growth,
      growth_range: range,
      new_signups_period: growth.reduce((a, b) => a + b.new_users, 0),
      email: { mode: emailMode(), simulated: !isRealEmailConfigured() },
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
        is_test: c.is_test === 1,
      })),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Update company plan (changes plan + mrr, records audit log)
adminRouter.put('/companies/:id/plan', requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { plan, reason } = req.body || {}
    if (!plan) return res.status(400).json({ error: 'plan is required' })
    const allowed = Object.keys(PLAN_PRICES)
    if (!allowed.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${allowed.join(', ')}` })
    }
    const current = await dbGet<{ plan: string }>('SELECT plan FROM companies WHERE id = ?', [req.params.id])
    if (!current) return res.status(404).json({ error: 'Company not found' })
    const mrr = planToMRR(plan)
    await dbRun('UPDATE companies SET plan = ?, mrr = ? WHERE id = ?', [plan, mrr, req.params.id])
    await dbRun(
      `INSERT INTO plan_changes (id, company_id, from_plan, to_plan, changed_by, reason, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), req.params.id, current.plan || null, plan, req.user?.email || null, reason ? String(reason).trim().slice(0, 1000) : null, new Date().toISOString()]
    )
    const company = await dbGet('SELECT * FROM companies WHERE id = ?', [req.params.id])
    res.json({ company })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
adminRouter.get('/companies/:id/plan-changes', requireAdmin, async (req, res) => {
  try {
    const changes = await dbAll('SELECT * FROM plan_changes WHERE company_id = ? ORDER BY changed_at DESC', [req.params.id])
    res.json({ changes })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
adminRouter.put('/companies/:id/test-flag', requireAdmin, async (req, res) => {
  try {
    const isTest = req.body?.is_test ? 1 : 0
    await dbRun('UPDATE companies SET is_test = ? WHERE id = ?', [isTest, req.params.id])
    res.json({ success: true, is_test: isTest === 1 })
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
    const ALLOWED = ['admin', 'gc', 'pro_gc', 'sub']
    if (!ALLOWED.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ALLOWED.join(', ')}` })
    }
    const current = await dbGet<{ role: string }>('SELECT role FROM users WHERE id = ?', [req.params.id])
    if (!current) return res.status(404).json({ error: 'User not found' })
    if (current.role === 'admin' && role !== 'admin') {
      const adminCount = await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")
      if ((adminCount?.count ?? 0) <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last admin' })
      }
    }
    await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id])
    if (role === 'pro_gc') {
      await dbRun("UPDATE companies SET plan = 'Pro GC', mrr = ? WHERE owner_user_id = ?", [planToMRR('Pro GC'), req.params.id])
    } else if (role === 'gc') {
      await dbRun("UPDATE companies SET plan = 'General Contractor', mrr = ? WHERE owner_user_id = ? AND plan = 'Pro GC'", [planToMRR('General Contractor'), req.params.id])
    }
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

// Demo controls are not safe in production, even for an authenticated admin.
function demoOnly(_req: any, res: any, next: any) {
  if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' })
  next()
}

// Reset entire database to fresh demo data (admin only, development only)
adminRouter.post('/danger/reset', demoOnly, requireAdmin, async (_req, res) => {
  try {
    const { seed } = await import('../seed.ts')
    await seed()
    res.json({ success: true, message: 'Database reset to demo data' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Development-only bootstrap: never create known demo credentials in production.
adminRouter.post('/bootstrap-seed', demoOnly, async (_req, res) => {
  try {
    const userCount = await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM users')
    if (Number(userCount?.count || 0) > 0) {
      return res.status(403).json({ error: 'Database is already seeded' })
    }
    const { seed } = await import('../seed.ts')
    await seed()
    res.json({ success: true, message: 'Database populated with demo data' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Development-only bootstrap. Admins must be provisioned by an operator in production.
adminRouter.post('/make-me-admin', demoOnly, requireAuth, async (req: AuthRequest, res) => {
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

// =========================================================================
// COI validation queue (admin-only)
// =========================================================================

type CoiRow = {
  id: string
  carrier: string
  am_best_rating?: string | null
  policy_number?: string | null
  effective_date: string
  expiration_date: string
  status: string
  reviewer_notes?: string | null
  review_date?: string | null
  created_at: string
  updated_at: string
  certificate_key?: string | null
  certificate_name?: string | null
  certificate_size?: number | null
  certificate_url?: string | null
  sub_company_name?: string | null
  trade?: string | null
  sub_email?: string | null
  gc_company_name?: string | null
  gc_email?: string | null
  details_json?: string | null
  source_tag?: string | null
}

function parseAnyDate(s?: string | null): Date | null {
  if (!s) return null
  const t = s.trim()
  const m1 = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m2 = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const y = m2[3].length === 2 ? Number(`20${m2[3]}`) : Number(m2[3])
    const d = new Date(y, Number(m2[1]) - 1, Number(m2[2]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

// List COIs for validation triage. Default filter: pending_review status.
adminRouter.get('/cois', requireAdmin, async (req, res) => {
  try {
    const { status: qStatus, filter: qFilter, search, limit = '200', offset = '0' } = req.query as Record<string, string>
    const filter = (qFilter ?? qStatus) || 'pending'
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter === 'pending') {
      clauses.push("c.status = 'pending_review'")
    } else if (filter === 'ai_checked') {
      clauses.push('r.details_json IS NOT NULL')
    } else if (filter === 'ai_pending') {
      clauses.push("r.details_json IS NOT NULL AND c.status = 'pending_review'")
    } else if (filter && filter !== 'all') {
      clauses.push('c.status = ?')
      params.push(filter)
    }
    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`
      clauses.push("(LOWER(COALESCE(s.company_name, '')) LIKE ? OR LOWER(COALESCE(s.trade, '')) LIKE ? OR LOWER(COALESCE(c.carrier, '')) LIKE ? OR LOWER(COALESCE(c.policy_number, '')) LIKE ? OR LOWER(COALESCE(gc.name, '')) LIKE ?)")
      params.push(q, q, q, q, q)
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
    const lim = Math.min(Number(limit) || 200, 500)
    const off = Math.max(Number(offset) || 0, 0)
    const rows = await dbAll<CoiRow>(
      `SELECT c.id, c.carrier, c.am_best_rating, c.policy_number, c.effective_date, c.expiration_date,
              c.status, c.reviewer_notes, c.review_date, c.created_at, c.updated_at,
              c.certificate_key, c.certificate_name, c.certificate_size, c.certificate_url,
              s.company_name AS sub_company_name, s.trade, s.email AS sub_email,
              gc.name AS gc_company_name, u_gc.email AS gc_email,
              r.details_json, r.source_tag
       FROM cois c
       LEFT JOIN subcontractors s ON s.id = c.subcontractor_id
       LEFT JOIN companies gc ON gc.owner_user_id = c.owner_gc_user_id
       LEFT JOIN users u_gc ON u_gc.id = c.owner_gc_user_id
       LEFT JOIN coi_field_reviews r ON r.coi_id = c.id
       ${where}
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, off],
    )
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const items = rows.map((r) => {
      let reviewSource: 'ocr' | 'mixed' | 'manual' | null = null
      let reviewInsured: string | null = null
      let reviewProducer: string | null = null
      let reviewPolicies = 0
      let reviewLimits = 0
      let parsedReview: unknown = null
      if (r.details_json) {
        try {
          const d = JSON.parse(r.details_json)
          parsedReview = d
          reviewSource = d.source || null
          reviewInsured = d.insured?.name || null
          reviewProducer = d.producer?.name || null
          reviewPolicies = Array.isArray(d.policies) ? d.policies.length : 0
          reviewLimits = Array.isArray(d.policies)
            ? d.policies.reduce((a: number, p: any) => a + (Array.isArray(p.limits) ? p.limits.length : 0), 0)
            : 0
        } catch {}
      }
      const exp = parseAnyDate(r.expiration_date)
      const daysLeft = exp ? Math.ceil((exp.getTime() - today.getTime()) / 86400000) : null
      return {
        id: r.id,
        carrier: r.carrier,
        am_best_rating: r.am_best_rating,
        policy_number: r.policy_number,
        effective_date: r.effective_date,
        expiration_date: r.expiration_date,
        days_left: daysLeft,
        status: r.status,
        reviewer_notes: r.reviewer_notes,
        review_date: r.review_date,
        created_at: r.created_at,
        updated_at: r.updated_at,
        sub_company_name: r.sub_company_name,
        trade: r.trade,
        sub_email: r.sub_email,
        gc_company_name: r.gc_company_name,
        gc_email: r.gc_email,
        has_file: Boolean(r.certificate_key),
        file_name: r.certificate_name,
        file_size: r.certificate_size,
        review_source: reviewSource,
        review_insured: reviewInsured,
        review_producer: reviewProducer,
        review_policy_count: reviewPolicies,
        review_limit_count: reviewLimits,
        ai_pending: reviewSource === 'ocr' || reviewSource === 'mixed',
        insurer_is_parent: isHoldingCompany(r.carrier),
        insured_match: (() => {
          const ins = normCompany(reviewInsured); const sub = normCompany(r.sub_company_name)
          return ins && sub ? (ins === sub || ins.includes(sub) || sub.includes(ins)) : null
        })(),
        review_details: parsedReview,
      }
    })
    const [cntPending, cntCompliant, cntRevision, cntRejected, cntNoFile, cntAiPending] = await Promise.all([
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'pending_review'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'compliant'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'needs_revision'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'rejected'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE certificate_key IS NULL OR certificate_key = ''"),
      dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM coi_field_reviews WHERE details_json IS NOT NULL'),
    ])
    const cntAll = { c: Number(cntPending?.c || 0) + Number(cntCompliant?.c || 0) + Number(cntRevision?.c || 0) + Number(cntRejected?.c || 0) }
    res.json({
      items,
      counts: {
        pending: Number(cntPending?.c || 0),
        all: Number(cntAll?.c || 0),
        compliant: Number(cntCompliant?.c || 0),
        needs_revision: Number(cntRevision?.c || 0),
        rejected: Number(cntRejected?.c || 0),
        no_file: Number(cntNoFile?.c || 0),
        ai_pending: Number(cntAiPending?.c || 0),
      },
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Mark a COI as validated (compliant) and human-verified
adminRouter.post('/cois/:id/validate', requireAdmin, async (req, res) => {
  try {
    const { notes } = req.body || {}
    const now = new Date().toISOString()
    const target = await dbGet<CoiRow>('SELECT * FROM cois WHERE id = ?', [req.params.id])
    if (!target) return res.status(404).json({ error: 'COI not found' })
    await dbRun(
      `UPDATE cois SET status = 'compliant', review_date = ?, reviewer_notes = COALESCE(?, reviewer_notes), updated_at = ?
       WHERE id = ?`,
      [now, notes ?? null, now, req.params.id],
    )
    const rev = await dbGet<{ details_json: string }>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [req.params.id])
    if (rev?.details_json) {
      try {
        const d = JSON.parse(rev.details_json)
        if (d.source === 'ocr' || d.source === 'mixed') {
          d.source = 'manual'
          await dbRun('UPDATE coi_field_reviews SET details_json = ? WHERE coi_id = ?', [JSON.stringify(d), req.params.id])
          await dbRun(
            `INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)
             ON CONFLICT(coi_id) DO UPDATE SET revision = excluded.revision`,
            [req.params.id, randomUUID()],
          )
        }
      } catch {}
    }
    const coi = await dbGet<CoiRow>('SELECT * FROM cois WHERE id = ?', [req.params.id])
    res.json({ coi })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Trigger AI extraction/validation on a COI
adminRouter.post('/cois/:id/extract', requireAdmin, async (req, res) => {
  try {
    const target = await dbGet<CoiRow>('SELECT * FROM cois WHERE id = ?', [req.params.id])
    if (!target) return res.status(404).json({ error: 'COI not found' })
    if (!target.certificate_key) return res.status(400).json({ error: 'This certificate has no stored file to extract' })
    const { getFileBuffer } = await import('../services/storage.ts')
    const { tryAnalyzeCoiDocument, isOcrConfigured } = await import('../services/aiExtract.ts')
    if (!isOcrConfigured) return res.status(503).json({ error: 'AI extraction service is not configured (OPENAI_API_KEY missing)' })
    const buffer = await getFileBuffer(target.certificate_key)
    if (!buffer) return res.status(502).json({ error: 'Could not fetch the stored certificate' })
    const { normalizeImage, isTextractCompatible } = await import('../services/imageFormat.ts')
    const norm = await normalizeImage(buffer)
    if (!norm || !isTextractCompatible(norm.mime)) return res.status(400).json({ error: 'Unsupported file format' })
    const r = await tryAnalyzeCoiDocument(norm.buffer)
    if (!r.ok || !r.fields) return res.status(502).json({ error: r.error || 'The AI could not extract fields from this document' })
    const { saveExtractedReview } = await import('./coiFields.ts')
    const ok = await saveExtractedReview(target.id, target.certificate_key, r.fields)
    if (!ok) return res.status(500).json({ error: 'Could not save the extracted fields — please try again' })
    res.json({ success: true, fields: r.fields })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Set arbitrary status (needs_revision, rejected, pending_review, compliant)
adminRouter.put('/cois/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body || {}
    if (!['compliant', 'needs_revision', 'rejected', 'pending_review'].includes(status)) {
      return res.status(400).json({ error: 'status must be compliant, needs_revision, rejected, or pending_review' })
    }
    const now = new Date().toISOString()
    const target = await dbGet<CoiRow>('SELECT * FROM cois WHERE id = ?', [req.params.id])
    if (!target) return res.status(404).json({ error: 'COI not found' })
    await dbRun(
      `UPDATE cois SET status = ?, review_date = ?, reviewer_notes = COALESCE(?, reviewer_notes), updated_at = ?
       WHERE id = ?`,
      [status, now, notes ?? null, now, req.params.id],
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Get a short-lived view URL for the certificate file
adminRouter.get('/cois/:id/certificate-url', requireAdmin, async (req, res) => {
  try {
    const target = await dbGet<CoiRow>('SELECT certificate_key FROM cois WHERE id = ?', [req.params.id])
    if (!target?.certificate_key) return res.status(404).json({ error: 'No certificate file for this COI' })
    const { getFileViewUrl } = await import('../services/storage.ts')
    const url = await getFileViewUrl(target.certificate_key)
    res.json({ url })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Batch validate up to 50 COIs
adminRouter.post('/cois/batch-validate', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' })
    const slice = ids.slice(0, 50)
    const now = new Date().toISOString()
    for (const id of slice) {
      await dbRun(`UPDATE cois SET status = 'compliant', review_date = ?, updated_at = ? WHERE id = ?`, [now, now, id])
      try {
        const rev = await dbGet<{ details_json: string }>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [id])
        if (rev?.details_json) {
          const d = JSON.parse(rev.details_json)
          if (d.source === 'ocr' || d.source === 'mixed') {
            d.source = 'manual'
            await dbRun('UPDATE coi_field_reviews SET details_json = ? WHERE coi_id = ?', [JSON.stringify(d), id])
            await dbRun(
              `INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)
               ON CONFLICT(coi_id) DO UPDATE SET revision = excluded.revision`,
              [id, randomUUID()],
            )
          }
        }
      } catch {}
    }
    res.json({ validated: slice.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Batch AI extract up to 10 COIs
adminRouter.post('/cois/batch-extract', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body || {}
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' })
    const slice = ids.slice(0, 10)
    const { getFileBuffer } = await import('../services/storage.ts')
    const { tryAnalyzeCoiDocument, isOcrConfigured } = await import('../services/aiExtract.ts')
    if (!isOcrConfigured) return res.status(503).json({ error: 'AI extraction service is not configured' })
    const { normalizeImage, isTextractCompatible } = await import('../services/imageFormat.ts')
    const { saveExtractedReview } = await import('./coiFields.ts')
    const results: Array<{ id: string; ok: boolean; error?: string }> = []
    for (const id of slice) {
      try {
        const target = await dbGet<CoiRow>('SELECT certificate_key FROM cois WHERE id = ?', [id])
        if (!target?.certificate_key) { results.push({ id, ok: false, error: 'no file' }); continue }
        const buffer = await getFileBuffer(target.certificate_key)
        if (!buffer) { results.push({ id, ok: false, error: 'file fetch failed' }); continue }
        const norm = await normalizeImage(buffer)
        if (!norm || !isTextractCompatible(norm.mime)) { results.push({ id, ok: false, error: 'unsupported format' }); continue }
        const r = await tryAnalyzeCoiDocument(norm.buffer)
        if (!r.ok || !r.fields) { results.push({ id, ok: false, error: r.error || 'extraction failed' }); continue }
        const ok = await saveExtractedReview(id, target.certificate_key, r.fields)
        results.push({ id, ok: Boolean(ok) })
      } catch (e: any) {
        results.push({ id, ok: false, error: e?.message || 'failed' })
      }
    }
    res.json({ results })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Dedicated COI review screen data
adminRouter.get('/cois/:id/review', requireAdmin, async (req, res) => {
  try {
    const row = await dbGet<any>(
      `SELECT c.*, s.company_name AS sub_company_name, s.trade, s.email AS sub_email,
              gc.name AS gc_company_name, u_gc.email AS gc_email
       FROM cois c
       LEFT JOIN subcontractors s ON s.id = c.subcontractor_id
       LEFT JOIN companies gc ON gc.owner_user_id = c.owner_gc_user_id
       LEFT JOIN users u_gc ON u_gc.id = c.owner_gc_user_id
       WHERE c.id = ?`,
      [req.params.id],
    )
    if (!row) return res.status(404).json({ error: 'COI not found' })
    let extracted: any = null
    const rev = await dbGet<{ details_json: string; source_tag: string }>(
      'SELECT details_json, source_tag FROM coi_field_reviews WHERE coi_id = ?',
      [row.id],
    )
    if (rev?.details_json) try { extracted = JSON.parse(rev.details_json) } catch {}
    const { getFileViewUrl } = await import('../services/storage.ts')
    let certUrl: string | null = null; if (row.certificate_key) { try { certUrl = await getFileViewUrl(row.certificate_key, 600) } catch {} }
    const checks: Array<{ name: string; value: string; result: 'pass' | 'warn' | 'fail' }> = []
    const insNorm = normCompany(extracted?.insured?.name)
    const subNorm = normCompany(row.sub_company_name)
    const insMatch = insNorm && subNorm ? (insNorm === subNorm || insNorm.includes(subNorm) || subNorm.includes(insNorm)) : null
    checks.push({
      name: 'Insured matches subcontractor',
      value: extracted?.insured?.name ? `${extracted.insured.name} · ${row.sub_company_name}` : 'No insured name extracted',
      result: insMatch === null ? 'warn' : insMatch ? 'pass' : 'fail',
    })
    const isParent = isHoldingCompany(row.carrier)
    checks.push({
      name: 'Issuing insurer',
      value: row.carrier || '—',
      result: isParent ? 'warn' : row.carrier ? 'pass' : 'fail',
    })
    const exp = parseAnyDate(row.expiration_date)
    const eff = parseAnyDate(row.effective_date)
    const daysLeft = exp ? Math.ceil((exp.getTime() - Date.now()) / 86400000) : null
    checks.push({
      name: 'Policy dates',
      value: `${row.effective_date || '—'} → ${row.expiration_date || '—'}`,
      result: !exp ? 'fail' : daysLeft! < 0 ? 'fail' : daysLeft! <= 30 ? 'warn' : 'pass',
    })
    const limits = (extracted?.policies || []).flatMap((p: any) => p.limits || [])
    checks.push({
      name: 'Limits stated',
      value: limits.length ? `${limits.length} limit line${limits.length > 1 ? 's' : ''}` : 'No limits extracted',
      result: limits.length ? 'pass' : 'warn',
    })
    const passes = checks.filter((c) => c.result === 'pass').length
    const fails = checks.filter((c) => c.result === 'fail').length
    const score = Math.max(0, Math.min(100, Math.round((passes / Math.max(1, checks.length)) * 100) - fails * 10))
    res.json({ coi: row, extracted, certUrl, checks, score })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
adminRouter.post('/cois/:id/decision', requireAdmin, async (req, res) => {
  try {
    const { decision, notes } = req.body || {}
    if (!['compliant', 'needs_revision', 'rejected'].includes(decision))
      return res.status(400).json({ error: 'Invalid decision' })
    await dbRun(
      `UPDATE cois SET status = ?, reviewer_notes = ?, review_date = ? WHERE id = ?`,
      [decision, notes || null, new Date().toISOString().slice(0, 10), req.params.id],
    )
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
