import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { createApp } from '../src/app.ts'
import { dbRun } from '../src/db/db.ts'

test('GET /api/subcontractors attaches cois with coverages and parsed review_details', async (t) => {
  const gcId = 'gc-sublist-test'
  const subId = 'sub-list-test'
  const now = new Date().toISOString()
  const password = await bcrypt.hash('secret1234', 4)
  await dbRun(
    `INSERT OR REPLACE INTO users (id, email, password_hash, name, role, created_at)
     VALUES (?, 'sublist@test.example', ?, 'Test GC', 'gc', ?)`,
    [gcId, password, now],
  )
  await dbRun(
    `INSERT OR REPLACE INTO subcontractors (id, company_name, trade, contact_person, status, created_at, updated_at)
     VALUES (?, 'Acme Steel Inc', 'Steel', 'John', 'pending_review', ?, ?)`,
    [subId, now, now],
  )
  await dbRun('INSERT OR IGNORE INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [gcId, subId, now])
  await dbRun(
    `INSERT OR REPLACE INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, owner_gc_user_id, updated_at, created_at)
     VALUES ('coi-sl-1', ?, 'Acme Ins', '2025-01-01', '2026-06-30', 'valid', ?, ?, ?)`,
    [subId, gcId, now, now],
  )
  await dbRun(
    `INSERT OR REPLACE INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, owner_gc_user_id, updated_at, created_at)
     VALUES ('coi-sl-2', ?, 'Beta Ins', '2024-01-01', '2025-01-01', 'expired', ?, ?, ?)`,
    [subId, gcId, now, now],
  )
  await dbRun("INSERT OR REPLACE INTO coi_coverages (id, coi_id, type, per_occurrence_limit) VALUES ('cov-sl-1', 'coi-sl-1', 'General Liability', '$1,000,000')")
  await dbRun("INSERT OR REPLACE INTO coi_coverages (id, coi_id, type, aggregate_limit) VALUES ('cov-sl-2', 'coi-sl-2', 'Workers Comp', '$500,000')")
  await dbRun("INSERT OR REPLACE INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES ('coi-sl-1', 'tag', '{\"insured_name\":\"Acme Steel Inc\",\"producer_name\":\"Joe Agency\"}')")

  const app = await createApp()
  const server = app.listen(0)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as any).port}`

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sublist@test.example', password: 'secret1234' }),
  })
  const { token } = await loginRes.json()

  const res = await fetch(`${base}/api/subcontractors`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  const acme = body.subcontractors.find((s: any) => s.id === subId)
  assert.ok(acme)
  assert.equal(acme.cois.length, 2)
  const c1 = acme.cois.find((c: any) => c.id === 'coi-sl-1')
  assert.equal(c1.carrier, 'Acme Ins')
  assert.equal(c1.coverages.length, 1)
  assert.equal(c1.coverages[0].type, 'General Liability')
  assert.equal(c1.review_details?.insured_name, 'Acme Steel Inc')
  assert.equal(c1.review_details?.producer_name, 'Joe Agency')
})
