import express from 'express'; const Router = express.Router
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, projectComplianceScore, isSimulatedCarrierCOI } from '../services/compliance.ts'

export const clientViewRouter = Router()

// Coverage fields are user-entered; do not forward arbitrary notes, identifiers,
// URLs, or free text through a public report.
const coverageTypes = new Set(['General Liability', 'Automobile Liability', "Workers' Compensation", 'Umbrella Liability'])
function safeLimit(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^(?:\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$?\d+(?:\.\d{1,2})?|Statutory)$/i.test(v) ? v : null
}
function safeDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null
}
function publicStatus(value: unknown): string {
  return typeof value === 'string' && ['compliant', 'expiring_soon', 'expired', 'missing', 'pending_review', 'needs_revision', 'rejected'].includes(value) ? value : 'pending_review'
}
function publicLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback
  const text = value.trim()
  const contactPattern = /(?:https?:\/\/|www\.|mailto:|tel:|\b[^\s@]+@[^\s@]+\b|\b[a-z0-9-]+\.[a-z]{2,63}\b)/i
  const phoneLike = text.match(/\+?\d[\d\s().-]{7,}\d/g) || []
  if (contactPattern.test(text) || phoneLike.some((part) => part.replace(/\D/g, '').length >= 10)) return fallback
  return text
}

// Public: possession of an unexpired share grants only a minimal report.
clientViewRouter.get('/:token', async (req, res) => {
  try {
    if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).json({ error: 'Share link not found or invalid' })
    const share = await dbGet('SELECT * FROM client_share_links WHERE token = ?', [req.params.token])
    if (!share) return res.status(404).json({ error: 'Share link not found or invalid' })
    if (share.expires_at && (!Number.isFinite(Date.parse(share.expires_at)) || Date.parse(share.expires_at) <= Date.now())) {
      return res.status(410).json({ error: 'This share link has expired. Please ask the contractor for a new link.' })
    }
    const project = await dbGet(`SELECT p.* FROM projects p JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND u.role = 'gc'`, [share.project_id])
    if (!project) return res.status(404).json({ error: 'Project no longer exists' })
    const gcSettings = (await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [project.user_id])) || {}
    const subs = await dbAll(`SELECT s.* FROM subcontractors s
      JOIN project_subcontractors ps ON ps.subcontractor_id = s.id
      WHERE ps.project_id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections c
        WHERE c.gc_user_id = ? AND c.subcontractor_id = s.id)`, [project.id, project.user_id])
    const rows = await Promise.all(subs.map(async (sub) => {
      const cois = await dbAll('SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC', [sub.id])
      const computed = computeSubcontractorStatus(sub, cois, 30)
      const summaries = await Promise.all(cois.map(async (coi) => {
        const simulated = isSimulatedCarrierCOI(coi)
        const rawCoverages = simulated ? [] : await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [coi.id])
        return {
          effective_date: safeDate(coi.effective_date),
          expiration_date: safeDate(coi.expiration_date),
          status: simulated ? 'pending_review' : publicStatus(coi.status),
          simulated_carrier_connect: simulated,
          coverages: rawCoverages.filter((c) => coverageTypes.has(c.type)).map((c) => ({
            type: c.type,
            per_occurrence_limit: safeLimit(c.per_occurrence_limit),
            aggregate_limit: safeLimit(c.aggregate_limit),
            additional_insured: c.additional_insured === 1 || c.additional_insured === true,
            waiver_of_subrogation: c.waiver_of_subrogation === 1 || c.waiver_of_subrogation === true,
          })),
        }
      }))
      return {
        scoreRow: { sub, cois },
        publicSub: {
          // An opaque alias is scoped to this share, not an API-accessible sub ID.
          id: crypto.createHmac('sha256', share.token).update(sub.id).digest('hex'),
          company_name: publicLabel(sub.company_name, 'Company name withheld'),
          trade: publicLabel(sub.trade, 'Trade withheld'),
          computed_status: computed.status,
          days_left: computed.daysLeft,
          best_coi: summaries[0] || null,
          cois: summaries,
        },
      }
    }))
    await dbRun('UPDATE client_share_links SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = ? WHERE id = ?', [new Date().toISOString(), share.id])
    res.set('Cache-Control', 'no-store')
    res.json({
      project: {
        name: project.name, code: project.code, address: project.address,
        client_name: project.client_name, start_date: project.start_date, end_date: project.end_date,
      },
      contractor: {
        company_name: gcSettings.company_name || 'General Contractor',
        license_number: gcSettings.license_number,
        phone: gcSettings.phone,
        email: gcSettings.email,
        address: gcSettings.address,
      },
      scorecard: projectComplianceScore(rows.map((row) => row.scoreRow)),
      subcontractors: rows.map((row) => row.publicSub),
      share: { expires_at: share.expires_at, created_at: share.created_at },
      generated_at: new Date().toISOString(),
    })
  } catch {
    res.status(500).json({ error: 'Unable to load client report' })
  }
})
