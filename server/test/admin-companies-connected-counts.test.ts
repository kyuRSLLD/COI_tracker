import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { initDatabase, dbRun } from '../src/db/db.ts'
import bcrypt from 'bcryptjs'

const now = () => new Date().toISOString()

async function setup() {
  await initDatabase()
  const app = await createApp()
  const server = app.listen(0)
  const port = (server.address() as any).port
  const base = `http://127.0.0.1:${port}`
  const pw = await bcrypt.hash('secret1234', 8)
  const uid = 'admin-comp-u-' + Math.random().toString(36).slice(2, 9)
  await dbRun("INSERT OR REPLACE INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, 'Admin', 'admin', ?)",
    [uid, `${uid}@example.com`, pw, now()])
  const tok = (await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${uid}@example.com`, password: 'secret1234' })
  })).json()).token
  return { base, tok, server }
}

test('GET /api/admin/companies returns connected_subcontractors and connected_cois numbers', async () => {
  const { base, tok, server } = await setup()
  try {
    const res = await fetch(`${base}/api/admin/companies`, { headers: { Authorization: `Bearer ${tok}` } })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.ok(Array.isArray(body.companies))
    for (const c of body.companies) {
      assert.equal(typeof c.connected_subcontractors, 'number')
      assert.equal(typeof c.connected_cois, 'number')
      assert.ok(c.connected_subcontractors >= 0)
      assert.ok(c.connected_cois >= 0)
    }
  } finally { server.close() }
})

test('connected_subcontractors counts both direct-owned and gc_sub_connections subs; connected_cois counts own + connected sub COIs', async () => {
  const { base, tok, server } = await setup()
  try {
    const gcId = 'gc-' + Math.random().toString(36).slice(2, 9)
    const companyId = 'co-' + Math.random().toString(36).slice(2, 9)
    await dbRun("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC', 'gc', ?)",
      [gcId, `${gcId}@example.com`, now()])
    await dbRun("INSERT INTO companies (id, name, owner_user_id, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      [companyId, 'Test GC Co', gcId, now()])
    // sub 1: owned directly by GC (invite-created)
    await dbRun("INSERT INTO subcontractors (id, company_name, trade, user_id, created_at, updated_at) VALUES (?, 'Sub Direct', 'Other', ?, ?, ?)",
      ['sub-direct-' + gcId, gcId, now(), now()])
    // sub 3: GC's own company sub record
    await dbRun("INSERT INTO subcontractors (id, company_name, trade, user_id, created_at, updated_at) VALUES (?, 'Own Co', 'Other', ?, ?, ?)",
      ['sub-own-' + gcId, gcId, now(), now()])
    // sub 2: connected via gc_sub_connections (joined sub account)
    await dbRun("INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Sub Joined', 'Other', ?, ?)",
      ['sub-joined-' + gcId, now(), now()])
    await dbRun("INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)",
      [gcId, 'sub-joined-' + gcId, now()])
    // COIs: 2 on sub-direct, 1 on sub-joined, 1 own-company COI
    for (const [id, subId, ownGc] of [
      ['coi-a-' + gcId, 'sub-direct-' + gcId, null],
      ['coi-b-' + gcId, 'sub-direct-' + gcId, null],
      ['coi-c-' + gcId, 'sub-joined-' + gcId, null],
      ['coi-d-' + gcId, 'sub-own-' + gcId, gcId],
    ]) {
      await dbRun("INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, status, carrier, effective_date, expiration_date, created_at, updated_at) VALUES (?, ?, ?, 'compliant', 'X', '2026-01-01', '2027-01-01', ?, ?)",
        [id, subId, ownGc, now(), now()])
    }

    const res = await fetch(`${base}/api/admin/companies`, { headers: { Authorization: `Bearer ${tok}` } })
    const body: any = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    const found = body.companies.find((c: any) => c.id === companyId)
    assert.ok(found)
    assert.equal(found.connected_subcontractors, 3)
    assert.equal(found.connected_cois, 4)
  } finally { server.close() }
})
