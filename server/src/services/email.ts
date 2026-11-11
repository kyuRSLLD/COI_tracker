import { v4 as uuidv4 } from 'uuid'
import { dbRun } from '../db/db.ts'

export interface EmailPayload {
  to: string
  subject: string
  body: string
  type?: 'coi_request' | 'expiration_reminder' | 'revision_request' | 'general'
}

export async function sendEmail({ to, subject, body, type = 'general' }: EmailPayload): Promise<{ id: string; status: string }> {
  const id = uuidv4()
  const status = 'simulated' // In production with SMTP configured, swap to real transporter
  await dbRun(
    `INSERT INTO email_logs (id, to_email, subject, body, type, status, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, to, subject, body, type, status, new Date().toISOString()]
  )
  console.log(`[email] Simulated email -> ${to} | ${subject}`)
  return { id, status }
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

Required coverage for our projects:
${params.requiredCoverages}

Notes:
- Please upload a PDF or clear image of your ACORD certificate.
- Ensure ${params.gcCompany} is listed as an Additional Insured and that a Waiver of Subrogation applies where required.
- If your policy is set to renew within ${params.warningDays} days, you will receive friendly renewal reminders automatically.

Thank you,
${params.gcCompany}`,
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
  lines.push('Manage all your subcontractors\' insurance in one place —')
  lines.push('expiration reminders, client-safe compliance reports, and')
  lines.push('one-click COI requests. Create your free contractor account:')
  lines.push(params.signUpUrl)
  lines.push('')
  lines.push(`This message was sent by ${params.subName} via COI Shield · safecoi.com`)
  return {
    subject: `Certificate of Insurance from ${params.subName}`,
    body: lines.join('\n'),
  }
}
