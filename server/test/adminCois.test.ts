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

test('1.1 each queue tab returns the right rows and KPI count matches pending tab count', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const admin = await createAdmin()
    const p1 = await createCOI({ status: 'pending_review' })
    const p2 = await createCOI({ status: 'pending_review' })
    const c1 = await createCOI({ status: 'compliant' })
    const r1 = await createCOI({ status: 'needs_revision' })
    const j1 = await createCOI({ status: 'rejected' })
    await dbRun(`INSERT INTO coi_field_reviews (coi_id, source_tag, details_json) VALUES (?, 'tag', ?)`, [p2, JSON.stringify({ source: 'ocr', insured: {}, policies: [] })])

    const get = async (params: string) => {
      const res = await fetch(`${base}/api/admin/cois?${params}`, { headers: { Authorization: `Bearer ${admin.token}` } })
      assert.equal(res.status, 200)
      return res.json() as Promise<any>
    }

    const pending = await get('filter=pending')
    assert.ok(pending.items.every((i: any) => i.status === 'pending_review'))
    assert.ok(pending.items.some((i: any) => i.id === p1))
    assert.ok(pending.items.some((i: any) => i.id === p2))

    const ai = await get('filter=ai_pending')
    assert.ok(ai.items.some((i: any) => i.id === p2))
    assert.ok(!ai.items.some((i: any) => i.id === p1))

    const compliant = await get('status=compliant')
    assert.ok(compliant.items.every((i: any) => i.status === 'compliant'))
    assert.ok(compliant.items.some((i: any) => i.id === c1))

    const revision = await get('status=needs_revision')
    assert.ok(revision.items.every((i: any) => i.status === 'needs_revision'))
    assert.ok(revision.items.some((i: any) => i.id === r1))

    const rejected = await get('status=rejected')
    assert.ok(rejected.items.every((i: any) => i.status === 'rejected'))
    assert.ok(rejected.items.some((i: any) => i.id === j1))

    const all = await get('filter=all')
    const ids = all.items.map((i: any) => i.id)
    for (const id of [p1, p2, c1, r1, j1]) assert.ok(ids.includes(id))

    // KPI count and Pending tab count come from the same query
    const overview = await (await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.equal(pending.counts.pending, overview.platform.pending_reviews)
  } finally {
    server.close()
  }
})




