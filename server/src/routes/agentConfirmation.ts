import express from 'express'
import { z } from 'zod'
import { requireAdmin } from '../middleware/auth.ts'
import {
  buildCoiBrief,
  listConfirmationQueue,
  dispatchCall,
  recordCallResult,
  buildConfirmationEmailTemplate,
  sendConfirmationEmail,
  recordEmailResult,
  listConfirmations,
  getConfirmation,
  createAgentApiKey,
  listAgentKeys,
  revokeAgentKey,
  verifyAgentKey,
} from '../services/agentConfirmation.ts'
import { dbGet, dbAll, dbRun } from '../db/db.ts'

export const agentConfirmationRouter = express.Router()

// ---------------- Agent authentication middleware ----------------
// Accepts:
//   - X-Agent-Key: sc_xxx
//   - Authorization: Bearer sc_xxx
//   - Authorization: Bearer <admin JWT> (so admins can test from UI)
export async function requireAgentKey(req: express.Request, res: express.Response, next: express.NextFunction) {
  const headerKey = req.header('X-Agent-Key')
  const auth = req.header('Authorization') || ''
  const bearerKey = auth.startsWith('Bearer sc_') ? auth.slice(7) : null
  const key = headerKey || bearerKey
  if (key) {
    const verified = await verifyAgentKey(key)
    if (!verified.ok) return res.status(401).json({ error: `Invalid agent key: ${verified.reason}` })
    ;(req as any).agentKey = verified.keyRow
    return next()
  }
  // Fall back to admin JWT
  if (req.cookies || auth) {
    return requireAdmin(req, res, () => {
      ;(req as any).agentKey = { id: 'admin-session', name: 'Admin (session)', scopes: 'coi:confirm admin' }
      next()
    })
  }
  return res.status(401).json({ error: 'Agent key required. Pass X-Agent-Key: sc_xxx or Bearer sc_xxx (admin API keys only).' })
}

