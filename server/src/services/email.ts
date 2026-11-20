import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun } from '../db/db.ts'
import nodemailer from 'nodemailer'

export interface EmailPayload {
  to: string
  subject: string
  body: string
  html?: string
  type?: 'coi_request' | 'expiration_reminder' | 'revision_request' | 'general' | 'test'
}

export type EmailProvider = 'gmail' | 'smtp' | 'postmark' | 'sendgrid' | 'simulated'

export interface EmailSettings {
  id: string
  provider: EmailProvider
  from_name: string | null
  from_email: string | null
  reply_to: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_secure: number | null
  smtp_user: string | null
  smtp_pass: string | null
  sending_enabled: number
  last_test_to: string | null
  last_test_at: string | null
  last_test_status: string | null
  last_test_error: string | null
  created_at: string
  updated_at: string
}

let cachedSettings: { data: EmailSettings; at: number } | null = null
const CACHE_TTL_MS = 30_000

export async function getEmailSettings(): Promise<EmailSettings> {
  if (cachedSettings && Date.now() - cachedSettings.at < CACHE_TTL_MS) {
    return cachedSettings.data
  }
  const row = await dbGet<EmailSettings>('SELECT * FROM email_settings WHERE id = ?', ['default'])
  if (row) {
    cachedSettings = { data: row, at: Date.now() }
    return row
  }
  const now = new Date().toISOString()
  return {
    id: 'default',
    provider: 'gmail',
    from_name: 'Capital Restoration',
    from_email: 'backoffice@capitalcrestoration.com',
    reply_to: null,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_secure: 0,
    smtp_user: null,
    smtp_pass: null,
    sending_enabled: 0,
    last_test_to: null,
    last_test_at: null,
    last_test_status: null,
    last_test_error: null,
    created_at: now,
    updated_at: now,
  }
}

export function invalidateEmailSettingsCache(): void {
  cachedSettings = null
  smtpTransporter = null
}

