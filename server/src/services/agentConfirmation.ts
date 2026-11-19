import { randomUUID, createHash, randomBytes } from 'node:crypto'
import { dbGet, dbAll, dbRun } from '../db/db.ts'
import { sendEmail } from './email.ts'

function parseAnyDate(s?: string | null): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d
  const m = String(s).match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/)
  if (m) {
    const [, a, b, c] = m
    const yr = c.length === 2 ? (parseInt(c) < 70 ? 2000 + parseInt(c) : 1900 + parseInt(c)) : parseInt(c)
    const d2 = new Date(yr, parseInt(a) - 1, parseInt(b))
    if (!isNaN(d2.getTime())) return d2
  }
  return null
}
function isExpiredDate(s?: string | null): boolean {
  const d = parseAnyDate(s)
  return d ? d.getTime() < Date.now() : false
}

export interface AgentConfirmation {
  id: string
  coi_id: string
  channel: 'call' | 'email'
  target: 'agency' | 'carrier'
  recipient: string | null
  status: 'queued' | 'in_progress' | 'verified' | 'rejected' | 'unreachable' | 'failed'
  result_notes: string | null
  answers_json: string | null
  recording_url: string | null
  agent_id: string | null
  verified_policies_json: string | null
  provider_payload_json: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CoiBrief {
  coi: {
    id: string
    carrier: string
    policy_number: string | null
    effective_date: string | null
    expiration_date: string | null
    status: string
    is_expired: boolean
    certificate_key: string | null
  }
  producer: { name?: string; phone?: string; email?: string; address?: string; contact_person?: string }
  insured: { name?: string; address?: string }
  insurers: Array<{ letter?: string; name?: string; naic?: string }>
  policies: Array<{
    type?: string
    insurerLetter?: string
    policyNumber?: string
    effectiveDate?: string
    expirationDate?: string
    is_expired: boolean
    limits: Array<{ label?: string; amount?: string }>
  }>
  questions: string[]
  preferred_channel: 'call' | 'email' | 'both' | 'none'
}

function parseDetails(detailsJson: string | null | undefined): any {
  if (!detailsJson) return null
  try { return JSON.parse(detailsJson) } catch { return null }
}

export async function buildCoiBrief(coiId: string): Promise<CoiBrief | null> {
  const row = await dbGet<any>(
    `SELECT c.*, r.details_json, r.source_tag FROM cois c
     LEFT JOIN coi_field_reviews r ON r.coi_id = c.id
     WHERE c.id = ?`,
    [coiId],
  )
  if (!row) return null
  const d = parseDetails(row.details_json)
  const policies: any[] = Array.isArray(d?.policies) ? d.policies : []
  const producer = {
    name: d?.producer?.name || undefined,
    phone: d?.producer?.phone || undefined,
    email: d?.producer?.email || undefined,
    address: d?.producer?.address || undefined,
    contact_person: d?.producer?.contact_person || undefined,
  }
  const insured = {
    name: d?.insured?.name || undefined,
    address: d?.insured?.address || undefined,
  }
  const insurers: Array<{ letter?: string; name?: string; naic?: string }> =
    Array.isArray(d?.insurers) && d.insurers.length
      ? d.insurers
      : d?.insurer?.name ? [{ letter: 'A', name: d.insurer.name, naic: d.insurer.naic }] : []
  const mappedPolicies = policies.map((p) => ({
    type: p.type || undefined,
    insurerLetter: p.insurerLetter || undefined,
    policyNumber: p.policyNumber || undefined,
    effectiveDate: p.effectiveDate || undefined,
    expirationDate: p.expirationDate || undefined,
    is_expired: isExpiredDate(p.expirationDate),
    limits: Array.isArray(p.limits) ? p.limits : [],
  }))
  const exp = parseAnyDate(row.expiration_date)
  const isExp = exp ? exp.getTime() < Date.now() : false
  const questions: string[] = [
    `Confirm each listed policy is ACTIVE and in force for insured "${insured.name || 'named insured'}"`,
    `Confirm expiration dates match: ${mappedPolicies.map((p) => `${p.type || 'policy'}=${p.expirationDate || 'n/a'}`).join(', ') || row.expiration_date || 'n/a'}`,
    `Confirm the general liability includes Additional Insured coverage for the general contractor (CG 20 10 / CG 20 37 or equivalent) and Waiver of Subrogation`,
    'Ask for the issuing insurer (not holding company), NAIC#, and the policy holder name/address as shown on the carrier\'s records',
  ]
  const hasPhone = Boolean(producer.phone)
  const hasEmail = Boolean(producer.email)
  const preferred_channel = hasPhone && hasEmail ? 'both' : hasPhone ? 'call' : hasEmail ? 'email' : 'none'
  return {
    coi: {
      id: row.id,
      carrier: row.carrier,
      policy_number: row.policy_number,
      effective_date: row.effective_date,
      expiration_date: row.expiration_date,
      status: row.status,
      is_expired: isExp,
      certificate_key: row.certificate_key,
    },
    producer,
    insured,
    insurers,
    policies: mappedPolicies,
    questions,
    preferred_channel,
  }
}

export async function listConfirmationQueue(opts: {
  status?: string
  channel?: string
  has_phone?: boolean
  has_email?: boolean
  limit?: number
}): Promise<Array<{ coi_id: string; sub_company_name: string | null; carrier: string | null; expiration_date: string | null; producer_phone: string | null; producer_email: string | null; preferred_channel: string; last_confirmation?: AgentConfirmation }>> {
  const rows = await dbAll<any>(
    `SELECT c.id, c.carrier, c.expiration_date, c.status, s.company_name AS sub_company_name,
            r.details_json
     FROM cois c
     LEFT JOIN subcontractors s ON s.id = c.subcontractor_id
     LEFT JOIN coi_field_reviews r ON r.coi_id = c.id
     WHERE c.status IN ('pending_review', 'needs_revision')
     ORDER BY c.created_at DESC`,
  )
  const out: any[] = []
  for (const r of rows) {
    const d = parseDetails(r.details_json)
    const phone = d?.producer?.phone || null
    const email = d?.producer?.email || null
    const pref = phone && email ? 'both' : phone ? 'call' : email ? 'email' : 'none'
    if (opts.channel && pref !== opts.channel && pref !== 'both') continue
    if (opts.has_phone === true && !phone) continue
    if (opts.has_email === true && !email) continue
    const last = await dbGet<any>(
      `SELECT * FROM coi_confirmations WHERE coi_id = ? ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    )
    if (opts.status && (!last || last.status !== opts.status)) continue
    out.push({
      coi_id: r.id,
      sub_company_name: r.sub_company_name,
      carrier: r.carrier,
      expiration_date: r.expiration_date,
      producer_phone: phone,
      producer_email: email,
      preferred_channel: pref,
      last_confirmation: last || null,
    })
    if (opts.limit && out.length >= opts.limit) break
  }
  return out
}

export async function dispatchCall(coiId: string, opts: {
  toPhone?: string
  agentId?: string
  createdBy?: string
  provider?: 'twilio' | 'elevenlabs' | 'external'
}): Promise<{ confirmation: AgentConfirmation; dialing: { to: string; script_prompt: string; provider: string; provider_call_id?: string } }> {
  const brief = await buildCoiBrief(coiId)
  if (!brief) throw new Error('COI not found')
  const to = (opts.toPhone || brief.producer.phone || '').trim()
  if (!to) throw new Error('No phone number available for this agency — supply toPhone or use the email channel')
  const scriptPrompt = buildCallScript(brief)
  const id = randomUUID()
  const now = new Date().toISOString()
  let providerCallId: string | undefined
  const provider = opts.provider || (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID ? 'elevenlabs' : process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'external')
  if (provider === 'elevenlabs' && process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID) {
    providerCallId = await startElevenLabsCall({
      to,
      agentId: opts.agentId || process.env.ELEVENLABS_AGENT_ID,
      confirmationId: id,
      brief,
    }).catch((e) => { console.warn('[call:elevenlabs] dispatch warning:', e.message); return undefined })
  } else if (provider === 'twilio' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    providerCallId = await startTwilioCall({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      confirmationId: id,
      twimlUrl: process.env.TWILIO_VOICE_URL || `${baseUrl()}/api/agent/v1/voice/twiml/${id}`,
    }).catch((e) => { console.warn('[call:twilio] dispatch warning:', e.message); return undefined })
  }
  await dbRun(
    `INSERT INTO coi_confirmations
      (id, coi_id, channel, target, recipient, status, agent_id, result_notes, provider_payload_json, created_by, created_at, updated_at)
     VALUES (?, ?, 'call', 'agency', ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      coiId,
      to,
      opts.agentId || provider,
      provider === 'external' ? 'External AI agent will execute this call via API' : `Dispatched via ${provider}`,
      providerCallId ? JSON.stringify({ provider, call_id: providerCallId }) : null,
      opts.createdBy || null,
      now,
      now,
    ],
  )
  const conf = await dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [id])
  return { confirmation: conf, dialing: { to, script_prompt: scriptPrompt, provider, provider_call_id: providerCallId } }
}

export function buildCallScript(brief: CoiBrief): string {
  const policies = brief.policies.map((p) =>
    `- ${p.type || 'policy'}: #${p.policyNumber || 'n/a'}, effective ${p.effectiveDate || 'n/a'}, expires ${p.expirationDate || 'n/a'}`).join('\n')
  return [
    `You are the SafeCOI AI verification assistant calling on behalf of a general contractor.`,
    `GOAL: confirm the following Certificate of Insurance issued by your agency is authentic and currently in force.`,
    `AGENCY: ${brief.producer.name || 'Insurance agency'} (${brief.producer.phone || 'phone unknown'})`,
    `NAMED INSURED (the subcontractor): ${brief.insured.name || 'named insured'}`,
    `ISSUING INSURER(S): ${brief.insurers.map((i) => `${i.name || 'carrier'}${i.naic ? ` (NAIC ${i.naic})` : ''}`).join(', ') || brief.coi.carrier || 'unknown'}`,
    `POLICIES ON FILE:`,
    policies || `  ${brief.coi.policy_number || 'policy'} expires ${brief.coi.expiration_date || 'n/a'}`,
    `CONFIRM WITH THE REPRESENTATIVE:`,
    `1) Is the named insured an active account with your agency?`,
    `2) Is each listed policy ACTIVE today with those exact policy numbers and expiration dates?`,
    `3) What is the correct issuing insurer name and NAIC# for each?`,
    `4) Does the general liability include Additional Insured and Waiver of Subrogation coverage?`,
    `If the policy is CANCELLED, LAPSED, or does NOT exist, report outcome="rejected" and state the reason.`,
    `Be polite, concise, and professional. Once you have answers, end the call with "Thank you, this confirms our records."`,
  ].join('\n')
}

export async function recordCallResult(confirmationId: string, outcome: 'verified' | 'rejected' | 'unreachable' | 'failed' | 'voicemail', opts: {
  notes?: string
  answers?: Record<string, any>
  recordingUrl?: string
  verifiedPolicies?: any[]
  providerPayload?: any
  actor?: string
}): Promise<AgentConfirmation> {
  const now = new Date().toISOString()
  const conf = await dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [confirmationId])
  if (!conf) throw new Error('Confirmation not found')
  const status = outcome === 'voicemail' ? 'unreachable' : outcome
  await dbRun(
    `UPDATE coi_confirmations
     SET status = ?, result_notes = ?, answers_json = ?, recording_url = ?,
         verified_policies_json = ?, provider_payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [
      status,
      opts.notes ?? null,
      opts.answers ? JSON.stringify(opts.answers) : null,
      opts.recordingUrl ?? null,
      opts.verifiedPolicies ? JSON.stringify(opts.verifiedPolicies) : null,
      opts.providerPayload ? JSON.stringify(opts.providerPayload) : conf.provider_payload_json,
      now,
      confirmationId,
    ],
  )
  if (outcome === 'verified') {
    await applyVerifiedConfirmation(conf.coi_id, 'phone_call', opts.notes, confirmationId)
  }
  return dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [confirmationId])
}

export function buildConfirmationEmailTemplate(brief: CoiBrief, opts?: { personalMessage?: string; fromCompany?: string }): { subject: string; body: string } {
  const policies = brief.policies.map((p) =>
    `  • ${p.type || 'Policy'}: Policy #${p.policyNumber || 'n/a'} · effective ${p.effectiveDate || 'n/a'} · expires ${p.expirationDate || 'n/a'}`).join('\n')
  return {
    subject: `Insurance confirmation request — ${brief.insured.name || 'named insured'}`,
    body: [
      `Hello ${brief.producer.name || 'Insurance team'},`,
      '',
      `We received the certificate below on file for ${brief.insured.name || 'this subcontractor'} and are confirming the coverage before work begins.`,
      opts?.personalMessage ? `\n"${opts.personalMessage}"\n` : '',
      'NAMED INSURED:',
      `  ${brief.insured.name || '—'}`,
      brief.insured.address ? `  ${brief.insured.address}` : '',
      '',
      'POLICIES ON FILE:',
      policies || `  • ${brief.coi.carrier || 'carrier'} — expires ${brief.coi.expiration_date || 'n/a'}`,
      '',
      'Please reply to confirm:',
      '  1. Each policy above is ACTIVE and in force',
      '  2. The policy numbers and expiration dates match your records',
      '  3. Additional Insured and Waiver of Subrogation wording is in place on the general liability',
      '',
      'If any policy is cancelled, lapsed, or the insured does not exist in your books, please let us know so we can update the record.',
      '',
      'Thank you,',
      opts?.fromCompany || 'SafeCOI compliance team · safecoi.com',
    ].filter(Boolean).join('\n'),
  }
}

export async function sendConfirmationEmail(coiId: string, opts: {
  toEmail?: string
  personalMessage?: string
  fromCompany?: string
  createdBy?: string
}): Promise<{ confirmation: AgentConfirmation; emailId: string; template: { subject: string; body: string } }> {
  const brief = await buildCoiBrief(coiId)
  if (!brief) throw new Error('COI not found')
  const to = (opts.toEmail || brief.producer.email || '').trim()
  if (!to) throw new Error('No email available for this agency — supply toEmail or use the phone channel')
  const template = buildConfirmationEmailTemplate(brief, opts)
  const result = await sendEmail({ to, subject: template.subject, body: template.body, type: 'coi_confirmation_request' })
  const id = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO coi_confirmations
      (id, coi_id, channel, target, recipient, status, result_notes, provider_payload_json, created_by, created_at, updated_at)
     VALUES (?, ?, 'email', 'agency', ?, 'in_progress', ?, ?, ?, ?, ?)`,
    [
      id,
      coiId,
      to,
      `Confirmation email sent to ${to}`,
      JSON.stringify({ email_log_id: result.id, status: result.status }),
      opts.createdBy || null,
      now,
      now,
    ],
  )
  const conf = await dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [id])
  return { confirmation: conf, emailId: result.id, template }
}

export async function recordEmailResult(confirmationId: string, outcome: 'verified' | 'rejected' | 'unreachable', opts: {
  notes?: string
  replyBody?: string
  verifiedPolicies?: any[]
  providerPayload?: any
}): Promise<AgentConfirmation> {
  const now = new Date().toISOString()
  const conf = await dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [confirmationId])
  if (!conf) throw new Error('Confirmation not found')
  const payload = { ...(conf.provider_payload_json ? JSON.parse(conf.provider_payload_json) : {}), reply_body: opts.replyBody }
  await dbRun(
    `UPDATE coi_confirmations
     SET status = ?, result_notes = ?, verified_policies_json = ?, provider_payload_json = ?, updated_at = ?
     WHERE id = ?`,
    [outcome, opts.notes ?? null, opts.verifiedPolicies ? JSON.stringify(opts.verifiedPolicies) : null, JSON.stringify(payload), now, confirmationId],
  )
  if (outcome === 'verified') {
    await applyVerifiedConfirmation(conf.coi_id, 'email', opts.notes, confirmationId)
  }
  return dbGet<any>('SELECT * FROM coi_confirmations WHERE id = ?', [confirmationId])
}

export async function applyVerifiedConfirmation(coiId: string, channel: 'phone_call' | 'email', notes?: string | null, confirmationId?: string): Promise<void> {
  const now = new Date().toISOString()
  await dbRun(
    `UPDATE cois
     SET status = 'compliant',
         confirmed_via = ?, confirmed_at = ?,
         confirmed_notes = COALESCE(?, confirmed_notes),
         review_date = ?,
         updated_at = ?
     WHERE id = ?`,
    [channel, now, notes ? `Confirmed via ${channel}: ${notes}` : `Confirmed via ${channel}`, now.slice(0, 10), now, coiId],
  )
  if (confirmationId) {
    await dbRun(
      `UPDATE coi_confirmations SET updated_at = ? WHERE id = ?`,
      [now, confirmationId],
    )
  }
}

export async function listConfirmations(coiId: string): Promise<AgentConfirmation[]> {
  return dbAll<any>(`SELECT * FROM coi_confirmations WHERE coi_id = ? ORDER BY created_at DESC`, [coiId])
}

export async function getConfirmation(id: string): Promise<AgentConfirmation | null> {
  return dbGet<any>(`SELECT * FROM coi_confirmations WHERE id = ?`, [id])
}

// ---------------- Admin-managed API keys ----------------
export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function generateKey(): { full: string; hash: string; prefix: string } {
  const raw = randomBytes(24).toString('base64url')
  const full = `sc_${raw}`
  return { full, hash: sha256(full), prefix: full.slice(0, 10) }
}

export async function createAgentApiKey(name: string, scopes: string, adminUserId?: string): Promise<{ id: string; key: string; prefix: string; name: string; scopes: string; created_at: string }> {
  const id = randomUUID()
  const now = new Date().toISOString()
  const { full, hash, prefix } = generateKey()
  await dbRun(
    `INSERT INTO agent_api_keys (id, key_hash, key_prefix, name, scopes, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, hash, prefix, name, scopes, adminUserId || null, now],
  )
  return { id, key: full, prefix, name, scopes, created_at: now }
}

