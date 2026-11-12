import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Never connect to a configured external database, S3, or SMTP service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-upload-privacy-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.NODE_ENV = 'test'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_REGION = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'upload-privacy-test-only-secret'

const { createApp } = await import('../src/app.ts')
const { dbAll, dbGet, dbRun, isPostgres } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

function assertNoPrivateValues(value: unknown, secrets: string[]) {
  const raw = JSON.stringify(value)
  for (const secret of secrets) assert.ok(!raw.includes(secret), `response leaked ${secret}`)
}

test('QR connection and GC upload links do not give anonymous holders profile or certificate history', async (t) => {
  assert.equal(isPostgres, false)
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  const uniqueFile = `privacy-${path.basename(tempDir)}.pdf`
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    const uploads = path.resolve(import.meta.dirname, '../uploads')
    if (fs.existsSync(uploads)) {
      for (const filename of fs.readdirSync(uploads)) {
        if (filename.endsWith(uniqueFile)) fs.rmSync(path.join(uploads, filename), { force: true })
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const now = new Date().toISOString()
  const privateValues = [
    'SUB-PRIVATE-CONTACT', '555-765-1234', 'private-sub@example.test', '123 Private Street',
    'SUB-PRIVATE-NOTES', 'GC-PRIVATE-CONTACT', '555-444-7890', 'private-gc@example.test',
    '999 Contractor Road', 'GC-SECRET-WORDING', 'MESSAGE-CONTAINS-PRIVATE',
    'old-sub-coi', 'old-gc-coi', 'old-other-coi', 'old-legacy-coi',
    'SECRET-CARRIER-', 'SECRET-POLICY-', 'SECRET-COVERAGE-', 'SECRET-REVIEW-'
  ]
  for (const [id, role] of [['sub-user', 'sub'], ['gc-user', 'gc'], ['other-gc', 'gc']] as const) {
    await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, `${id}@example.test`, 'unused', id, role, now])
  }
  await dbRun(`INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, phone, email, address, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['owned-profile', 'sub-user', 'Synthetic Electrical Co', 'Electrical', 'SUB-PRIVATE-CONTACT', '555-765-1234',
      'private-sub@example.test', '123 Private Street', 'SUB-PRIVATE-NOTES', now, now])
  await dbRun(`INSERT INTO gc_settings (id, user_id, company_name, license_number, address, phone, email, additional_insured_wording, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['settings', 'gc-user', 'Synthetic GC', 'GC-PRIVATE-CONTACT', '999 Contractor Road', '555-444-7890', 'private-gc@example.test', 'GC-SECRET-WORDING', now])
  for (const [kind, gcOwner, subOwner] of [
    ['sub', null, 'sub-user'], ['gc', 'gc-user', null], ['other', 'other-gc', null], ['legacy', null, null]
  ] as const) {
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, owner_sub_user_id, carrier, policy_number,
      effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`old-${kind}-coi`, 'owned-profile', gcOwner, subOwner, `SECRET-CARRIER-${kind}`, `SECRET-POLICY-${kind}`,
        '2025-01-01', '2035-01-01', 'compliant', `SECRET-REVIEW-${kind}`, `SECRET-URL-${kind}`, `SECRET-KEY-${kind}`, now, now])
    await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, notes) VALUES (?, ?, ?, ?, ?)',
      [`coverage-${kind}`, `old-${kind}-coi`, 'General Liability', `SECRET-COVERAGE-${kind}`, `SECRET-REVIEW-${kind}`])
  }
  const auth = (id: string, role: string) => `Bearer ${signToken({ id, role, email: `${id}@example.test`, name: id })}`
  async function call(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${base}${endpoint}`, options)
    const text = await response.text()
    return { response, body: JSON.parse(text) as any }
  }
  const post = (endpoint: string, id: string | null, role: string, body: object) => call(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(id ? { authorization: auth(id, role) } : {}) },
    body: JSON.stringify(body),
  })
  const requestBody = { subcontractor_id: 'owned-profile', custom_message: 'MESSAGE-CONTAINS-PRIVATE', expires_in_days: 5 }

  assert.equal((await post('/api/emails/send-request', null, 'gc', requestBody)).response.status, 401)
  assert.equal((await post('/api/emails/send-request', 'sub-user', 'sub', requestBody)).response.status, 403)
  assert.equal((await post('/api/emails/send-request', 'gc-user', 'gc', requestBody)).response.status, 404)
  const issue = await post('/api/connection-qr', 'sub-user', 'sub', { consent: true })
  assert.equal(issue.response.status, 200)
  const redeem = await post('/api/connection-qr/redeem', 'gc-user', 'gc', { token: issue.body.token })
  assert.equal(redeem.response.status, 200)
  assert.deepEqual(redeem.body.subcontractor, { id: 'owned-profile', company_name: 'Synthetic Electrical Co' })

  // QR consent grants authenticated GC access, not general access to link holders.
  const gcDetails = await call('/api/subcontractors/owned-profile', { headers: { authorization: auth('gc-user', 'gc') } })
  assert.equal(gcDetails.response.status, 200)
  assert.deepEqual(gcDetails.body.subcontractor.cois.map((c: any) => c.id).sort(), ['old-gc-coi', 'old-sub-coi'])
  assert.equal((await call('/api/subcontractors/owned-profile')).response.status, 401)
  assert.equal((await post('/api/emails/send-request', 'other-gc', 'gc', requestBody)).response.status, 404)

  async function createRequest() {
    const result = await post('/api/emails/send-request', 'gc-user', 'gc', requestBody)
    assert.equal(result.response.status, 201)
    assert.equal(result.body.success, true)
    assert.equal(result.body.delivered, false, 'test email service is simulated')
    assert.ok(result.body.portalUrl.endsWith(`/upload/${result.body.token}`))
    return result.body.token as string
  }
  const token = await createRequest()
  const storedRequest = await dbGet<any>('SELECT * FROM upload_requests WHERE token = ?', [token])
  assert.ok(Date.parse(storedRequest.expires_at) > Date.now())
  const validate = await call(`/api/upload/validate/${token}`)
  assert.equal(validate.response.status, 200)
  assert.match(validate.response.headers.get('cache-control') || '', /no-store/)
  assert.deepEqual(validate.body, {
    subcontractor: { company_name: 'Synthetic Electrical Co', trade: 'Electrical' },
    gc: { company_name: 'Synthetic GC' },
    request: { expires_at: storedRequest.expires_at },
  })
  assertNoPrivateValues(validate.body, privateValues)
  const history = await call(`/api/upload/my/${token}`)
  assert.equal(history.response.status, 200)
  assert.match(history.response.headers.get('cache-control') || '', /no-store/)
  assert.deepEqual(history.body, { cois: [] })
  assertNoPrivateValues(history.body, privateValues)

  // Upload the actual file through the public capability; it belongs to the GC.
  const profileBefore = await dbGet('SELECT * FROM subcontractors WHERE id = ?', ['owned-profile'])
  const fileBytes = Buffer.from('%PDF-1.4\n% isolated synthetic certificate\n%%EOF\n')
  const form = new FormData()
  form.append('carrier', 'New Upload Carrier')
  form.append('policy_number', 'NEW-UPLOAD-POLICY')
  form.append('effective_date', '2026-01-01')
  form.append('expiration_date', '2036-01-01')
  form.append('coverages', JSON.stringify([{ type: 'General Liability', per_occurrence_limit: '$1000000' }]))
  form.append('contact_person', 'ATTACKER-CONTROLLED')
  form.append('certificate', new Blob([fileBytes], { type: 'application/pdf' }), uniqueFile)
  const submit = await call(`/api/upload/submit/${token}`, { method: 'POST', body: form })
  assert.equal(submit.response.status, 200)
  assert.equal(submit.body.success, true)
  assert.equal(submit.body.coi.carrier, 'New Upload Carrier')
  assert.equal(submit.body.coi.status, 'pending_review')
  assertNoPrivateValues(submit.body, privateValues)
  const inserted = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [submit.body.coi.id])
  assert.equal(inserted.owner_gc_user_id, 'gc-user')
  assert.equal(inserted.owner_sub_user_id, null)
  assert.equal(inserted.subcontractor_id, 'owned-profile')
  assert.deepEqual(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '../uploads'), inserted.certificate_key)), fileBytes)
  assert.equal((await dbAll('SELECT * FROM coi_coverages WHERE coi_id = ?', [inserted.id])).length, 1)
  assert.deepEqual(await dbGet('SELECT * FROM subcontractors WHERE id = ?', ['owned-profile']), profileBefore)
  const gcRead = await call(`/api/cois/${inserted.id}`, { headers: { authorization: auth('gc-user', 'gc') } })
  assert.equal(gcRead.response.status, 200)
  assert.equal(gcRead.body.coi.id, inserted.id)
  const used = await call(`/api/upload/my/${token}`)
  assert.equal(used.response.status, 410)
  assert.match(used.response.headers.get('cache-control') || '', /no-store/)
  assertNoPrivateValues(used.body, privateValues)
  assert.equal((await call(`/api/upload/validate/${token}`)).response.status, 410)
  const replay = await call(`/api/upload/submit/${token}`, { method: 'POST', body: form })
  assert.equal(replay.response.status, 410)
  assert.equal((await dbAll('SELECT id FROM cois WHERE carrier = ?', ['New Upload Carrier'])).length, 1)

  // A second GC-created link also cannot reveal the newly submitted COI.
  const secondToken = await createRequest()
  const secondHistory = await call(`/api/upload/my/${secondToken}`)
  assert.deepEqual(secondHistory.body, { cois: [] })
  assertNoPrivateValues(secondHistory.body, [...privateValues, 'New Upload Carrier', 'NEW-UPLOAD-POLICY', inserted.id])
  await dbRun('DELETE FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc-user', 'owned-profile'])
  for (const endpoint of ['validate', 'my']) {
    const disconnected = await call(`/api/upload/${endpoint}/${secondToken}`)
    assert.equal(disconnected.response.status, 404)
    assertNoPrivateValues(disconnected.body, privateValues)
  }
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['gc-user', 'owned-profile', now])
  await dbRun('UPDATE upload_requests SET expires_at = ? WHERE token = ?', ['2000-01-01T00:00:00.000Z', secondToken])
  for (const endpoint of ['validate', 'my']) {
    const expired = await call(`/api/upload/${endpoint}/${secondToken}`)
    assert.equal(expired.response.status, 410)
    assert.match(expired.response.headers.get('cache-control') || '', /no-store/)
    assertNoPrivateValues(expired.body, privateValues)
    const invalid = await call(`/api/upload/${endpoint}/invalid-token`)
    assert.equal(invalid.response.status, 404)
    assert.match(invalid.response.headers.get('cache-control') || '', /no-store/)
    assertNoPrivateValues(invalid.body, privateValues)
  }
})
