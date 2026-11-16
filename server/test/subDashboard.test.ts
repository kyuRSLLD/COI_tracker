import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { dbRun, initDatabase } from '../src/db/db.ts'
import { randomUUID } from 'crypto'
const { signToken } = await import('../src/middleware/auth.ts')

await initDatabase()
const app = await createApp({ maintenanceMode: false })
const server = app.listen(0, '127.0.0.1')
test.after(() => server.close())
await new Promise<void>((resolve) => server.once('listening', resolve))
const { port } = server.address() as any
const base = `http://127.0.0.1:${port}`
const now = new Date().toISOString()

test('sub portal GET /api/sub/my returns status and review_source_tag on each COI', async () => {
  await dbRun('DELETE FROM coi_field_reviews')
  await dbRun('DELETE FROM coi_coverages')
  await dbRun('DELETE FROM cois')
  await dbRun('DELETE FROM gc_sub_connections')
  await dbRun('DELETE FROM subcontractors')
  await dbRun('DELETE FROM users')

  const subUser = { id: randomUUID(), email: 'sub@t.test', role: 'sub' }
  await dbRun(`INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'Sub', 'sub', ?)`, [subUser.id, subUser.email, now])
  const subco = { id: randomUUID(), name: 'S1', trade: 'Mason' }
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [subco.id, subco.name, subco.trade, subUser.id, now, now])

  const coi1 = randomUUID()
  await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_sub_user_id, created_at, updated_at) VALUES (?, ?, 'Acme Ins', 'compliant', '2025-01-01', '2026-01-01', ?, ?, ?)`, [coi1, subco.id, subUser.id, now, now])
  await dbRun(`INSERT OR REPLACE INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, 'ai', '{"fields":[]}')`, [coi1])

  const coi2 = randomUUID()
  await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_sub_user_id, created_at, updated_at) VALUES (?, ?, 'Beta Ins', 'pending_review', '2025-01-01', '2026-01-01', ?, ?, ?)`, [coi2, subco.id, subUser.id, now, now])

  const res = await fetch(`${base}/api/sub/my`, { headers: { Authorization: `Bearer ${signToken(subUser)}` } })
  assert.equal(res.status, 200)
  const body = await res.json() as any
  assert.equal(body.cois.length, 2)
  const byCarrier = Object.fromEntries(body.cois.map((c: any) => [c.carrier, c]))
  assert.equal(byCarrier['Acme Ins'].status, 'compliant')
  assert.equal(byCarrier['Acme Ins'].review_source_tag, 'ai')
  assert.equal(byCarrier['Beta Ins'].status, 'pending_review')
  assert.equal(byCarrier['Beta Ins'].review_source_tag, null)
})

test('verification status visible to connected GC via GET /api/subcontractors', async () => {
  const gc = { id: randomUUID(), email: 'gc@t.test', role: 'gc' }
  await dbRun(`INSERT OR IGNORE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC', 'gc', ?)`, [gc.id, gc.email, now])
  const subco = { id: randomUUID(), name: 'S2', trade: 'HVAC' }
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, [subco.id, subco.name, subco.trade, now, now])
  await dbRun(`INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)`, [gc.id, subco.id, now])

  const coiId = randomUUID()
  await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_gc_user_id, created_at, updated_at) VALUES (?, ?, 'Acme Ins', 'pending_review', '2025-01-01', '2026-01-01', ?, ?, ?)`, [coiId, subco.id, gc.id, now, now])

  const r1 = await fetch(`${base}/api/subcontractors`, { headers: { Authorization: `Bearer ${signToken(gc)}` } })
  assert.equal(r1.status, 200)
  const list1 = ((await r1.json()) as any).subcontractors as any[]
  const sub1 = list1.find(s => s.id === subco.id)
  assert.equal(sub1.best_coi.status, 'pending_review')

  await dbRun(`UPDATE cois SET status = 'compliant' WHERE id = ?`, [coiId])

  const r2 = await fetch(`${base}/api/subcontractors`, { headers: { Authorization: `Bearer ${signToken(gc)}` } })
  assert.equal(r2.status, 200)
  const list2 = ((await r2.json()) as any).subcontractors as any[]
  const sub2 = list2.find(s => s.id === subco.id)
  assert.equal(sub2.best_coi.status, 'compliant')
})
