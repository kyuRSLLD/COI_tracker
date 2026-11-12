import express from 'express'; const Router = express.Router
import crypto from 'crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { sendEmail, buildCOIRequestEmail, buildExpirationReminderEmail } from '../services/email.ts'
import { daysUntil } from '../services/compliance.ts'
import { requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'
import { gcSettingsForUser, makeScopedUploadToken } from './uploadPortal.ts'

export const emailsRouter = Router()

// A JWT's role can become stale; authorize against the current account as well.
async function currentGc(req: AuthRequest) {
  if (req.user?.role !== 'gc') return undefined
  return dbGet('SELECT id, email, company_name FROM users WHERE id = ? AND role = ?', [req.user.id, 'gc'])
}

async function connectedSub(gcId: string, subId: string) {
  return dbGet(
    `SELECT s.* FROM subcontractors s
     WHERE s.id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections c WHERE c.gc_user_id = ? AND c.subcontractor_id = s.id)`,
    [subId, gcId]
  )
}

async function connectedCoi(gcId: string, coiId: string) {
  return dbGet(
    `SELECT c.*, s.company_name, s.email, s.contact_person FROM cois c
     JOIN subcontractors s ON s.id = c.subcontractor_id
     WHERE c.id = ? AND EXISTS (SELECT 1 FROM gc_sub_connections x WHERE x.gc_user_id = ? AND x.subcontractor_id = s.id)
       AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))`,
    [coiId, gcId, gcId]
  )
}

async function createRequest(gc: any, subId: string, message: string | null, days: number) {
  const token = makeScopedUploadToken(gc.id)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + days * 86400000).toISOString()
  const inserted = await dbRun(
    `INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, message, expires_at, used, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 0, ?
     WHERE EXISTS (SELECT 1 FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?)
       AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'gc')`,
    [crypto.randomUUID(), subId, token, gc.email, message, expiresAt, now.toISOString(), gc.id, subId, gc.id]
  )
  if (inserted.changes !== 1) throw new Error('Connection no longer available')
  return token
}

function portalUrl(token: string) {
  return `${(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '')}/upload/${token}`
}

// Logs have no owner column. Recipient matching alone cannot distinguish GCs
// sharing a sub, and bodies may contain private links, so do not expose them.
emailsRouter.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!await currentGc(req)) return res.status(403).json({ error: 'General contractor access required' })
    res.json({ logs: [], message: 'Email logs cannot be safely attributed to a contractor in the legacy schema.' })
  } catch {
    res.status(500).json({ error: 'Unable to load email logs' })
  }
})

emailsRouter.post('/send-request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await currentGc(req)
    if (!gc) return res.status(403).json({ error: 'General contractor access required' })
    const { subcontractor_id, custom_message, expires_in_days } = req.body || {}
    const sub = await connectedSub(gc.id, subcontractor_id)
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })
    const days = expires_in_days == null ? 30 : Number(expires_in_days)
    if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'Expiry must be between 1 and 365 days' })
    const gcSettings = await gcSettingsForUser(gc)
    if (!gcSettings) return res.status(409).json({ error: 'Contractor settings are ambiguous' })
    const token = await createRequest(gc, sub.id, custom_message || null, days)
    const url = portalUrl(token)
    const requiredCoverages = [
      gcSettings.required_gl_limit && `• General Liability: ${gcSettings.required_gl_limit}`,
      gcSettings.required_auto_limit && `• Auto Liability: ${gcSettings.required_auto_limit}`,
      gcSettings.required_wc_limit && `• Workers' Compensation: ${gcSettings.required_wc_limit}`,
      gcSettings.required_umbrella_limit && `• Umbrella / Excess: ${gcSettings.required_umbrella_limit}`,
    ].filter(Boolean).join('\n') || '• General Liability ($1M/$2M), Auto ($1M), Workers\' Comp (Statutory)'
    const mail = buildCOIRequestEmail({ subName: sub.company_name, contactName: sub.contact_person,
      gcCompany: gcSettings.company_name || 'General Contractor', portalUrl: url, requiredCoverages,
      warningDays: gcSettings.expiration_warning_days || 30 })
    const result = await sendEmail({ to: sub.email || 'subcontractor@example.com', subject: mail.subject,
      body: custom_message ? `${custom_message}\n\n${mail.body}` : mail.body, type: 'coi_request' })
    res.status(201).json({ success: true, email: result, token, portalUrl: url,
      delivered: result.status === 'sent', message: result.status === 'simulated' ? 'Link created; email was simulated and not delivered.' : undefined })
  } catch {
    res.status(500).json({ error: 'Unable to create upload request' })
  }
})

