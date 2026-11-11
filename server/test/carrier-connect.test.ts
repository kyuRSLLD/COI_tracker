import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import bcrypt from 'bcryptjs'

// Work from a disposable source copy and empty environment; never load a local .env,
// production database, or cloud credentials, and never write into real uploads.
const repoServer = path.resolve(import.meta.dirname, '..')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-carrier-test-'))
const copy = path.join(tempDir, 'server')
fs.mkdirSync(copy)
fs.cpSync(path.join(repoServer, 'src'), path.join(copy, 'src'), { recursive: true })
fs.symlinkSync(path.join(repoServer, 'node_modules'), path.join(copy, 'node_modules'), 'dir')
fs.symlinkSync(path.join(repoServer, '..', 'node_modules'), path.join(tempDir, 'node_modules'), 'dir')
const oldCwd = process.cwd()
const oldEnv = { ...process.env }
process.chdir(tempDir)
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: oldEnv.PATH || '/usr/bin:/bin', HOME: tempDir, TMPDIR: tempDir,
  NODE_ENV: 'test', SQLITE_PATH: path.join(tempDir, 'test.sqlite'), JWT_SECRET: 'isolated-test-only-secret',
  MFA_ENCRYPTION_KEY: '1234567890abcdef0123456789abcdefabcdef0123456789fedcba9876543210', AWS_EC2_METADATA_DISABLED: 'true' })
process.once('exit', () => { try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {} })
const moduleUrl = (file: string) => pathToFileURL(path.join(copy, 'src', file)).href
const { createApp } = await import(moduleUrl('app.ts'))
const { dbGet, dbRun } = await import(moduleUrl('db/db.ts'))
const { signToken } = await import(moduleUrl('middleware/auth.ts'))
const { computeSubcontractorStatus } = await import(moduleUrl('services/compliance.ts'))
const { totpForCounter } = await import(moduleUrl('services/adminMfa.ts'))

