import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import express from 'express'
import bcrypt from 'bcryptjs'

const originalCwd = process.cwd()
const originalEnv = { ...process.env }
const temp = await mkdtemp(path.join(tmpdir(), 'verification-test-'))
// Protect against top-level setup failures, for which node:test may skip hooks.
process.once('exit', () => { try { rmSync(temp, { recursive: true, force: true }) } catch {} })
let server: Server | undefined
after(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()))
  } finally {
    process.chdir(originalCwd)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    await rm(temp, { recursive: true, force: true })
  }
})
// Prevent dotenv or inherited settings from directing the test at live services.
process.chdir(temp)
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  PATH: originalEnv.PATH || '/usr/bin:/bin', HOME: temp, TMPDIR: temp,
  NODE_ENV: 'test', SQLITE_PATH: path.join(temp, 'isolated.sqlite'),
  JWT_SECRET: randomBytes(32).toString('hex'), MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AWS_EC2_METADATA_DISABLED: 'true',
})
const { initDatabase, dbRun, isPostgres } = await import('../src/db/db.ts')
const { verificationRouter } = await import('../src/routes/verification.ts')
const { authRouter } = await import('../src/routes/auth.ts')
const { totpForCounter } = await import('../src/services/adminMfa.ts')
const { initVerificationRules, evaluateRequirements, parseLegacyDollar } = await import('../src/services/verificationRules.ts')
const { signToken } = await import('../src/middleware/auth.ts')

assert.equal(isPostgres, false, 'tests must use disposable SQLite only')
await initDatabase()
await initVerificationRules(); await initVerificationRules()
const password = 'test-only-password'
const passwordHash = await bcrypt.hash(password, 4)
const now = '2020-01-01T00:00:00.000Z'
for (const [id, role] of [['gc1', 'gc'], ['gc2', 'gc'], ['admin', 'admin'], ['sub1', 'sub']]) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, subcontractor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, `${id}@example.test`, passwordHash, id, role, role === 'sub' ? 's1' : null, now])
}
await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['p1', 'gc1', 'Project 1', now])
await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['p2', 'gc2', 'Project 2', now])
await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['legacy', null, 'Legacy', now])
await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['s1', 'sub1', 'Test Trade', 'Test', now, now])
await dbRun('INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['s2', 'Other Trade', 'Test', now, now])
await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', ['link1', 'p1', 's1', now])
await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', ['link2', 'p2', 's2', now])
await dbRun('INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['c1', 's1', 'Example', '2020-01-01', '2021-01-01', 'compliant', now, now])
await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit) VALUES (?, ?, ?, ?, ?)', ['cv1', 'c1', 'General Liability', '$1,000,000', '$2,000,000'])
const app = express(); app.use(express.json()); app.use('/api/auth', authRouter); app.use('/api/verification', verificationRouter)
server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
const address = server.address()
if (!address || typeof address === 'string') throw new Error('server not listening')
const api = `http://127.0.0.1:${address.port}/api`
const base = `${api}/verification/projects`
const token = (id: string, role: string) => signToken({ id, role, email: `${id}@example.test`, name: id })
const gc1 = token('gc1', 'gc'), gc2 = token('gc2', 'gc'), sub = token('sub1', 'sub')
const staleSub = token('gc1', 'sub')

async function authPost(route: string, body: unknown, bearer?: string) {
  const response = await fetch(`${api}/auth/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as any }
}
function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, n = 0; const bytes: number[] = []
  for (const char of value) {
    const digit = alphabet.indexOf(char); assert.notEqual(digit, -1)
    n = (n << 5) | digit; bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((n >>> bits) & 255) }
  }
  return Buffer.from(bytes)
}
const login = await authPost('login', { email: 'admin@example.test', password })
assert.equal(login.status, 200); assert.equal(login.json.mfa_required, true); assert.equal(login.json.token, undefined)
const challenge = login.json.challenge_token
assert.ok(typeof challenge === 'string' && challenge.length > 0)
const pendingAccess = await fetch(`${base}/p1/requirements`, { headers: { Authorization: `Bearer ${challenge}` } })
assert.equal(pendingAccess.status, 401, 'a password-only challenge is not an authenticated admin session')
await pendingAccess.arrayBuffer()
const enrollment = await authPost('admin-mfa/enroll', {}, challenge)
assert.equal(enrollment.status, 200); assert.match(enrollment.json.secret, /^[A-Z2-7]+$/)
const code = totpForCounter(decodeBase32(enrollment.json.secret), Math.floor(Date.now() / 30000))
const verified = await authPost('admin-mfa/verify', { code }, challenge)
assert.equal(verified.status, 200)
const admin = verified.json.token as string
assert.ok(typeof admin === 'string' && admin.length > 0)
async function req(project: string, suffix: string, jwt?: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${base}/${project}/${suffix}`, { method, headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, json: await res.json() as any }
}
const rules = { gl_per_occurrence_min: 1000000, gl_aggregate_min: 2000000, auto_limit_min: null, umbrella_limit_min: null, workers_comp_required: false, additional_insured_required: false }

test('GC/admin authentication and explicit ownership fail closed', async () => {
  assert.equal((await req('p1', 'requirements')).status, 401)
  assert.equal((await req('p1', 'requirements', challenge)).status, 401)
  assert.equal((await req('p1', 'requirements', staleSub)).status, 401)
  assert.equal((await req('p1', 'requirements', sub)).status, 403)
  for (const jwt of [gc2, admin]) {
    for (const suffix of ['requirements', 'evidence']) assert.equal((await req('p1', suffix, jwt)).status, 404)
    assert.equal((await req('p1', 'evaluate', jwt, 'POST', { evidence: {} })).status, 404)
    assert.equal((await req('p1', 'requirements', jwt, 'PUT', { expected_version: 0, requirements: rules })).status, 404)
  }
  assert.equal((await req('legacy', 'requirements', gc1)).status, 404)
  assert.equal((await req('missing', 'requirements', gc1)).status, 404)
  assert.equal((await req('p1', 'requirements', gc1)).json.requirements, null)
  await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', ['admin-p', 'admin', 'Admin Project', now])
  assert.equal((await req('admin-p', 'requirements', admin)).status, 200)
})

test('validated whole-dollar rules use atomic version checks', async () => {
  assert.equal((await req('p1', 'requirements', gc1, 'PUT', { expected_version: 0, requirements: { ...rules, gl_aggregate_min: -1 } })).status, 400)
  assert.equal((await req('p1', 'requirements', gc1, 'PUT', { expected_version: 0, requirements: { ...rules, gl_aggregate_min: '2000000' } })).status, 400)
  assert.equal((await req('p1', 'requirements', gc1, 'PUT', { expected_version: 0, requirements: { ...rules, extra: 1 } })).status, 400)
  const created = await req('p1', 'requirements', gc1, 'PUT', { expected_version: 0, requirements: rules })
  assert.equal(created.status, 200); assert.equal(created.json.requirements.version, 1); assert.ok(created.json.requirements.updated_at)
  assert.equal((await req('p1', 'requirements', gc1, 'PUT', { expected_version: 0, requirements: rules })).status, 409)
  const updates = await Promise.all([1, 2].map(n => req('p1', 'requirements', gc1, 'PUT', { expected_version: 1, requirements: { ...rules, auto_limit_min: n } })))
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409])
  const current = await req('p1', 'requirements', gc1)
  assert.equal(current.json.requirements.version, 2)
  const reset = await req('p1', 'requirements', gc1, 'PUT', { expected_version: 2, requirements: rules })
  assert.equal(reset.json.requirements.version, 3)
})