export async function saveEmailSettings(patch: {
  provider?: EmailProvider
  from_name?: string | null
  from_email?: string | null
  reply_to?: string | null
  smtp_host?: string | null
  smtp_port?: number | null
  smtp_secure?: number | null
  smtp_user?: string | null
  smtp_pass?: string | null
  sending_enabled?: number
}): Promise<EmailSettings> {
  const current = await getEmailSettings()
  const next: EmailSettings = {
    ...current,
    provider: patch.provider ?? current.provider,
    from_name: patch.from_name !== undefined ? patch.from_name : current.from_name,
    from_email: patch.from_email !== undefined ? patch.from_email : current.from_email,
    reply_to: patch.reply_to !== undefined ? patch.reply_to : current.reply_to,
    smtp_host: patch.smtp_host !== undefined ? patch.smtp_host : current.smtp_host,
    smtp_port: patch.smtp_port !== undefined ? patch.smtp_port : current.smtp_port,
    smtp_secure: patch.smtp_secure !== undefined ? patch.smtp_secure : current.smtp_secure,
    smtp_user: patch.smtp_user !== undefined ? patch.smtp_user : current.smtp_user,
    smtp_pass: patch.smtp_pass !== undefined ? patch.smtp_pass : current.smtp_pass,
    sending_enabled: patch.sending_enabled !== undefined ? (patch.sending_enabled ? 1 : 0) : current.sending_enabled,
    updated_at: new Date().toISOString(),
  }
  await dbRun(
    `UPDATE email_settings SET
       provider = ?, from_name = ?, from_email = ?, reply_to = ?,
       smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_pass = ?,
       sending_enabled = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.provider,
      next.from_name,
      next.from_email,
      next.reply_to,
      next.smtp_host,
      next.smtp_port,
      next.smtp_secure,
      next.smtp_user,
      next.smtp_pass,
      next.sending_enabled,
      next.updated_at,
      'default',
    ]
  )
  invalidateEmailSettingsCache()
  return getEmailSettings()
}

export function emailMode(): EmailProvider {
  const p = cachedSettings?.data?.provider
  if (p && p !== 'simulated') return p
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp'
  if (process.env.POSTMARK_SERVER_TOKEN) return 'postmark'
  if (process.env.SENDGRID_API_KEY) return 'sendgrid'
  return p || 'simulated'
}

export function isRealEmailConfigured(): boolean {
  const mode = emailMode()
  if (mode === 'simulated') return false
  if (mode === 'postmark') return Boolean(process.env.POSTMARK_SERVER_TOKEN)
  if (mode === 'sendgrid') return Boolean(process.env.SENDGRID_API_KEY)
  const cfg = cachedSettings?.data
  return Boolean((cfg?.smtp_pass && cfg.smtp_pass.length > 0) || process.env.SMTP_PASS)
}

let smtpTransporter: any | null = null

function getSmtpTransporter(cfg: EmailSettings): any {
  if (!smtpTransporter) {
    const isGmail = cfg.provider === 'gmail'
    const host = isGmail ? 'smtp.gmail.com' : (cfg.smtp_host || process.env.SMTP_HOST || 'smtp.gmail.com')
    const port = isGmail ? 587 : (cfg.smtp_port || Number(process.env.SMTP_PORT) || 587)
    const secure = isGmail ? false : (cfg.smtp_secure === 1 || process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true')
    const user = cfg.smtp_user || (isGmail ? (cfg.from_email || '') : (cfg.smtp_user || process.env.SMTP_USER || ''))
    const pass = cfg.smtp_pass || process.env.SMTP_PASS || ''
    smtpTransporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    })
  }
  return smtpTransporter
}

function fromAddress(cfg: EmailSettings): string {
  if (cfg.from_email) {
    return cfg.from_name ? `${cfg.from_name} <${cfg.from_email}>` : cfg.from_email
  }
  return process.env.FROM_EMAIL || 'SafeCOI <notifications@safecoi.com>'
}

async function deliver(to: string, subject: string, body: string, html?: string, forceReal = false): Promise<string> {
  const cfg = await getEmailSettings()
  if (!forceReal && !cfg.sending_enabled && cfg.provider !== 'simulated') {
    console.log(`[email:paused] master switch OFF -> ${to} | ${subject} (body skipped)`)
    return 'simulated'
  }
  const mode = cfg.provider
  if (mode === 'gmail' || mode === 'smtp') {
    const from = fromAddress(cfg)
    const info = await getSmtpTransporter(cfg).sendMail({
      from,
      to,
      subject,
      text: body,
      ...(html ? { html } : {}),
      ...(cfg.reply_to ? { replyTo: cfg.reply_to } : {}),
    })
    console.log(`[email:${mode}] sent -> ${to} | ${subject} (${info.messageId})`)
    return 'sent'
  }
  if (mode === 'postmark') {
    const from = fromAddress(cfg)
    const token = process.env.POSTMARK_SERVER_TOKEN
    if (!token) throw new Error('Postmark is not configured (missing POSTMARK_SERVER_TOKEN)')
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        TextBody: body,
        ...(html ? { HtmlBody: html } : {}),
        MessageStream: process.env.POSTMARK_STREAM || 'outbound',
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Postmark email failed (${res.status}): ${err.slice(0, 300)}`)
    }
    console.log(`[email:postmark] sent -> ${to} | ${subject}`)
    return 'sent'
  }
  if (mode === 'sendgrid') {
    const from = fromAddress(cfg)
    const key = process.env.SENDGRID_API_KEY
    if (!key) throw new Error('SendGrid is not configured (missing SENDGRID_API_KEY)')
    const fromEmail = from.replace(/^.*<|>$/g, '').trim()
    const fromName = from.includes('<') ? from.replace(/<.*>$/, '').trim() : undefined
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`SendGrid email failed (${res.status}): ${err.slice(0, 300)}`)
    }
    console.log(`[email:sendgrid] sent -> ${to} | ${subject}`)
    return 'sent'
  }
  console.log(`[email:simulated] -> ${to} | ${subject}`)
  return 'simulated'
}

export async function sendEmail({
  to,
  subject,
  body,
  html,
  type = 'general',
}: EmailPayload): Promise<{ id: string; status: string }> {
  const id = uuidv4()
  const now = new Date().toISOString()
  try {
    const status = await deliver(to, subject, body, html, type === 'test')
    await dbRun(
      `INSERT INTO email_logs (id, to_email, subject, body, type, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, to, subject, body, type, status, now]
    )
    return { id, status }
  } catch (err: any) {
    await dbRun(
      `INSERT INTO email_logs (id, to_email, subject, body, type, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, to, subject, body, type, 'failed', now]
    ).catch(() => {})
    throw err
  }
}

export async function sendTestEmail(to: string): Promise<{ ok: boolean; status: string; error?: string }> {
  const now = new Date().toISOString()
  try {
    const cfg = await getEmailSettings()
    const from = fromAddress(cfg)
    const result = await sendEmail({
      to,
      subject: `[SafeCOI] Email test from ${from}`,
      body: `This is a test email sent from SafeCOI using the configured sender: ${from}. If you received this, the outgoing mail connection is working.`,
      type: 'test',
    })
    await dbRun(
      `UPDATE email_settings SET last_test_to = ?, last_test_at = ?, last_test_status = ?, last_test_error = NULL, updated_at = ? WHERE id = ?`,
      [to, now, result.status, now, 'default']
    )
    invalidateEmailSettingsCache()
    return { ok: true, status: result.status }
  } catch (err: any) {
    await dbRun(
      `UPDATE email_settings SET last_test_to = ?, last_test_at = ?, last_test_status = 'failed', last_test_error = ?, updated_at = ? WHERE id = ?`,
      [to, now, String(err?.message || err).slice(0, 400), now, 'default']
    )
    invalidateEmailSettingsCache()
    return { ok: false, status: 'failed', error: err?.message || String(err) }
  }
}

