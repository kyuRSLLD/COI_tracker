import express from 'express'; const Router = express.Router
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { sendEmail, buildCOIRequestEmail, buildExpirationReminderEmail } from '../services/email.ts'
import { daysUntil } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'

export const emailsRouter = Router()

emailsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const logs = await dbAll('SELECT * FROM email_logs ORDER BY sent_at DESC LIMIT 100')
    res.json({ logs })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Send (simulate) a COI request with a magic upload link
emailsRouter.post('/send-request', requireAuth, async (req, res) => {
  try {
    const { subcontractor_id, custom_message, expires_in_days } = req.body || {}
    const sub = await dbGet('SELECT * FROM subcontractors WHERE id = ?', [subcontractor_id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })

    const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}
    const token = crypto.randomBytes(24).toString('hex')
    const id = crypto.randomUUID()
    const now = new Date()
    let expiresAt: string | null = null
    const days = Number(expires_in_days) || 30
    const d = new Date()
    d.setDate(d.getDate() + days)
    expiresAt = d.toISOString()

    await dbRun(
      `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, subcontractor_id, token, req.body.requested_by_email || gcSettings.email || 'gc@company.com', custom_message || null, expiresAt, now.toISOString()]
    )

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    const portalUrl = `${clientUrl}/upload/${token}`
    const requiredCoverages = [
      gcSettings.required_gl_limit && `• General Liability: ${gcSettings.required_gl_limit}`,
      gcSettings.required_auto_limit && `• Auto Liability: ${gcSettings.required_auto_limit}`,
      gcSettings.required_wc_limit && `• Workers' Compensation: ${gcSettings.required_wc_limit}`,
      gcSettings.required_umbrella_limit && `• Umbrella / Excess: ${gcSettings.required_umbrella_limit}`,
    ].filter(Boolean).join('\n') || '• General Liability ($1M/$2M), Auto ($1M), Workers\' Comp (Statutory)'

    const mail = buildCOIRequestEmail({
      subName: sub.company_name,
      contactName: sub.contact_person,
      gcCompany: gcSettings.company_name || 'Apex Construction Group',
      portalUrl,
      requiredCoverages,
      warningDays: gcSettings.expiration_warning_days || 30,
    })

    const result = await sendEmail({
      to: sub.email || 'subcontractor@example.com',
      subject: mail.subject,
      body: custom_message ? `${custom_message}\n\n${mail.body}` : mail.body,
      type: 'coi_request',
    })

    res.status(201).json({
      success: true,
      email: result,
      token,
      portalUrl,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Send expiration reminder for a specific COI
emailsRouter.post('/send-reminder', requireAuth, async (req, res) => {
  try {
    const { coi_id, custom_message } = req.body || {}
    const coi = await dbGet(
      `SELECT c.*, s.company_name, s.email, s.contact_person
       FROM cois c
       JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.id = ?`,
      [coi_id]
    )
    if (!coi) return res.status(404).json({ error: 'COI not found' })

    const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}
    const daysLeft = daysUntil(coi.expiration_date) ?? 0

    // create or reuse an upload token for the sub
    let reqRow = await dbGet(
      'SELECT token FROM upload_requests WHERE subcontractor_id = ? AND used = 0 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1',
      [coi.subcontractor_id, new Date().toISOString()]
    )
    let token: string
    if (reqRow) {
      token = reqRow.token
    } else {
      token = crypto.randomBytes(24).toString('hex')
      const id = crypto.randomUUID()
      const d = new Date()
      d.setDate(d.getDate() + 30)
      await dbRun(
        `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, expires_at, used, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [id, coi.subcontractor_id, token, gcSettings.email || 'gc@company.com', d.toISOString(), new Date().toISOString()]
      )
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173'
    const portalUrl = `${clientUrl}/upload/${token}`

    const mail = buildExpirationReminderEmail({
      subName: coi.company_name,
      policyType: `${coi.carrier} (${coi.policy_number || 'policy'})`,
      expirationDate: coi.expiration_date,
      daysLeft,
      gcCompany: gcSettings.company_name || 'Apex Construction Group',
      portalUrl,
    })

    const result = await sendEmail({
      to: coi.email || 'subcontractor@example.com',
      subject: mail.subject,
      body: custom_message ? `${custom_message}\n\n${mail.body}` : mail.body,
      type: 'expiration_reminder',
    })

    res.json({ success: true, email: result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Batch send reminders to ALL subs expiring in ≤ 30 days
emailsRouter.post('/batch-reminders', requireAuth, async (req, res) => {
  try {
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + 30)
    const today = new Date().toISOString().slice(0, 10)
    const horizonStr = horizon.toISOString().slice(0, 10)

    const expiring = await dbAll(
      `SELECT DISTINCT c.id AS coi_id
       FROM cois c
       WHERE c.expiration_date >= ? AND c.expiration_date <= ? AND c.status != 'rejected'`,
      [today, horizonStr]
    )
    const results: any[] = []
    for (const row of expiring) {
      try {
        const fakeReq = { body: { coi_id: row.coi_id } } as any
        let out: any
        await (async () => {
          const coi = await dbGet(
            `SELECT c.*, s.company_name, s.email FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id WHERE c.id = ?`,
            [row.coi_id]
          )
          if (!coi) return
          const gcSettings = (await dbGet('SELECT * FROM gc_settings LIMIT 1')) || {}
          const daysLeft = daysUntil(coi.expiration_date) ?? 0
          const mail = buildExpirationReminderEmail({
            subName: coi.company_name,
            policyType: `${coi.carrier}`,
            expirationDate: coi.expiration_date,
            daysLeft,
            gcCompany: gcSettings.company_name || 'Apex Construction Group',
            portalUrl: `${process.env.CLIENT_URL || 'http://localhost:5173'}/upload/portal`,
          })
          out = await sendEmail({ to: coi.email || 'sub@example.com', subject: mail.subject, body: mail.body, type: 'expiration_reminder' })
        })()
        results.push(out)
      } catch {}
    }
    res.json({ success: true, sent: results.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