test('missing, low confidence and no configured criteria never pass', async () => {
  assert.equal(evaluateRequirements(null, {}).status, 'needs_review')
  assert.equal(evaluateRequirements({ ...rules, gl_per_occurrence_min: null, gl_aggregate_min: null }, {}).status, 'needs_review')
  const missing = await req('p1', 'evaluate', gc1, 'POST', { evidence: {} })
  assert.equal(missing.json.evaluation.status, 'needs_review')
  assert.ok(missing.json.evaluation.criteria.every((c: any) => c.status === 'unknown'))
  const proposed = { gl_per_occurrence: { value: 1000000, confidence: 'high' }, gl_aggregate: { value: 2000000, confidence: 'high' } }
  const high = await req('p1', 'evaluate', gc1, 'POST', { evidence: proposed })
  assert.equal(high.json.evaluation.status, 'meet')
  assert.equal(high.json.evidence_source, 'caller_supplied_unverified')
  assert.match(high.json.evaluation.disclaimer, /Human review is required/)
  const low = await req('p1', 'evaluate', gc1, 'POST', { evidence: { ...proposed, gl_aggregate: { value: 2000000, confidence: 'low' } } })
  assert.equal(low.json.evaluation.status, 'needs_review')
  const deficient = await req('p1', 'evaluate', gc1, 'POST', { evidence: { ...proposed, gl_per_occurrence: { value: 999999, confidence: 'high' } } })
  assert.equal(deficient.json.evaluation.status, 'does_not_meet')
  assert.equal((await req('p1', 'evaluate', gc1, 'POST', { evidence: { ...proposed, additional_insured_proof: true } })).status, 400)
})

test('additional insured cannot pass from a certificate checkbox, and legacy records are never trusted', async () => {
  const updated = await req('p1', 'requirements', gc1, 'PUT', { expected_version: 3, requirements: { ...rules, workers_comp_required: true, additional_insured_required: true } })
  assert.equal(updated.json.requirements.version, 4)
  const payload = await req('p1', 'evidence', gc1)
  assert.equal(payload.json.subcontractors.length, 1)
  assert.equal(payload.json.subcontractors[0].company_name, 'Test Trade')
  const cert = payload.json.subcontractors[0].certificates[0]
  assert.equal(cert.evaluation.status, 'needs_review')
  assert.equal(cert.evidence.gl_per_occurrence.value, 1000000)
  assert.equal(cert.evidence.gl_per_occurrence.confidence, 'unknown')
  assert.equal(cert.evaluation.criteria.find((c: any) => c.key === 'additional_insured_proof').status, 'unknown')
  assert.equal(parseLegacyDollar('$1M/$2M'), null)
  assert.equal(parseLegacyDollar('Statutory'), null)
  assert.equal(parseLegacyDollar('$1,000,000'), 1000000)
  const preview = await req('p1', 'evaluate', gc1, 'POST', { evidence: { gl_per_occurrence: { value: 1000000, confidence: 'high' }, gl_aggregate: { value: 2000000, confidence: 'high' }, workers_comp_present: { value: true, confidence: 'high' } } })
  assert.equal(preview.json.evaluation.status, 'needs_review')
})