export async function verifyAgentKey(key: string): Promise<{ ok: boolean; keyRow?: any; reason?: string }> {
  if (!key || typeof key !== 'string') return { ok: false, reason: 'missing key' }
  const hash = sha256(key.trim())
  const row = await dbGet<any>(`SELECT * FROM agent_api_keys WHERE key_hash = ?`, [hash])
  if (!row) return { ok: false, reason: 'invalid key' }
  if (row.revoked_at) return { ok: false, reason: 'key revoked' }
  await dbRun(`UPDATE agent_api_keys SET last_used_at = ? WHERE id = ?`, [new Date().toISOString(), row.id])
  return { ok: true, keyRow: row }
}

export async function listAgentKeys(): Promise<any[]> {
  return dbAll<any>(
    `SELECT a.id, a.name, a.key_prefix, a.scopes, a.last_used_at, a.revoked_at, a.created_at,
            u.email AS created_by_email
     FROM agent_api_keys a
     LEFT JOIN users u ON u.id = a.created_by_user_id
     ORDER BY a.created_at DESC`,
  )
}

export async function revokeAgentKey(id: string): Promise<boolean> {
  const res = await dbRun(`UPDATE agent_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [new Date().toISOString(), id])
  return (res?.changes ?? 1) > 0
}

function baseUrl(): string {
  return process.env.CLIENT_URL || 'https://safecoi.com'
}

// ---------------- Provider dispatch skeletons ----------------
async function startElevenLabsCall(opts: { to: string; agentId: string; confirmationId: string; brief: CoiBrief }): Promise<string | undefined> {
  const res = await fetch('https://api.elevenlabs.io/v1/convai/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
    body: JSON.stringify({
      agent_id: opts.agentId,
      metadata: { confirmation_id: opts.confirmationId, coi_id: opts.brief.coi.id, insured: opts.brief.insured.name },
      dynamic_variables: {
        to_phone: opts.to,
        agency_name: opts.brief.producer.name || '',
        insured_name: opts.brief.insured.name || '',
      },
    }),
  })
  if (!res.ok) throw new Error(`ElevenLabs start call failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const data = await res.json() as any
  return data.conversation_id || data.id
}

async function startTwilioCall(opts: { to: string; from: string; confirmationId: string; twimlUrl: string }): Promise<string | undefined> {
  const sid = process.env.TWILIO_ACCOUNT_SID!
  const tok = process.env.TWILIO_AUTH_TOKEN!
  const form = new URLSearchParams()
  form.set('To', opts.to)
  form.set('From', opts.from)
  form.set('Url', opts.twimlUrl)
  form.set('StatusCallback', `${baseUrl()}/api/agent/v1/webhooks/calls`)
  form.set('StatusCallbackMethod', 'POST')
  form.set('StatusCallbackEvent', 'completed')
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`,
    },
    body: form.toString(),
  })
  if (!res.ok) throw new Error(`Twilio start call failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
  const data = await res.json() as any
  return data.sid
}