// ---------------- Agent endpoints ----------------
agentConfirmationRouter.get('/queue', requireAgentKey, async (req, res) => {
  try {
    const { status, channel, has_phone, has_email, limit } = req.query as any
    const queue = await listConfirmationQueue({
      status,
      channel,
      has_phone: has_phone === 'true',
      has_email: has_email === 'true',
      limit: limit ? Math.min(200, parseInt(limit)) : 50,
    })
    res.json({ count: queue.length, items: queue })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/brief/:coiId', requireAgentKey, async (req, res) => {
  try {
    const brief = await buildCoiBrief(req.params.coiId)
    if (!brief) return res.status(404).json({ error: 'COI not found' })
    res.json(brief)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

const dispatchCallSchema = z.object({
  coiId: z.string(),
  toPhone: z.string().max(64).optional(),
  agentId: z.string().max(128).optional(),
  provider: z.enum(['twilio', 'elevenlabs', 'external']).optional(),
})
agentConfirmationRouter.post('/calls/dispatch', requireAgentKey, async (req, res) => {
  const p = dispatchCallSchema.safeParse(req.body)
  if (!p.success) return res.status(400).json({ error: 'Invalid body' })
  try {
    const key = (req as any).agentKey
    const out = await dispatchCall(p.data.coiId, {
      toPhone: p.data.toPhone,
      agentId: p.data.agentId,
      provider: p.data.provider,
      createdBy: key?.name || key?.id,
    })
    res.json(out)
  } catch (err: any) {
    res.status(err.message?.includes('No phone') ? 400 : 500).json({ error: err.message })
  }
})

const callResultSchema = z.object({
  outcome: z.enum(['verified', 'rejected', 'unreachable', 'failed', 'voicemail']),
  notes: z.string().max(2000).optional(),
  answers: z.record(z.any()).optional(),
  recordingUrl: z.string().max(2000).optional(),
  verifiedPolicies: z.array(z.any()).optional(),
  providerPayload: z.any().optional(),
})
agentConfirmationRouter.post('/calls/:confirmationId/result', requireAgentKey, async (req, res) => {
  const p = callResultSchema.safeParse(req.body)
  if (!p.success) return res.status(400).json({ error: 'Invalid body' })
  try {
    const conf = await recordCallResult(req.params.confirmationId, p.data.outcome, {
      notes: p.data.notes,
      answers: p.data.answers,
      recordingUrl: p.data.recordingUrl,
      verifiedPolicies: p.data.verifiedPolicies,
      providerPayload: p.data.providerPayload,
    })
    res.json({ ok: true, confirmation: conf })
  } catch (err: any) {
    res.status(err.message === 'Confirmation not found' ? 404 : 500).json({ error: err.message })
  }
})

const sendEmailSchema = z.object({
  coiId: z.string(),
  toEmail: z.string().email().optional(),
  personalMessage: z.string().max(2000).optional(),
  fromCompany: z.string().max(100).optional(),
})
agentConfirmationRouter.post('/emails/send', requireAgentKey, async (req, res) => {
  const p = sendEmailSchema.safeParse(req.body)
  if (!p.success) return res.status(400).json({ error: 'Invalid body' })
  try {
    const key = (req as any).agentKey
    const out = await sendConfirmationEmail(p.data.coiId, {
      toEmail: p.data.toEmail,
      personalMessage: p.data.personalMessage,
      fromCompany: p.data.fromCompany,
      createdBy: key?.name || key?.id,
    })
    res.json(out)
  } catch (err: any) {
    res.status(err.message?.includes('No email') ? 400 : 500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/emails/template/:coiId', requireAgentKey, async (req, res) => {
  try {
    const brief = await buildCoiBrief(req.params.coiId)
    if (!brief) return res.status(404).json({ error: 'COI not found' })
    const template = buildConfirmationEmailTemplate(brief)
    res.json(template)
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

const emailResultSchema = z.object({
  outcome: z.enum(['verified', 'rejected', 'unreachable']),
  notes: z.string().max(2000).optional(),
  replyBody: z.string().max(8000).optional(),
  verifiedPolicies: z.array(z.any()).optional(),
  providerPayload: z.any().optional(),
})
agentConfirmationRouter.post('/emails/:confirmationId/result', requireAgentKey, async (req, res) => {
  const p = emailResultSchema.safeParse(req.body)
  if (!p.success) return res.status(400).json({ error: 'Invalid body' })
  try {
    const conf = await recordEmailResult(req.params.confirmationId, p.data.outcome, {
      notes: p.data.notes,
      replyBody: p.data.replyBody,
      verifiedPolicies: p.data.verifiedPolicies,
      providerPayload: p.data.providerPayload,
    })
    res.json({ ok: true, confirmation: conf })
  } catch (err: any) {
    res.status(err.message === 'Confirmation not found' ? 404 : 500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/cois/:coiId/confirmations', requireAgentKey, async (req, res) => {
  try {
    const list = await listConfirmations(req.params.coiId)
    res.json({ confirmations: list })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/confirmations/:id', requireAgentKey, async (req, res) => {
  try {
    const c = await getConfirmation(req.params.id)
    if (!c) return res.status(404).json({ error: 'Confirmation not found' })
    res.json({ confirmation: c })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Provider webhook for call-completed callbacks
agentConfirmationRouter.post('/webhooks/calls', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  try {
    const payload = req.body || {}
    const callId = payload.CallSid || payload.conversation_id || payload.call_id
    if (!callId) return res.status(400).json({ error: 'missing call id' })
    const status = payload.CallStatus || payload.status || 'unknown'
    const conf = await dbGet<any>(
      `SELECT * FROM coi_confirmations
       WHERE channel='call' AND provider_payload_json LIKE ? ORDER BY created_at DESC LIMIT 1`,
      [`%${callId}%`],
    )
    if (conf) {
      await dbRun(
        `UPDATE coi_confirmations SET provider_payload_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(payload), new Date().toISOString(), conf.id],
      )
    }
    res.json({ received: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ---------------- ADMIN ONLY: API key control ----------------
const keyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.string().max(200).optional(),
})
agentConfirmationRouter.post('/admin/keys', requireAdmin, async (req, res) => {
  const p = keyCreateSchema.safeParse(req.body)
  if (!p.success) return res.status(400).json({ error: 'Name is required' })
  try {
    const user = (req as any).user
    const created = await createAgentApiKey(p.data.name, p.data.scopes || 'coi:confirm', user?.id)
    res.json({ ok: true, key: created })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/admin/keys', requireAdmin, async (_req, res) => {
  try {
    const keys = await listAgentKeys()
    res.json({ keys })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentConfirmationRouter.delete('/admin/keys/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await revokeAgentKey(req.params.id)
    if (!ok) return res.status(404).json({ error: 'Key not found' })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

agentConfirmationRouter.get('/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const [counts, recent] = await Promise.all([
      dbAll<any>(`SELECT status, channel, COUNT(*) as c FROM coi_confirmations GROUP BY status, channel`),
      dbAll<any>(`SELECT c.*, co.carrier, s.company_name AS sub_company_name
                  FROM coi_confirmations c
                  LEFT JOIN cois co ON co.id = c.coi_id
                  LEFT JOIN subcontractors s ON s.id = co.subcontractor_id
                  ORDER BY c.created_at DESC LIMIT 20`),
    ])
    res.json({ counts, recent })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
