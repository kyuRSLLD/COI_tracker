import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-admin-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.JWT_SECRET = 'test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

async function createAdmin() {
  const now = new Date().toISOString()
  const id = randomUUID()
  await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'Admin', 'admin', ?)`, [id, `${id}@admin.test`, now])
  return { id, token: signToken({ id, email: `${id}@admin.test`, role: 'admin' }) }
}

async function createCOI(opts: { status?: string; key?: string; subName?: string }) {
  const now = new Date().toISOString()
  const subId = randomUUID()
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, 'Electrical', ?, ?)`, [subId, opts.subName || 'Acme Electric', now, now])
  const coiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
     VALUES (?, ?, 'Liberty', ?, '01/01/2026', '12/31/2026', ?, 'coi.png', 1, 'image/png', ?, ?)`,
    [coiId, subId, opts.status || 'pending_review', opts.key ?? null, now, now],
  )
  return coiId
}

test('admin can list COIs with counts and filter', async (t) => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const admin = await createAdmin()
    await createCOI({ status: 'pending_review' })
    await createCOI({ status: 'compliant' })

    const res = await fetch(`${base}/api/admin/cois?filter=pending`, { headers: { Authorization: `Bearer ${admin.token}` } })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.ok(Array.isArray(body.items))
    assert.ok(body.items.length >= 1)
    assert.ok(body.items.every((i: any) => i.status === 'pending_review'))
    assert.equal(typeof body.counts.pending, 'number')
    assert.ok(body.counts.all >= body.counts.pending)

    // non-admin rejected
    const bad = await fetch(`${base}/api/admin/cois`, { headers: { Authorization: `Bearer fake` } })
    assert.ok(bad.status === 401 || bad.status === 403)
  } finally {
    server.close()
  }
})

test('admin can validate a COI and human-verify AI source', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const admin = await createAdmin()
    const id = await createCOI({ status: 'pending_review' })
    await dbRun(`INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, 'tag', ?)`, [id, JSON.stringify({ source: 'ocr', insured: { name: 'Acme' }, policies: [] })])

    const res = await fetch(`${base}/api/admin/cois/${id}/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'Verified by admin' }),
    })
    assert.equal(res.status, 200)

    const coi = await dbGet<any>('SELECT status, reviewer_notes, review_date FROM cois WHERE id = ?', [id])
    assert.equal(coi.status, 'compliant')
    assert.equal(coi.reviewer_notes, 'Verified by admin')
    assert.ok(coi.review_date)

    const rev = await dbGet<any>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [id])
    assert.equal(JSON.parse(rev.details_json).source, 'manual')
  } finally {
    server.close()
  }
})

test('admin can set status, batch validate, and fetch certificate-url', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const admin = await createAdmin()
    const id1 = await createCOI({ status: 'pending_review' })
    const id2 = await createCOI({ status: 'pending_review' })

    const s = await fetch(`${base}/api/admin/cois/${id1}/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'needs_revision' }),
    })
    assert.equal(s.status, 200)
    assert.equal((await dbGet<any>('SELECT status FROM cois WHERE id = ?', [id1])).status, 'needs_revision')

    const b = await fetch(`${base}/api/admin/cois/batch-validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id1, id2] }),
    })
    assert.equal(b.status, 200)
    assert.equal((await dbGet<any>('SELECT status FROM cois WHERE id = ?', [id1])).status, 'compliant')
    assert.equal((await dbGet<any>('SELECT status FROM cois WHERE id = ?', [id2])).status, 'compliant')

    const url = await fetch(`${base}/api/admin/cois/${id1}/certificate-url`, { headers: { Authorization: `Bearer ${admin.token}` } })
    assert.equal(url.status, 404) // no certificate_key
  } finally {
    server.close()
  }
})
