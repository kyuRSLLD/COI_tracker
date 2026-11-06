import express from 'express'; const Router = express.Router
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { computeSubcontractorStatus, projectComplianceScore } from '../services/compliance.ts'
import { redactSubcontractorForClient } from '../middleware/redaction.ts'
import { getFileViewUrl } from '../services/storage.ts'

export const clientViewRouter = Router()

/**
 * PUBLIC endpoint — the Client Compliance Portal.
 * Anyone with the share token can view verified compliance for this project.
 *
 * PRIVACY GUARANTEE:
 * Subcontractor phone numbers, emails, contact persons, and addresses are
 * stripped by `redactSubcontractorForClient` before the response is sent.
 * Clients contact the GC (whose details are included), never the sub.
 */
clientViewRouter.get('/:token', async (req, res) => {
  try {
    const share = await dbGet('SELECT * FROM client_share_links WHERE token = ?', [req.params.token])
    if (!share) return res.status(404).json({ error: 'Share link not found or invalid' })

    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired. Please ask the contractor for a new link.' })
    }

    // record access
    await dbRun(
      'UPDATE client_share_links SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?',
      [new Date().toISOString(), share.id]
    )

    const project = await dbGet('SELECT * FROM projects WHERE id = ?', [share.project_id])
    if (!project) return res.status(404).json({ error: 'Project no longer exists' })

    const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}

    const subLinks = await dbAll('SELECT * FROM project_subcontractors WHERE project_id = ?', [project.id])
    const rows = await Promise.all(
      subLinks.map(async (l) => {
        const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [l.subcontractor_id])
        if (!sub) return null
        const cois = await dbAll(
          'SELECT * FROM cois WHERE subcontractor_id = ? ORDER BY expiration_date DESC',
          [sub.id]
        )
        const computed = computeSubcontractorStatus(sub, cois, 30)

        // Enrich approved COIs with coverages (redacted document links only)
        const enrichedCois = await Promise.all(
          cois.map(async (c) => {
            const coverages = await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [c.id])
            const viewUrl = c.certificate_key ? await getFileViewUrl(c.certificate_key, c.certificate_url) : null
            return {
              id: c.id,
              carrier: c.carrier,
              am_best_rating: c.am_best_rating,
              policy_number: c.policy_number,
              effective_date: c.effective_date,
              expiration_date: c.expiration_date,
              status: c.status,
              review_date: c.review_date,
              certificate_name: c.certificate_name,
              certificate_url: viewUrl || c.certificate_url,
              coverages,
            }
          })
        )

        return {
          ...redactSubcontractorForClient(sub),
          computed_status: computed.status,
          best_coi: computed.bestCOI ? {
            carrier: computed.bestCOI.carrier,
            am_best_rating: computed.bestCOI.am_best_rating,
            policy_number: computed.bestCOI.policy_number,
            effective_date: computed.bestCOI.effective_date,
            expiration_date: computed.bestCOI.expiration_date,
            status: computed.bestCOI.status,
          } : null,
          days_left: computed.daysLeft,
          cois: enrichedCois,
        }
      })
    )

    const validSubs = rows.filter(Boolean)
    const scorecard = projectComplianceScore(validSubs.map((s: any) => ({ sub: s, cois: s.cois })))

    // Public project payload — notice NO subcontractor contact data anywhere
    res.json({
      project: {
        id: project.id,
        name: project.name,
        code: project.code,
        address: project.address,
        client_name: project.client_name,
        start_date: project.start_date,
        end_date: project.end_date,
      },
      contractor: {
        company_name: gcSettings.company_name || 'General Contractor',
        license_number: gcSettings.license_number,
        phone: gcSettings.phone,
        email: gcSettings.email,
        address: gcSettings.address,
        logo_url: gcSettings.logo_url,
      },
      scorecard,
      subcontractors: validSubs,
      share: {
        token: share.token,
        expires_at: share.expires_at,
        created_at: share.created_at,
      },
      generated_at: new Date().toISOString(),
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
