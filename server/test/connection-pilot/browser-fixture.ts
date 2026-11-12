// Test-only: never imported by the runtime entry. Synthetic identities and data only.
import express from 'express'
import { createConnectionShell } from '../../src/connection-shell-wrapper.ts'
import { fileURLToPath } from 'node:url'

const api = express()
api.use(express.json({ limit: '8kb' }))
api.get('/healthz', (_req, res) => res.sendStatus(200))
api.post('/api/v2/auth/login', (req, res) => {
  const role = req.body?.email === 'gc@example.test' ? 'gc' : 'sub'
  res.setHeader('Set-Cookie', 'unwanted=1')
  res.json({ token: `${role}.synthetic.signature`, token_type: 'Bearer', expires_in: 900 })
})
api.get('/api/v2/auth/me', (req, res) => {
  if (req.get('authorization') === 'Bearer slow') { setTimeout(() => res.json({}), 12_000); return }
  if (req.get('authorization') === 'Bearer large') { res.json({ data: 'x'.repeat(300_000) }); return }
  const role = req.get('authorization')?.startsWith('Bearer gc.') ? 'gc' : 'sub'
  res.json({ subject: 'synthetic', role })
})
api.post('/api/v2/auth/logout', (_req, res) => res.sendStatus(204))
api.get('/api/v2/connections/profile', (_req, res) => res.json({ profileId: '11111111-1111-4111-8111-111111111111', evidenceType: 'fresh_self_asserted_email_control_v1' }))
api.get('/api/v2/connections/consent', (_req, res) => res.json({ version: 'qr-v1', qrText: 'Synthetic disclosure' }))
api.post('/api/v2/connections/qr', (_req, res) => res.json({ token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00Z' }))
api.get('/api/v2/connections/subcontractors', (_req, res) => res.json({ subcontractors: [{ id: 'synthetic', profile_id: '11111111-1111-4111-8111-111111111111', company_name: 'Synthetic Sub', trade: 'Electric', evidence_type: 'fresh_self_asserted_email_control_v1' }] }))
api.post('/api/v2/connections/qr/redeem', (_req, res) => res.sendStatus(204))
const app = createConnectionShell(api, fileURLToPath(new URL('../../../client/connection-pilot/dist', import.meta.url)))
const server = app.listen(0, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') console.log(address.port) })
