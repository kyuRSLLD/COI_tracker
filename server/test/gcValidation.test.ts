import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import http from 'node:http'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-gcv-'))
process.env.DATABASE_URL = ''
process.env.DB_FILE = path.join(tmpDir, 'test.db')
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret'
process.env.PORT = '0'

const { createApp } = await import('../src/app.ts')
const { initDatabase, dbRun, dbGet } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

let server: http.Server
let base = ''

before(async () => {
  await initDatabase()
  const app = await createApp({ maintenanceMode: false })
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as { port: number }
      base = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function token(id: string, role = 'gc') {
  return signToken({ id, email: `${id}@test.demo`, role, name: id })
}

function subToken(id: string) {
  return signToken({ id, email: `${id}@test.demo`, role: 'sub', name: id })
}

async function api(path: string, options: { method?: string; body?: any; token?: string }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  const res = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const text = await res.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

async function seedFixture(opts: { expired?: boolean } = {}) {
  const now = new Date().toISOString()
  const gcId = randomUUID()
  const subUserId = randomUUID()
  const subId = randomUUID()
  const coiId = randomUUID()
  const expiration = opts.expired ? '2020-01-01' : '2090-01-01'

  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [gcId, `${gcId}@test.demo`, 'hash', 'GC', 'gc', now])
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [subUserId, `${subUserId}@test.demo`, 'hash', 'Sub User', 'sub', now])
  await dbRun('INSERT INTO subcontractors (id, company_name, trade, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [subId, 'Fixture Electric', 'Electrical', subUserId, now, now])
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
    [gcId, subId, now])
  await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, '2025-01-01', ?, 'pending_review', ?, ?)`,
    [coiId, subId, subUserId, 'TestCarrier', expiration, now, now])
  await dbRun('INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, ?, ?)',
    [coiId, 'tag', JSON.stringify({ source: 'ocr', insured: { name: 'Fixture Electric' } })])
  await dbRun('INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)',
    [coiId, 'rev-1'])

  return { gcId, subUserId, subId, coiId }
}

test('1. connected GC can validate a sub-owned COI: marks compliant, reviewer notes, stamps review_date, flips review source to manual, bumps review version', async () => {
  const { gcId, coiId } = await seedFixture()
  const res = await api(`/api/cois/${coiId}/validate`, {
    method: 'POST',
    token: token(gcId),
    body: { notes: 'looks good' },
  })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.coi.status, 'compliant')
  assert.equal(res.data.coi.reviewer_notes, 'looks good')
  assert.ok(res.data.coi.review_date)

  const review = await dbGet<{ details_json: string }>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [coiId])
  assert.equal(JSON.parse(review!.details_json).source, 'manual')
  const ver = await dbGet<{ revision: string }>('SELECT revision FROM coi_field_review_versions WHERE coi_id = ?', [coiId])
  assert.notEqual(ver!.revision, 'rev-1')
})

test('2. validate refuses an expired COI with 400', async () => {
  const { gcId, coiId } = await seedFixture({ expired: true })
  const res = await api(`/api/cois/${coiId}/validate`, { method: 'POST', token: token(gcId) })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /expired/i)
  const coi = await dbGet<{ status: string }>('SELECT status FROM cois WHERE id = ?', [coiId])
  assert.equal(coi!.status, 'pending_review')
})

test('3. unconnected GC cannot validate — receives 404 (COI isolation)', async () => {
  const { coiId } = await seedFixture()
  const otherGcId = randomUUID()
  const now = new Date().toISOString()
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [otherGcId, `${otherGcId}@test.demo`, 'hash', 'Other', 'gc', now])
  const res = await api(`/api/cois/${coiId}/validate`, { method: 'POST', token: token(otherGcId) })
  assert.equal(res.status, 404)
})

test('4. validate requires authentication — 401', async () => {
  const { coiId } = await seedFixture()
  const res = await api(`/api/cois/${coiId}/validate`, { method: 'POST' })
  assert.equal(res.status, 401)
})

test('5. connected GC can reject or request revision on a sub-owned COI', async () => {
  const { gcId, coiId } = await seedFixture()
  const r1 = await api(`/api/cois/${coiId}/review`, {
    method: 'PUT',
    token: token(gcId),
    body: { status: 'needs_revision', reviewer_notes: 'missing endorsement page' },
  })
  assert.equal(r1.status, 200, JSON.stringify(r1.data))
  assert.equal(r1.data.coi.status, 'needs_revision')
  assert.equal(r1.data.coi.reviewer_notes, 'missing endorsement page')

  const r2 = await api(`/api/cois/${coiId}/review`, {
    method: 'PUT',
    token: token(gcId),
    body: { status: 'rejected' },
  })
  assert.equal(r2.status, 200)
  assert.equal(r2.data.coi.status, 'rejected')
})

test('6. review rejects invalid status with 400', async () => {
  const { gcId, coiId } = await seedFixture()
  const res = await api(`/api/cois/${coiId}/review`, {
    method: 'PUT',
    token: token(gcId),
    body: { status: 'foo' },
  })
  assert.equal(res.status, 400)
})

test('7. review refusing compliant status on an expired COI', async () => {
  const { gcId, coiId } = await seedFixture({ expired: true })
  const res = await api(`/api/cois/${coiId}/review`, {
    method: 'PUT',
    token: token(gcId),
    body: { status: 'compliant' },
  })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /expired/i)
})

test('8. non-GC roles cannot validate COIs — 403', async () => {
  const { coiId } = await seedFixture()
  const subActorId = randomUUID()
  const now = new Date().toISOString()
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [subActorId, `${subActorId}@test.demo`, 'hash', 'Sub', 'sub', now])
  const res = await api(`/api/cois/${coiId}/validate`, { method: 'POST', token: subToken(subActorId) })
  assert.equal(res.status, 403)
})

test('9. validation on GC own COI flips review source to manual and bumps revision', async () => {
  const now = new Date().toISOString()
  const gcId = randomUUID()
  const subId = randomUUID()
  const coiId = randomUUID()
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [gcId, `${gcId}@test.demo`, 'hash', 'GC', 'gc', now])
  await dbRun('INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [subId, 'My Sub', 'Drywall', now, now])
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
    [gcId, subId, now])
  await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, '2025-01-01', '2090-01-01', 'pending_review', ?, ?)`,
    [coiId, subId, gcId, 'SelfCarrier', now, now])
  await dbRun('INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, ?, ?)',
    [coiId, 'tag', JSON.stringify({ source: 'mixed' })])
  await dbRun('INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)',
    [coiId, 'rev-a'])

  const res = await api(`/api/cois/${coiId}/validate`, { method: 'POST', token: token(gcId) })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  const review = await dbGet<{ details_json: string }>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [coiId])
  assert.equal(JSON.parse(review!.details_json).source, 'manual')
  const ver = await dbGet<{ revision: string }>('SELECT revision FROM coi_field_review_versions WHERE coi_id = ?', [coiId])
  assert.notEqual(ver!.revision, 'rev-a')
})