test('1.3 INSURED_MATCH FAIL flag and 2.2 holding company parent warning', async () => {
  const admin = await createAdmin()
  const coiId = await createCOI({ status: 'pending_review', subName: 'Acme Electric' })
  await dbRun("UPDATE cois SET carrier = 'CNA Financial', status = 'pending_review' WHERE id = ?", [coiId])
  await dbRun("INSERT OR REPLACE INTO coi_field_reviews (coi_id, details_json, source_tag) VALUES (?, ?, ?)", [
    coiId,
    JSON.stringify({ insured: { name: 'TOTALLY DIFFERENT COMPANY LLC' }, source: 'ocr' }),
    new Date().toISOString(),
  ])
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res = await (await fetch(`${base}/api/admin/cois`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    const item = res.items.find((i: any) => i.id === coiId)
    assert.equal(item.insurer_is_parent, true)
    assert.equal(item.insured_match, false)
  } finally {
    server.close()
  }
})

test('1.2 funnel verified_cois matches compliant tab and tabs are mutually exclusive', async () => {
  const admin = await createAdmin()
  await createCOI({ status: 'compliant' })
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const ov = await (await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    const q = await (await fetch(`${base}/api/admin/cois`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.ok(ov.platform.verified_cois >= 1)
    assert.equal(q.counts.all, q.counts.pending + q.counts.compliant + q.counts.needs_revision + q.counts.rejected)
  } finally {
    server.close()
  }
})

test('7. sign-ups growth per day with range selector', async () => {
  const admin = await createAdmin()
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res30 = await (await fetch(`${base}/api/admin/overview?range=30d`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.equal(res30.growth.length, 30)
    assert.equal(res30.growth_range, '30d')
    const res7 = await (await fetch(`${base}/api/admin/overview?range=7d`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.equal(res7.growth.length, 7)
    const res12 = await (await fetch(`${base}/api/admin/overview?range=12m`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.equal(res12.growth.length, 12)
  } finally {
    server.close()
  }
})


test('8. dedicated review endpoint returns coi details checks score and cert url', async () => {
  const admin = await createAdmin()
  const coiId = await createCOI({ status: 'pending_review', subName: 'Rev Sub' })
  const coi = { id: coiId }
  await dbRun("INSERT OR REPLACE INTO coi_field_reviews (coi_id, details_json, source_tag) VALUES (?, ?, ?)", [
    coi.id,
    JSON.stringify({ insured: { name: 'Acme LLC' }, policies: [{ limits: [{ label: 'occurrence', amount: 1000000 }] }] }),
    'ocr',
  ])
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res = await (await fetch(`${base}/api/admin/cois/${coi.id}/review`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.equal(res.coi.id, coi.id)
    assert.ok(Array.isArray(res.checks) && res.checks.length >= 4)
    assert.equal(typeof res.score, 'number')
    assert.ok(res.score >= 0 && res.score <= 100)
    // decision endpoint
    const dec = await fetch(`${base}/api/admin/cois/${coi.id}/decision`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'compliant', notes: 'all good' }),
    })
    assert.equal(dec.status, 200)
    const row = await dbGet<any>('SELECT status, reviewer_notes FROM cois WHERE id = ?', [coi.id])
    assert.equal(row.status, 'compliant')
    assert.equal(row.reviewer_notes, 'all good')
  } finally {
    server.close()
  }
})

test('9. expired COI cannot be validated — returns 400', async () => {
  const admin = await createAdmin()
  const now = new Date().toISOString()
  const subId = randomUUID()
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Expired Sub', 'Electrical', ?, ?)`, [subId, now, now])
  const expiredCoiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at)
     VALUES (?, ?, 'Liberty', 'pending_review', '01/01/2026', '10/01/2026', ?, ?)`,
    [expiredCoiId, subId, now, now],
  )
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res = await fetch(`${base}/api/admin/cois/${expiredCoiId}/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
    })
    assert.equal(res.status, 400)
    const body: any = await res.json()
    assert.match(body.error, /expired/)
  } finally {
    server.close()
  }
})

test('10. review endpoint reports policy_expired: true for past expiration date', async () => {
  const admin = await createAdmin()
  const now = new Date().toISOString()
  const subId = randomUUID()
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Expired Sub 2', 'Electrical', ?, ?)`, [subId, now, now])
  const expiredCoiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at)
     VALUES (?, ?, 'Liberty', 'pending_review', '01/01/2026', '10/01/2026', ?, ?)`,
    [expiredCoiId, subId, now, now],
  )
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res = await (await fetch(`${base}/api/admin/cois/${expiredCoiId}/review`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })).json() as any
    assert.equal(res.policy_expired, true)
  } finally {
    server.close()
  }
})

test('11. queue items include is_expired boolean', async () => {
  const admin = await createAdmin()
  const now = new Date().toISOString()
  const subId = randomUUID()
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Expired Sub 3', 'Electrical', ?, ?)`, [subId, now, now])
  const expiredCoiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at)
     VALUES (?, ?, 'Liberty', 'pending_review', '01/01/2026', '10/01/2026', ?, ?)`,
    [expiredCoiId, subId, now, now],
  )
  const futureCoiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at)
     VALUES (?, ?, 'Liberty', 'pending_review', '01/01/2026', '10/01/2027', ?, ?)`,
    [futureCoiId, subId, now, now],
  )
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const res = await (await fetch(`${base}/api/admin/cois?filter=pending`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })).json() as any
    const expItem = res.items.find((i: any) => i.id === expiredCoiId)
    const futItem = res.items.find((i: any) => i.id === futureCoiId)
    assert.equal(expItem.is_expired, true)
    assert.equal(futItem.is_expired, false)
  } finally {
    server.close()
  }
})
