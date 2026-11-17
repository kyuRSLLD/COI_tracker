import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-gcupload-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
 process.env.JWT_SECRET = 'gc-upload-test-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

function makeForm(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  if (file) {
    const blob = new Blob([file.data], { type: file.type })
    fd.append('certificate', blob, file.name)
  }
  return fd
}

test('GC upload suite', async (t) => {
  let server: any
  t.after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((err: any) => err ? reject(err) : resolve()))
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const app = await createApp({ maintenanceMode: false })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  const gcId = randomUUID()
  const subId = randomUUID()
  const email = `gc-${Date.now()}@example.demo`
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, company_name, created_at)
     VALUES (?, ?, 'x', 'GC Tester', 'gc', 'GC Upload LLC', ?)`,
    [gcId, email, now],
  )
  await dbRun(
    `INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at)
     VALUES (?, 'Acme Mechanical', 'HVAC', ?, ?)`,
    [subId, now, now],
  )
  await dbRun(
    `INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at)
     VALUES (?, ?, ?)`,
    [gcId, subId, now],
  )

  const token = signToken({ id: gcId, email, role: 'gc' })

  await t.test('POST /api/cois creates a COI with only subcontractor_id — carrier and dates optional', async () => {
    const fd = makeForm({ subcontractor_id: subId })
    const res = await fetch(`${base}/api/cois`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
    const text = await res.text()
    assert.equal(res.status, 201, text)
    const coi = JSON.parse(text).coi
    assert.equal(coi.subcontractor_id, subId)
    assert.equal(coi.carrier, 'Not provided')
    assert.equal(coi.status, 'pending_review')
    const row = await dbGet<any>('SELECT carrier, effective_date, expiration_date FROM cois WHERE id = ?', [coi.id])
    assert.equal(row.carrier, 'Not provided')
    assert.equal(row.effective_date, '')
    assert.equal(row.expiration_date, '')
  })

  await t.test('POST /api/cois without subcontractor_id creates a provisional subcontractor', async () => {
    const fd = makeForm({ carrier: 'Travelers' })
    const res = await fetch(`${base}/api/cois`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
    assert.equal(res.status, 201)
    const coi = JSON.parse(await res.text()).coi
    const sub = await dbGet<any>('SELECT company_name, trade FROM subcontractors WHERE id = ?', [coi.subcontractor_id])
    assert.equal(sub.company_name, 'Pending document scan')
    assert.equal(sub.trade, 'Other')
    const conn = await dbGet<any>('SELECT 1 FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gcId, coi.subcontractor_id])
    assert.ok(conn)
  })

  await t.test('POST /api/cois with effective > expiration returns 400', async () => {
    const fd = makeForm({
      subcontractor_id: subId,
      effective_date: '2027-01-01',
      expiration_date: '2026-01-01',
    })
    const res = await fetch(`${base}/api/cois`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
    assert.equal(res.status, 400)
    assert.match(JSON.parse(await res.text()).error, /Effective date/)
  })

  await t.test('POST /api/cois stores file metadata on multipart upload', async () => {
    const fakePdf = Buffer.from('%PDF-1.4 test certificate')
    const fd = makeForm(
      { subcontractor_id: subId, carrier: 'The Hartford', policy_number: 'HTF-99-TEST' },
      { name: 'sample.pdf', type: 'application/pdf', data: fakePdf },
    )
    const res = await fetch(`${base}/api/cois`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
    assert.equal(res.status, 201)
    const coi = JSON.parse(await res.text()).coi
    assert.equal(coi.carrier, 'The Hartford')
    const row = await dbGet<any>('SELECT certificate_name, certificate_mime, certificate_size FROM cois WHERE id = ?', [coi.id])
    assert.equal(row.certificate_name, 'sample.pdf')
    assert.equal(row.certificate_mime, 'application/pdf')
    assert.ok(row.certificate_size > 0)
  })

  await t.test('POST /api/cois with all manual fields preserves them', async () => {
    const fd = makeForm({
      subcontractor_id: subId,
      carrier: 'Travelers',
      am_best_rating: 'A+ Superior',
      policy_number: 'TC-123456',
      effective_date: '2025-01-01',
      expiration_date: '2026-01-01',
      status: 'pending_review',
      reviewer_notes: 'Manual GC entry',
    })
    const res = await fetch(`${base}/api/cois`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
    assert.equal(res.status, 201)
    const row = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [JSON.parse(await res.text()).coi.id])
    assert.equal(row.carrier, 'Travelers')
    assert.equal(row.am_best_rating, 'A+ Superior')
    assert.equal(row.policy_number, 'TC-123456')
    assert.equal(row.effective_date, '2025-01-01')
    assert.equal(row.expiration_date, '2026-01-01')
    assert.equal(row.reviewer_notes, 'Manual GC entry')
  })
})
