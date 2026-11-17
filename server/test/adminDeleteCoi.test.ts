import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-admin-del-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'admin-del-test-secret-only'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet, adminDeleteCOI, initDatabase } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

await initDatabase()

const now = () => new Date().toISOString()

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createAdmin() {
  const id = randomUUID()
  const email = `admin-${id}@example.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', 'Admin', 'admin', ?)`,
    [id, email, now()],
  )
  return { id, token: signToken({ id, email, role: 'admin', name: 'Admin' }) }
}

async function createGc() {
  const id = randomUUID()
  const email = `gc-${id}@example.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', 'GC', 'gc', ?)`,
    [id, email, now()],
  )
  return { id, token: signToken({ id, email, role: 'gc', name: 'GC' }) }
}

async function setup() {
  await dbRun('DELETE FROM coi_field_reviews')
  await dbRun('DELETE FROM coi_coverages')
  await dbRun('DELETE FROM cois')
  await dbRun('DELETE FROM subcontractors')
  await dbRun('DELETE FROM users')
}

async function seedCOI(opts: { expiration_date: string; status?: string }) {
  const subId = randomUUID()
  const coiId = randomUUID()
  await dbRun(
    `INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Test Sub', 'Electrical', ?, ?)`,
    [subId, now(), now()],
  )
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at)
     VALUES (?, ?, 'Acme Insurance', ?, '2026-01-01', ?, ?, ?)`,
    [coiId, subId, opts.status ?? 'pending_review', opts.expiration_date, now(), now()],
  )
  await dbRun(
    `INSERT INTO coi_coverages (id, coi_id, type) VALUES (?, ?, 'General Liability')`,
    [randomUUID(), coiId],
  )
  await dbRun(
    `INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, 'src', ?)`,
    [coiId, JSON.stringify({ source: 'manual' })],
  )
  return { subId, coiId }
}

test('adminDeleteCOI removes the COI row plus coverages and field reviews', async () => {
  await setup()
  const { coiId } = await seedCOI({ expiration_date: '2027-12-31' })
  assert.ok(await dbGet('SELECT id FROM cois WHERE id = ?', [coiId]))
  assert.ok(await dbGet('SELECT id FROM coi_coverages WHERE coi_id = ?', [coiId]))
  assert.ok(await dbGet('SELECT coi_id FROM coi_field_reviews WHERE coi_id = ?', [coiId]))

  const ok = await adminDeleteCOI(coiId)
  assert.equal(ok, true)
  assert.equal(await dbGet('SELECT id FROM cois WHERE id = ?', [coiId]), undefined)
  assert.equal(await dbGet('SELECT id FROM coi_coverages WHERE coi_id = ?', [coiId]), undefined)
  assert.equal(await dbGet('SELECT coi_id FROM coi_field_reviews WHERE coi_id = ?', [coiId]), undefined)

  assert.equal(await adminDeleteCOI(coiId), false)
})

test('DELETE /api/admin/cois/:id deletes pending COI (admin only)', async () => {
  await setup()
  const admin = await createAdmin()
  const { port, close } = await startServer()
  try {
    const { coiId } = await seedCOI({ expiration_date: '2027-12-31' })
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/cois/${coiId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.id, coiId)
    assert.equal(await dbGet('SELECT id FROM cois WHERE id = ?', [coiId]), undefined)
  } finally {
    close()
  }
})

test('DELETE /api/admin/cois/:id returns 404 for unknown COI', async () => {
  await setup()
  const admin = await createAdmin()
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/cois/${randomUUID()}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.status, 404)
  } finally {
    close()
  }
})

test('DELETE /api/admin/cois/:id returns 403 for non-admin GC user', async () => {
  await setup()
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const { coiId } = await seedCOI({ expiration_date: '2027-12-31' })
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/cois/${coiId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 403)
    assert.ok(await dbGet('SELECT id FROM cois WHERE id = ?', [coiId]))
  } finally {
    close()
  }
})

test('admin can delete expired COI without validation', async () => {
  await setup()
  const admin = await createAdmin()
  const { port, close } = await startServer()
  try {
    const { coiId } = await seedCOI({ expiration_date: '2020-01-01' })
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/cois/${coiId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.status, 200)
    assert.equal(await dbGet('SELECT id FROM cois WHERE id = ?', [coiId]), undefined)
  } finally {
    close()
  }
})