export function buildCOIRequestEmail(params: {
  subName: string
  contactName?: string
  gcCompany: string
  portalUrl: string
  requiredCoverages: string
  warningDays: number
}): { subject: string; body: string } {
  const greeting = params.contactName ? `Hi ${params.contactName},` : `Hi ${params.subName} team,`
  return {
    subject: `Certificate of Insurance request from ${params.gcCompany}`,
    body: `${greeting}

${params.gcCompany} needs an updated Certificate of Insurance (COI) for our records. Please click the secure link below to upload your current policy documents — it takes about 2 minutes:

${params.portalUrl}

Please provide proof of the following coverage(s): ${params.requiredCoverages}. We ask for new certificates within ${params.warningDays} days so our project records remain compliant.

If you have questions, please reach out to ${params.gcCompany}.

Thank you,
${params.gcCompany}

----------------------------------------
This message was sent by ${params.gcCompany} via SafeCOI · safecoi.com`,
  }
}

export function buildExpirationReminderEmail(params: {
  subName: string
  policyType: string
  expirationDate: string
  daysLeft: number
  gcCompany: string
  portalUrl: string
}): { subject: string; body: string } {
  const urgency = params.daysLeft <= 0 ? 'HAS EXPIRED' : `expires in ${params.daysLeft} day${params.daysLeft === 1 ? '' : 's'}`
  return {
    subject: `URGENT: Your ${params.policyType} insurance ${urgency} — action required (${params.gcCompany})`,
    body: `Hello ${params.subName},

This is a reminder from ${params.gcCompany} that your ${params.policyType} insurance policy ${urgency} (expiration date: ${params.expirationDate}).

To keep working on our active job sites without interruption, please upload your renewed certificate now:
${params.portalUrl}

If you have already renewed and are waiting on your broker, please reply with the estimated date so we can note your file.

Thank you,
${params.gcCompany}`,
  }
}

export function buildCOIShareEmail(params: {
  subName: string
  trade?: string | null
  carrier: string
  policyNumber?: string | null
  expirationDate: string
  coverages: { type: string; per_occurrence_limit?: string | null; aggregate_limit?: string | null }[]
  verifyUrl: string
  signUpUrl: string
  gcCompany?: string | null
  personalMessage?: string | null
}): { subject: string; body: string } {
  const greeting = params.gcCompany ? `Hi ${params.gcCompany} team,` : 'Hi,'
  const lines: string[] = []
  lines.push(`${greeting}`)
  lines.push('')
  lines.push(`${params.subName}${params.trade ? ` (${params.trade})` : ''} has shared their Certificate of Insurance with you.`)
  if (params.personalMessage) {
    lines.push('')
    lines.push(`Note from ${params.subName}:`)
    lines.push(`"${params.personalMessage}"`)
  }
  lines.push('')
  lines.push('POLICY SUMMARY')
  lines.push(`  Carrier:      ${params.carrier}`)
  if (params.policyNumber) lines.push(`  Policy #:     ${params.policyNumber}`)
  lines.push(`  Expires:      ${params.expirationDate}`)
  if (params.coverages && params.coverages.length > 0) {
    lines.push('')
    lines.push('COVERAGE')
    for (const c of params.coverages) {
      const parts = [c.type]
      if (c.per_occurrence_limit) parts.push(`per: ${c.per_occurrence_limit}`)
      if (c.aggregate_limit) parts.push(`agg: ${c.aggregate_limit}`)
      lines.push(`  - ${parts.join(' · ')}`)
    }
  }
  lines.push('')
  lines.push('VIEW AND DOWNLOAD THE FULL DOCUMENT:')
  lines.push(params.verifyUrl)
  lines.push('')
  lines.push('----------------------------------------')
  lines.push("Manage all your subcontractors' insurance in one place —")
  lines.push('expiration reminders, client-safe compliance reports, and')
  lines.push('one-click COI requests. Create your free contractor account:')
  lines.push(params.signUpUrl)
  lines.push('')
  lines.push(`This message was sent by ${params.subName} via SafeCOI · safecoi.com`)
  return {
    subject: `Certificate of Insurance from ${params.subName}`,
    body: lines.join('\n'),
  }
}
