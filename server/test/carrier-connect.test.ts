import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set these before importing the application; never open a configured production DB or S3 bucket.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-carrier-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.JWT_SECRET = 'test-only-secret'

const { createApp } = await import('../src/app.ts')
const { dbGet, dbRun } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')
const { computeSubcontractorStatus } = await import('../src/services/compliance.ts')

test('carrier-connect fails closed; historic simulations are labeled and PDF upload works', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  let uploadedKey: string | undefined
  try {
    const now = new Date().toISOString()
    await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['sub-test', 'user-test', 'Test Trade', 'Electrical', 'sub@example.test', now, now])
    const token = (role: string, id = 'user-test') => signToken({ id, email: 'sub@example.test', role, name: 'Test User' })
    const headers = { authorization: `Bearer ${token('sub')}` }
    const before = await dbGet<any>('SELECT (SELECT COUNT(*) FROM cois) AS cois, (SELECT COUNT(*) FROM coi_coverages) AS coverages, (SELECT COUNT(*) FROM subcontractors) AS subs')
    for (const auth of [undefined, 'Bearer invalid', ...['sub', 'gc', 'admin'].map((role) => `Bearer ${token(role, role === 'sub' ? 'user-test' : `unlinked-${role}`)}`)]) {
      for (const body of [{}, { carrier: 'Travelers', policy_number: 'TEST-123' }]) {
        const response = await fetch(`${base}/api/sub/carrier-connect`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
        })
        assert.equal(response.status, 503)
        const payload = await response.json() as any
        assert.match(payload.error, /unavailable/i)
        assert.equal(payload.verified, undefined)
        assert.equal(payload.coi, undefined)
      }
    }
    const after = await dbGet<any>('SELECT (SELECT COUNT(*) FROM cois) AS cois, (SELECT COUNT(*) FROM coi_coverages) AS coverages, (SELECT COUNT(*) FROM subcontractors) AS subs')
    assert.deepEqual(after, before)

    // A historical fixture with the exact old markers must never count as compliant.
    await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, policy_number, effective_date, expiration_date, status, certificate_url, reviewer_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-simulation', 'sub-test', 'Travelers', 'FAKE', '2020-01-01', '2099-01-01', 'compliant', 'carrier-connect://verified', 'Instant verification via simulated carrier connect', now, now])
    await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit) VALUES (?, ?, ?, ?)', ['fake-coverage', 'old-simulation', 'General Liability', '$1000000'])
    await dbRun('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', ['project-test', 'Test Project', now])
    await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', ['link-test', 'project-test', 'sub-test', now])
    await dbRun('INSERT INTO client_share_links (id, project_id, token, created_at) VALUES (?, ?, ?, ?)', ['share-test', 'project-test', 'public-test', now])
    await dbRun('INSERT INTO upload_requests (id, subcontractor_id, token, created_at) VALUES (?, ?, ?, ?)', ['request-test', 'sub-test', 'upload-test', now])

    const my = await (await fetch(`${base}/api/sub/my`, { headers })).json() as any
    assert.equal(my.cois[0].simulated_carrier_connect, true)
    assert.equal(my.cois[0].status, 'pending_review')
    const publicSub = await (await fetch(`${base}/api/sub/public/sub-test`)).json() as any
    assert.equal(publicSub.coi.simulated_carrier_connect, true)
    assert.equal(publicSub.coi.status, 'pending_review')
    assert.deepEqual(publicSub.coi.coverages, [])
    const gcDetail = await (await fetch(`${base}/api/subcontractors/sub-test`, { headers })).json() as any
    assert.equal(gcDetail.subcontractor.computed_status, 'pending_review')
    assert.equal(gcDetail.subcontractor.cois[0].simulated_carrier_connect, true)
    const project = await (await fetch(`${base}/api/projects/project-test`, { headers })).json() as any
    assert.equal(project.project.scorecard.pending, 1)
    assert.equal(project.project.subcontractors[0].cois[0].simulated_carrier_connect, true)
    const coiList = await (await fetch(`${base}/api/cois`, { headers })).json() as any
    assert.equal(coiList.cois[0].status, 'pending_review')
    assert.equal(coiList.cois[0].simulated_carrier_connect, true)
    const compliantList = await (await fetch(`${base}/api/cois?status=compliant`, { headers })).json() as any
    assert.equal(compliantList.cois.length, 0)
    const pendingList = await (await fetch(`${base}/api/cois?status=pending_review`, { headers })).json() as any
    assert.equal(pendingList.cois[0].simulated_carrier_connect, true)
    const history = await (await fetch(`${base}/api/upload/my/upload-test`)).json() as any
    assert.equal(history.cois[0].status, 'pending_review')
    assert.equal(history.cois[0].simulated_carrier_connect, true)
    const report = await (await fetch(`${base}/api/client/share/public-test`)).json() as any
    assert.equal(report.scorecard.compliant, 0)
    assert.equal(report.scorecard.pending, 1)
    assert.equal(report.subcontractors[0].cois[0].simulated_carrier_connect, true)
    assert.deepEqual(report.subcontractors[0].cois[0].coverages, [])
    const email = await fetch(`${base}/api/sub/send-coi-email`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ to_email: 'gc@example.test' }) })
    assert.equal(email.status, 409)
    assert.match((await email.json() as any).error, /simulation.*not verified/i)
    const unchanged = await dbGet<any>('SELECT status, certificate_url, reviewer_notes FROM cois WHERE id = ?', ['old-simulation'])
    assert.deepEqual(unchanged, { status: 'compliant', certificate_url: 'carrier-connect://verified', reviewer_notes: 'Instant verification via simulated carrier connect' })
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01', reviewer_notes: 'Instant verification via simulated carrier connect' }]).status, 'pending_review')
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01' }]).status, 'compliant')

    const form = new FormData()
    form.append('certificate', new Blob(['%PDF-1.4\n% synthetic test PDF\n'], { type: 'application/pdf' }), 'test.pdf')
    const upload = await fetch(`${base}/api/sub/quick-upload`, { method: 'POST', headers, body: form })
    assert.equal(upload.status, 200)
    const uploaded = await upload.json() as any
    uploadedKey = uploaded.certificate_key
    assert.equal(uploaded.status, 'pending_review')
    assert.equal(uploaded.certificate_name, 'test.pdf')
    assert.ok(uploaded.certificate_url.startsWith('/uploads/'))
    const file = await fetch(`${base}${uploaded.certificate_url}`)
    assert.equal(file.status, 200)
    assert.match(await file.text(), /^%PDF-1\.4/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    if (uploadedKey) fs.rmSync(path.resolve(import.meta.dirname, '../uploads', uploadedKey), { force: true })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