test('carrier connect fails closed and historic simulations cannot be represented or approved as compliant', async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const now = new Date().toISOString()
    for (const [id, role] of [['user-test', 'sub'], ['gc-test', 'gc']]) {
      await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, `${id}@example.test`, 'unused', id, role, now])
    }
    await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['sub-test', 'user-test', 'Test Trade', 'Electrical', 'sub@example.test', now, now])
    const token = (id: string, role: string) => signToken({ id, email: `${id}@example.test`, role, name: id })
    const headers = { authorization: `Bearer ${token('user-test', 'sub')}` }
    const gcHeaders = { authorization: `Bearer ${token('gc-test', 'gc')}` }
    const before = await dbGet<any>('SELECT (SELECT COUNT(*) FROM cois) AS cois, (SELECT COUNT(*) FROM coi_coverages) AS coverages, (SELECT COUNT(*) FROM subcontractors) AS subs')
    for (const [auth, expected] of [[undefined, 401], ['Bearer invalid', 401], [headers.authorization, 503], [gcHeaders.authorization, 403]] as const) {
      for (const body of [{}, { carrier: 'Travelers', policy_number: 'TEST-123', password: 'not-a-real-secret' }]) {
        const response = await fetch(`${base}/api/sub/carrier-connect`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body),
        })
        assert.equal(response.status, expected)
        const payload = await response.json() as any
        assert.equal(payload.verified, undefined)
        assert.equal(payload.coi, undefined)
        assert.ok(!JSON.stringify(payload).includes('not-a-real-secret'))
      }
    }
    assert.deepEqual(await dbGet('SELECT (SELECT COUNT(*) FROM cois) AS cois, (SELECT COUNT(*) FROM coi_coverages) AS coverages, (SELECT COUNT(*) FROM subcontractors) AS subs'), before)
    await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, policy_number, effective_date, expiration_date, status, certificate_url, reviewer_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['old-simulation', 'sub-test', 'Travelers', 'FAKE', '2020-01-01', '2099-01-01', 'compliant', 'carrier-connect://verified', 'Instant verification via simulated carrier connect', now, now])
    await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit) VALUES (?, ?, ?, ?)', ['fake-coverage', 'old-simulation', 'General Liability', '$1000000'])
    await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['project-test', 'gc-test', 'Test Project', now])
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
    const gcDetail = await (await fetch(`${base}/api/subcontractors/sub-test`, { headers: gcHeaders })).json() as any
    assert.equal(gcDetail.subcontractor.computed_status, 'pending_review')
    assert.equal(gcDetail.subcontractor.cois[0].simulated_carrier_connect, true)
    const project = await (await fetch(`${base}/api/projects/project-test`, { headers: gcHeaders })).json() as any
    assert.equal(project.project.scorecard.compliant, 0)
    assert.equal(project.project.scorecard.pending, 1)
    assert.equal(project.project.subcontractors[0].cois[0].simulated_carrier_connect, true)
    const coiList = await (await fetch(`${base}/api/cois`, { headers: gcHeaders })).json() as any
    assert.equal(coiList.cois[0].status, 'pending_review')
    assert.equal(coiList.cois[0].simulated_carrier_connect, true)
    const detail = await (await fetch(`${base}/api/cois/old-simulation`, { headers: gcHeaders })).json() as any
    assert.equal(detail.coi.status, 'pending_review')
    const compliantList = await (await fetch(`${base}/api/cois?status=compliant`, { headers: gcHeaders })).json() as any
    assert.equal(compliantList.cois.length, 0)
    const pendingList = await (await fetch(`${base}/api/cois?status=pending_review`, { headers: gcHeaders })).json() as any
    assert.equal(pendingList.cois[0].simulated_carrier_connect, true)
    const history = await (await fetch(`${base}/api/upload/my/upload-test`)).json() as any
    assert.equal(history.cois[0].status, 'pending_review')
    assert.equal(history.cois[0].simulated_carrier_connect, true)
    const report = await (await fetch(`${base}/api/client/share/public-test`)).json() as any
    assert.equal(report.scorecard.compliant, 0)
    assert.equal(report.scorecard.pending, 1)
    assert.equal(report.subcontractors[0].cois[0].simulated_carrier_connect, true)
    assert.deepEqual(report.subcontractors[0].cois[0].coverages, [])
    const stats = await (await fetch(`${base}/api/stats`, { headers: gcHeaders })).json() as any
    assert.equal(stats.totals.compliant, 0)
    assert.equal(stats.totals.pending, 1)
    const evidence = await (await fetch(`${base}/api/verification/projects/project-test/evidence`, { headers: gcHeaders })).json() as any
    const certificate = evidence.subcontractors[0].certificates[0]
    assert.equal(certificate.status, 'pending_review')
    assert.equal(certificate.simulated_carrier_connect, true)
    assert.equal(certificate.evidence.gl_per_occurrence.value, null)
    assert.equal(certificate.evaluation.status, 'needs_review')
    assert.equal(certificate.reviewer_notes, undefined)
    const email = await fetch(`${base}/api/sub/send-coi-email`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ to_email: 'gc@example.test' }) })
    assert.equal(email.status, 409)
    assert.match((await email.json() as any).error, /simulation.*not verified/i)
    for (const endpoint of ['old-simulation', 'old-simulation/review']) {
      const response = await fetch(`${base}/api/cois/${endpoint}`, { method: 'PUT', headers: { ...gcHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'compliant', reviewer_notes: 'approved' }) })
      assert.equal(response.status, 409)
    }
    const unchanged = await dbGet<any>('SELECT status, certificate_url, reviewer_notes FROM cois WHERE id = ?', ['old-simulation'])
    assert.deepEqual(unchanged, { status: 'compliant', certificate_url: 'carrier-connect://verified', reviewer_notes: 'Instant verification via simulated carrier connect' })
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01', reviewer_notes: 'Instant verification via simulated carrier connect' }]).status, 'pending_review')
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01', certificate_url: 'carrier-connect://verified' }]).status, 'pending_review')
    assert.equal(computeSubcontractorStatus({}, [{ status: 'compliant', expiration_date: '2099-01-01' }]).status, 'compliant')
    // Marker-only rows cannot lose the last marker via either update path.
    for (const [id, url, notes] of [['only-notes', null, 'Instant verification via simulated carrier connect'], ['only-url', 'carrier-connect://verified', null]]) {
      await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, certificate_url, reviewer_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, 'sub-test', 'Test', '2020-01-01', '2099-01-01', 'verified', url, notes, now, now])
      for (const suffix of ['', '/review']) {
        const response = await fetch(`${base}/api/cois/${id}${suffix}`, { method: 'PUT', headers: { ...gcHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'compliant', reviewer_notes: 'approved' }) })
        assert.equal(response.status, 409)
      }
    }
    await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['admin-test', 'admin@example.test', await bcrypt.hash('disposable-password', 4), 'Admin', 'admin', now])
    const jsonPost = async (url: string, body: object, auth?: string) => {
      const response = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
      return await response.json() as any
    }
    const challenge = await jsonPost('/api/auth/login', { email: 'admin@example.test', password: 'disposable-password' })
    const enrollment = await jsonPost('/api/auth/admin-mfa/enroll', {}, challenge.challenge_token)
    let bits = 0, value = 0
    const bytes: number[] = []
    for (const char of enrollment.secret as string) {
      value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char)
      bits += 5
      if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255) }
    }
    const session = await jsonPost('/api/auth/admin-mfa/verify', { code: totpForCounter(Buffer.from(bytes), Math.floor(Date.now() / 30000)) }, challenge.challenge_token)
    const overviewResponse = await fetch(`${base}/api/admin/overview`, { headers: { authorization: `Bearer ${session.token}` } })
    assert.equal(overviewResponse.status, 200)
    const overview = await overviewResponse.json() as any
    assert.equal(overview.platform.pending_reviews, 3)
    assert.equal(overview.platform.verified_cois, 0)
    const pdf = await PDFDocument.create()
    pdf.addPage()
    const form = new FormData()
    form.append('certificate', new Blob([await pdf.save()], { type: 'application/pdf' }), 'test.pdf')
    const upload = await fetch(`${base}/api/sub/quick-upload`, { method: 'POST', headers, body: form })
    assert.equal(upload.status, 201)
    const uploaded = await upload.json() as any
    assert.equal(uploaded.status, 'pending_review')
    assert.equal(uploaded.carrier, null)
    assert.equal(uploaded.certificate_name, 'test.pdf')
    assert.ok(uploaded.certificate_url.startsWith('/api/sub/quick-upload/'))
    assert.equal((await fetch(`${base}${uploaded.certificate_url}`)).status, 200)
    assert.equal((await fetch(`${base}/uploads/${uploaded.certificate_name}`)).status, 404)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    process.chdir(oldCwd)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, oldEnv)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
