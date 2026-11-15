import express from 'express'
import { dbGet, dbAll, dbRun, planToMRR, PLAN_PRICES } from '../db/db.ts'
import { randomUUID } from 'crypto'
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
    const { status, filter = 'pending', search, limit = '200', offset = '0' } = req.query as Record<string, string>
    const clauses: string[] = []
    const params: unknown[] = []
    if (status && status !== 'all') {
      clauses.push('c.status = ?')
      params.push(status)
    } else if (filter === 'pending') {
      clauses.push("c.status = 'pending_review'")
    } else if (filter === 'ai_pending') {
      clauses.push('r.details_json IS NOT NULL')
    }
    if (search && search.trim()) {
      const q = `%${search.trim().toLowerCase()}%`
      clauses.push('(LOWER(COALESCE(s.company_name,"")) LIKE ? OR LOWER(COALESCE(s.trade,"")) LIKE ? OR LOWER(COALESCE(c.carrier,"")) LIKE ? OR LOWER(COALESCE(c.policy_number,"")) LIKE ? OR LOWER(COALESCE(gc.name,"")) LIKE ?)')
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
        review_details: parsedReview,
      }
    })
    const [cntPending, cntAll, cntCompliant, cntRevision, cntRejected, cntNoFile] = await Promise.all([
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'pending_review'"),
      dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM cois'),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'compliant'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'needs_revision'"),
      dbGet<{ c: number }>("SELECT COUNT(*) AS c FROM cois WHERE status = 'rejected'"),
      dbGet<{ c: number }>('SELECT COUNT(*) AS c FROM cois WHERE certificate_key IS NULL OR certificate_key = ""'),
    ])
    res.json({
      items,
      counts: {
        pending: Number(cntPending?.c || 0),
        all: Number(cntAll?.c || 0),
        compliant: Number(cntCompliant?.c || 0),
        needs_revision: Number(cntRevision?.c || 0),
        rejected: Number(cntRejected?.c || 0),
        no_file: Number(cntNoFile?.c || 0),
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