// Always make a new scoped token: an old token may belong to another GC.
async function simulateReminder(gc: any, gcSettings: any, coi: any, customMessage?: string) {
  const token = await createRequest(gc, coi.subcontractor_id, null, 30)
  const mail = buildExpirationReminderEmail({ subName: coi.company_name,
    policyType: `${coi.carrier} (${coi.policy_number || 'policy'})`, expirationDate: coi.expiration_date,
    daysLeft: daysUntil(coi.expiration_date) ?? 0, gcCompany: gcSettings.company_name || 'General Contractor',
    portalUrl: portalUrl(token) })
  return sendEmail({ to: coi.email || 'subcontractor@example.com', subject: mail.subject,
    body: customMessage ? `${customMessage}\n\n${mail.body}` : mail.body, type: 'expiration_reminder' })
}

emailsRouter.post('/send-reminder', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await currentGc(req)
    if (!gc) return res.status(403).json({ error: 'General contractor access required' })
    const coi = await connectedCoi(gc.id, req.body?.coi_id)
    if (!coi) return res.status(404).json({ error: 'COI not found' })
    const settings = await gcSettingsForUser(gc)
    if (!settings) return res.status(409).json({ error: 'Contractor settings are ambiguous' })
    const result = await simulateReminder(gc, settings, coi, req.body?.custom_message)
    if (result.status !== 'sent') return res.status(503).json({ success: false, email: result, delivered: false,
      error: 'Reminder was simulated and not delivered.' })
    res.json({ success: true, email: result, delivered: true })
  } catch {
    res.status(500).json({ error: 'Unable to create reminder' })
  }
})

emailsRouter.post('/batch-reminders', requireAuth, async (req: AuthRequest, res) => {
  try {
    const gc = await currentGc(req)
    if (!gc) return res.status(403).json({ error: 'General contractor access required' })
    const settings = await gcSettingsForUser(gc)
    if (!settings) return res.status(409).json({ error: 'Contractor settings are ambiguous' })
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    const horizon = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10)
    const expiring = await dbAll(
      `SELECT c.id AS coi_id FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.expiration_date >= ? AND c.expiration_date <= ? AND c.status != 'rejected'
       AND EXISTS (SELECT 1 FROM gc_sub_connections x WHERE x.gc_user_id = ? AND x.subcontractor_id = s.id)
       AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))`,
      [today, horizon, gc.id, gc.id]
    )
    let sent = 0, simulated = 0, failed = 0
    for (const row of expiring) {
      try {
        // Recheck connection immediately before each reminder.
        const coi = await connectedCoi(gc.id, row.coi_id)
        if (!coi) { failed++; continue }
        const result = await simulateReminder(gc, settings, coi)
        if (result.status === 'sent') sent++
        else if (result.status === 'simulated') simulated++
        else failed++
      } catch { failed++ }
    }
    if (simulated || failed) return res.status(503).json({ success: false, sent, simulated, failed,
      error: 'Some reminders were simulated or failed; simulated emails were not delivered.' })
    res.json({ success: true, sent, simulated, failed })
  } catch {
    res.status(500).json({ error: 'Unable to create reminders' })
  }
})
