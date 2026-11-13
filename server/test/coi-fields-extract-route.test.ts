import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { dbRun } from '../src/db/db.ts'
import { randomUUID } from 'crypto'
const { signToken } = await import('../src/middleware/auth.ts')
const app = await createApp({ maintenanceMode: false })
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve) => server.once('listening', resolve))
const { port } = server.address() as any
const base = `http://127.0.0.1:${port}`
async function insertSubAndCoi(gcId: string, subId: string, coiId: string, key: string | null) {
  const now = new Date().toISOString()
  await dbRun(`INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC', 'gc', ?)`, [gcId, `gc-${gcId}@t.test`, now])
  await dbRun(`INSERT OR IGNORE INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Sub', 'Electrical', ?, ?)`, [subId, now, now])
  await dbRun(`INSERT OR IGNORE INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)`, [gcId, subId, now])
  await dbRun(
    `INSERT OR REPLACE INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at, owner_gc_user_id) VALUES (?, ?, 'X', 'pending_review', '2026-01-01', '2027-01-01', ?, 'x.png', 1, 'image/png', ?, ?, ?)`,
    [coiId, subId, key, now, now, gcId],
  )
}
test('POST /api/coi-fields/:coiId/extract requires auth', async () => {
  const res = await fetch(`${base}/api/coi-fields/x/extract`, { method: 'POST' })
  assert.equal(res.status, 401)
})
test('POST /api/coi-fields/:coiId/extract rejects unknown COI', async () => {
  const gcId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(`INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC', 'gc', ?)`, [gcId, `gc-${gcId}@t.test`, now])
  const t = signToken({ id: gcId, email: `gc-${gcId}@t.test`, role: 'gc', name: 'A' })
  const res = await fetch(`${base}/api/coi-fields/${randomUUID()}/extract`, { method: 'POST', headers: { authorization: `Bearer ${t}` } })
  assert.equal(res.status, 404)
})
test('POST /api/coi-fields/:coiId/extract guarded by config and key checks', async () => {
  const gcId = randomUUID(), subId = randomUUID(), coiId = randomUUID()
  await insertSubAndCoi(gcId, subId, coiId, 'cois/a.png')
  const t = signToken({ id: gcId, email: `gc-${gcId}@t.test`, role: 'gc', name: 'GC' })
  const res = await fetch(`${base}/api/coi-fields/${coiId}/extract`, { method: 'POST', headers: { authorization: `Bearer ${t}` } })
  // In test env, Textract is not configured — verify the route reaches the guard correctly
  assert.equal(res.status, 503)
  const body = await res.json() as any
  assert.match(body.error, /Extraction service is not configured/)
})
test('POST /api/coi-fields/:coiId/extract rejects un-editable caller', async () => {
  const gcId = randomUUID(), subId = randomUUID(), coiId = randomUUID(), otherGc = randomUUID()
  await insertSubAndCoi(gcId, subId, coiId, 'cois/a.png')
  const now = new Date().toISOString()
  await dbRun(`INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC2', 'gc', ?)`, [otherGc, `gc-${otherGc}@t.test`, now])
  const t = signToken({ id: otherGc, email: `gc-${otherGc}@t.test`, role: 'gc', name: 'Other' })
  const res = await fetch(`${base}/api/coi-fields/${coiId}/extract`, { method: 'POST', headers: { authorization: `Bearer ${t}` } })
  assert.equal(res.status, 404)
})
test.after(() => server.close())
