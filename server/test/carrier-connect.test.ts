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
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbAll, dbGet, dbRun } = await import('../src/db/db.ts')
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
    for (const [id, role] of [['user-test', 'sub'], ['gc-test', 'gc'], ['other-sub', 'sub']] as const) {
      await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, `${id}@example.test`, 'unused-test-hash', id, role, now])
    }
    await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['sub-test', 'user-test', 'Test Trade', 'Electrical', 'sub@example.test', now, now])
    await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['gc-test', 'sub-test', now])
    const token = (role: string, id = 'user-test') => signToken({ id, email: 'sub@example.test', role, name: 'Test User' })
    const headers = { authorization: `Bearer ${token('sub')}` }
    const gcHeaders = { authorization: `Bearer ${token('gc', 'gc-test')}` }
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
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, policy_number, effective_date, expiration_date, status, certificate_url, reviewer_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-simulation', 'sub-test', 'user-test', 'Travelers', 'FAKE', '2020-01-01', '2099-01-01', 'compliant', 'carrier-connect://verified', 'Instant verification via simulated carrier connect', now, now])
    await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit) VALUES (?, ?, ?, ?)', ['fake-coverage', 'old-simulation', 'General Liability', '$1000000'])
    await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['project-test', 'gc-test', 'Test Project', now])
    await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', ['link-test', 'project-test', 'sub-test', now])
    const shareToken = 'a'.repeat(48)
    const uploadToken = `gc1.${Buffer.from('gc-test').toString('base64url')}.${'b'.repeat(48)}`
    await dbRun('INSERT INTO client_share_links (id, project_id, token, created_at) VALUES (?, ?, ?, ?)', ['share-test', 'project-test', shareToken, now])
    await dbRun('INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, created_at) VALUES (?, ?, ?, ?, ?)', ['request-test', 'sub-test', uploadToken, 'gc-test@example.test', now])

    const my = await (await fetch(`${base}/api/sub/my`, { headers })).json() as any
    assert.equal(my.cois[0].simulated_carrier_connect, true)
    assert.equal(my.cois[0].status, 'pending_review')
    const publicSub = await fetch(`${base}/api/sub/public/sub-test`)
    assert.equal(publicSub.status, 410)
    assert.doesNotMatch(await publicSub.text(), /Travelers|FAKE|simulated_carrier_connect/)
    const gcDetail = await (await fetch(`${base}/api/subcontractors/sub-test`, { headers: gcHeaders })).json() as any
    assert.equal(gcDetail.subcontractor.computed_status, 'pending_review')
    assert.equal(gcDetail.subcontractor.cois[0].simulated_carrier_connect, true)
    const project = await (await fetch(`${base}/api/projects/project-test`, { headers: gcHeaders })).json() as any
    assert.equal(project.project.scorecard.pending, 1)
    assert.equal(project.project.subcontractors[0].cois[0].simulated_carrier_connect, true)
    const coiList = await (await fetch(`${base}/api/cois`, { headers: gcHeaders })).json() as any
    assert.equal(coiList.cois[0].status, 'pending_review')
    assert.equal(coiList.cois[0].simulated_carrier_connect, true)
    const compliantList = await (await fetch(`${base}/api/cois?status=compliant`, { headers: gcHeaders })).json() as any
    assert.equal(compliantList.cois.length, 0)
    const pendingList = await (await fetch(`${base}/api/cois?status=pending_review`, { headers: gcHeaders })).json() as any
    assert.equal(pendingList.cois[0].simulated_carrier_connect, true)
    const historyResponse = await fetch(`${base}/api/upload/my/${uploadToken}`)
    assert.equal(historyResponse.status, 200)
    const history = await historyResponse.json() as any
    assert.deepEqual(history.cois, [], 'an upload link must not expose certificate history')
    const report = await (await fetch(`${base}/api/client/share/${shareToken}`)).json() as any
    assert.equal(report.scorecard.compliant, 0)
    assert.equal(report.scorecard.pending, 1)
    assert.equal(report.subcontractors[0].cois[0].simulated_carrier_connect, true)
    assert.deepEqual(report.subcontractors[0].cois[0].coverages, [])
    const email = await fetch(`${base}/api/sub/send-coi-email`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ to_email: 'gc@example.test' }) })
    assert.equal(email.status, 503)
    assert.match((await email.json() as any).error, /sharing is unavailable/i)
    const unchanged = await dbGet<any>('SELECT status, certificate_url, reviewer_notes FROM cois WHERE id = ?', ['old-simulation'])
    assert.deepEqual(unchanged, { status: 'compliant', certificate_url: 'carrier-connect://verified', reviewer_notes: 'Instant verification via simulated carrier connect' })
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01', reviewer_notes: 'Instant verification via simulated carrier connect' }]).status, 'pending_review')
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01' }]).status, 'compliant')

    const form = new FormData()
    form.append('certificate', new Blob(['%PDF-1.4\n% synthetic test PDF\n'], { type: 'application/pdf' }), 'test.pdf')
    const upload = await fetch(`${base}/api/sub/quick-upload`, { method: 'POST', headers, body: form })
    assert.equal(upload.status, 200)
    const uploaded = await upload.json() as any
    const stored = await dbGet<any>('SELECT certificate_key, owner_sub_user_id FROM cois WHERE id = ?', [uploaded.id])
    uploadedKey = stored?.certificate_key
    assert.equal(stored?.owner_sub_user_id, 'user-test')
    assert.match(uploadedKey || '', /^[a-f0-9]{64}$/)
    assert.equal(Object.hasOwn(uploaded, 'certificate_key'), false)
    assert.equal(uploaded.status, 'pending_review')
    assert.equal(uploaded.certificate_name, 'test.pdf')
    assert.equal(uploaded.certificate_url, `/uploads/${uploadedKey}`)
    const anonymousFile = await fetch(`${base}${uploaded.certificate_url}`)
    assert.equal(anonymousFile.status, 401)
    assert.doesNotMatch(await anonymousFile.text(), /%PDF-1\.4/)
    const unrelatedFile = await fetch(`${base}${uploaded.certificate_url}`, { headers: { authorization: `Bearer ${token('sub', 'other-sub')}` } })
    assert.equal(unrelatedFile.status, 404)
    assert.doesNotMatch(await unrelatedFile.text(), /%PDF-1\.4/)
    for (const authorizedHeaders of [headers, gcHeaders]) {
      const file = await fetch(`${base}${uploaded.certificate_url}`, { headers: authorizedHeaders })
      assert.equal(file.status, 200)
      assert.equal(file.headers.get('cache-control'), 'no-store')
      assert.match(await file.text(), /^%PDF-1\.4/)
    }
    const myAfterUpload = await (await fetch(`${base}/api/sub/my`, { headers })).json() as any
    const subUploaded = myAfterUpload.cois.find((coi: any) => coi.id === uploaded.id)
    assert.ok(subUploaded)
    assert.equal(Object.hasOwn(subUploaded, 'certificate_key'), false)
    assert.equal(subUploaded.certificate_url, uploaded.certificate_url)
    const gcAfterUpload = await (await fetch(`${base}/api/cois`, { headers: gcHeaders })).json() as any
    const gcUploaded = gcAfterUpload.cois.find((coi: any) => coi.id === uploaded.id)
    assert.ok(gcUploaded)
    assert.equal(Object.hasOwn(gcUploaded, 'certificate_key'), false)
    assert.equal(gcUploaded.certificate_url, uploaded.certificate_url)
    const gcDetailAfterUpload = await (await fetch(`${base}/api/subcontractors/sub-test`, { headers: gcHeaders })).json() as any
    const detailUploaded = gcDetailAfterUpload.subcontractor.cois.find((coi: any) => coi.id === uploaded.id)
    assert.ok(detailUploaded)
    assert.equal(Object.hasOwn(detailUploaded, 'certificate_key'), false)
    assert.equal(detailUploaded.certificate_url, uploaded.certificate_url)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    // Look up this test's uploads even if an assertion failed before reading the response.
    const storedUploads = await dbAll('SELECT certificate_key FROM cois WHERE owner_sub_user_id = ? AND certificate_name = ?', ['user-test', 'test.pdf'])
    for (const { certificate_key: key } of storedUploads) {
      if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) fs.rmSync(path.resolve(import.meta.dirname, '../uploads', key), { force: true })
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
