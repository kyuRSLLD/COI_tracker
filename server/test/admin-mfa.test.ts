import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const temp = await mkdtemp(path.join(tmpdir(), 'safecoi-mfa-'))
process.env.SQLITE_PATH = path.join(temp, 'isolated.sqlite')
delete process.env.DATABASE_URL
process.env.JWT_SECRET = 'test-jwt-signing-secret-never-use-in-production-13579'
process.env.MFA_ENCRYPTION_KEY = '1234567890abcdef0123456789abcdefabcdef0123456789fedcba9876543210'
process.env.NODE_ENV = 'test'
const { initDatabase, dbGet, dbRun } = await import('../src/db/db.ts')
const { initAdminMfa, totpForCounter } = await import('../src/services/adminMfa.ts')
const { authRouter } = await import('../src/routes/auth.ts')
const { requireAdmin, requireAuth } = await import('../src/middleware/auth.ts')
await initDatabase()
await initAdminMfa(); await initAdminMfa()
const password = 'a-test-only-password'
const hash = await bcrypt.hash(password, 4)
for (const [id, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['admin3', 'admin'], ['gc1', 'gc'], ['sub1', 'sub']]) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, hash, id, role, new Date().toISOString()])
}
const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.get('/api/protected', requireAuth, (_req, res) => res.json({ ok: true }))
app.get('/api/admin', requireAdmin, (_req, res) => res.json({ ok: true }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('server not listening')
const base = `http://127.0.0.1:${address.port}/api`
async function call(url: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, headers: response.headers, json: await response.json() as any }
}
const login = (id: string, pass = password) => call('/auth/login', 'POST', { email: `${id}@example.test`, password: pass })
const verify = (token: string, code: string) => call('/auth/admin-mfa/verify', 'POST', { code }, token)
function decode32(value: string): Buffer {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, n = 0; const out: number[] = []
  for (const ch of value) { const v = abc.indexOf(ch); assert.notEqual(v, -1); n = (n << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((n >>> bits) & 255) } }
  return Buffer.from(out)
}
function independentTotp(secret: string, time: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30)))
  const h = createHmac('sha1', decode32(secret)).update(counter).digest(); const off = h[19] & 15
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1000000).padStart(6, '0')
}
const realNow = Date.now
let fakeNow = Math.floor(realNow() / 30000) * 30000 + 10000
Date.now = () => fakeNow
let enrolledSecret = ''
let adminToken = ''

test('RFC 6238 SHA1 vectors produce expected six-digit truncation', () => {
  const secret = Buffer.from('12345678901234567890')
  assert.equal(totpForCounter(secret, Math.floor(59 / 30)), '287082')
  assert.equal(totpForCounter(secret, Math.floor(1111111109 / 30)), '081804')
  assert.equal(totpForCounter(secret, Math.floor(2000000000 / 30)), '279037')
})

test('password-gated enrollment is encrypted, and only a verified factor grants admin access', async () => {
  assert.equal((await login('admin1', 'wrong')).status, 401)
  assert.equal((await call('/auth/admin-mfa/enroll', 'POST')).status, 401)
  const start = await login('admin1')
  assert.equal(start.status, 200); assert.equal(start.json.mfa_required, true); assert.equal(start.json.enrolled, false)
  assert.equal(start.json.token, undefined); assert.equal(start.headers.get('cache-control'), 'no-store')
  const challenge = start.json.challenge_token
  assert.equal((await call('/protected', 'GET', undefined, challenge)).status, 401)
  assert.equal((await call('/admin', 'GET', undefined, challenge)).status, 401)
  assert.equal((await call('/auth/admin-mfa/status', 'GET', undefined, challenge)).json.enrolled, false)
  const enroll = await call('/auth/admin-mfa/enroll', 'POST', {}, challenge)
  assert.equal(enroll.status, 200); assert.match(enroll.json.secret, /^[A-Z2-7]+$/)
  assert.match(enroll.json.otpauth_uri, /^otpauth:\/\/totp\//)
  assert.equal((await call('/auth/admin-mfa/enroll', 'POST', {}, challenge)).json.secret, enroll.json.secret)
  enrolledSecret = enroll.json.secret
  const state = await dbGet<any>('SELECT enrollment_ciphertext FROM admin_mfa_challenges WHERE user_id = ?', ['admin1'])
  assert.ok(state.enrollment_ciphertext); assert.ok(!state.enrollment_ciphertext.includes(enrolledSecret))
  const correct = independentTotp(enrolledSecret, Math.floor(fakeNow / 1000))
  const wrong = String((Number(correct) + 1) % 1000000).padStart(6, '0')
  assert.equal((await verify(challenge, wrong)).status, 401)
  const completed = await verify(challenge, correct)
  assert.equal(completed.status, 200); adminToken = completed.json.token; assert.ok(adminToken)
  assert.equal((await call('/admin', 'GET', undefined, adminToken)).status, 200)
  assert.equal((await call('/auth/me', 'GET', undefined, adminToken)).json.user.id, 'admin1')
  assert.equal((await verify(challenge, correct)).status, 401)
  assert.equal((await call('/auth/admin-mfa/enroll', 'POST', {}, adminToken)).status, 401)
  const credential = await dbGet<any>('SELECT * FROM admin_mfa_credentials WHERE user_id = ?', ['admin1'])
  assert.ok(!JSON.stringify(credential).includes(enrolledSecret))
})

test('replayed code cannot authenticate a new challenge; concurrent verification has one winner', async () => {
  const again = await login('admin1'); assert.equal(again.json.enrolled, true)
  assert.equal((await call('/auth/admin-mfa/enroll', 'POST', {}, again.json.challenge_token)).status, 409)
  assert.equal((await verify(again.json.challenge_token, independentTotp(enrolledSecret, Math.floor(fakeNow / 1000)))).status, 401)
  fakeNow += 30000
  const [a, b] = await Promise.all([login('admin1'), login('admin1')])
  const code = independentTotp(enrolledSecret, Math.floor(fakeNow / 1000))
  const results = await Promise.all([verify(a.json.challenge_token, code), verify(b.json.challenge_token, code)])
  assert.deepEqual(results.map(x => x.status).sort(), [200, 401])
})

test('account-wide rate limit applies across fresh password challenges and expires', async () => {
  const start = await login('admin2')
  const enroll = await call('/auth/admin-mfa/enroll', 'POST', {}, start.json.challenge_token)
  const correct = independentTotp(enroll.json.secret, Math.floor(fakeNow / 1000))
  const invalid = String((Number(correct) + 1) % 1000000).padStart(6, '0')
  for (let i = 0; i < 5; i++) {
    const pending = i ? await login('admin2') : start
    assert.equal((await verify(pending.json.challenge_token, invalid)).status, 401)
  }
  const blocked = await login('admin2')
  assert.equal((await verify(blocked.json.challenge_token, correct)).status, 429)
  fakeNow += 301000
  const fresh = await login('admin2')
  const freshEnrollment = await call('/auth/admin-mfa/enroll', 'POST', {}, fresh.json.challenge_token)
  const completed = await verify(fresh.json.challenge_token, independentTotp(freshEnrollment.json.secret, Math.floor(fakeNow / 1000)))
  assert.equal(completed.status, 200)
  const pendingBeforeChange = await login('admin2')
  await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash('new-test-password', 4), 'admin2'])
  assert.equal((await call('/admin', 'GET', undefined, completed.json.token)).status, 401)
  assert.equal((await call('/auth/admin-mfa/status', 'GET', undefined, pendingBeforeChange.json.challenge_token)).status, 401)
})

test('simultaneous first enrollments can never replace an established factor', async () => {
  const [a, b] = await Promise.all([login('admin3'), login('admin3')])
  const [ea, eb] = await Promise.all([
    call('/auth/admin-mfa/enroll', 'POST', {}, a.json.challenge_token),
    call('/auth/admin-mfa/enroll', 'POST', {}, b.json.challenge_token),
  ])
  assert.equal(ea.status, 200); assert.equal(eb.status, 200)
  const now = Math.floor(fakeNow / 1000)
  const results = await Promise.all([
    verify(a.json.challenge_token, independentTotp(ea.json.secret, now)),
    verify(b.json.challenge_token, independentTotp(eb.json.secret, now)),
  ])
  assert.deepEqual(results.map(x => x.status).sort(), [200, 401])
  const winner = results.find(x => x.status === 200)!
  assert.equal((await call('/admin', 'GET', undefined, winner.json.token)).status, 200)
  assert.equal((await login('admin3')).json.enrolled, true)
  await dbRun('DELETE FROM users WHERE id = ?', ['admin3'])
  assert.equal(await dbGet('SELECT * FROM admin_mfa_credentials WHERE user_id = ?', ['admin3']), undefined)
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['admin3', 'admin3@example.test', hash, 'admin3', 'admin', new Date().toISOString()])
  assert.equal((await login('admin3')).json.enrolled, false)
  assert.equal((await call('/admin', 'GET', undefined, winner.json.token)).status, 401)
})

test('legacy admin tokens and stale roles fail, while GC/sub sign-in and registration still work', async () => {
  const legacy = jwt.sign({ id: 'admin1', email: 'admin1@example.test', name: 'admin1', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '30d' })
  assert.equal((await call('/protected', 'GET', undefined, legacy)).status, 401)
  assert.equal((await call('/admin', 'GET', undefined, legacy)).status, 401)
  for (const id of ['gc1', 'sub1']) {
    const result = await login(id); assert.equal(result.status, 200); assert.ok(result.json.token)
    assert.equal((await call('/protected', 'GET', undefined, result.json.token)).status, 200)
    assert.equal((await call('/admin', 'GET', undefined, result.json.token)).status, 403)
    assert.equal((await call('/auth/admin-mfa/status', 'GET', undefined, result.json.token)).status, 401)
    if (id === 'gc1') {
      await dbRun("UPDATE users SET role = 'admin' WHERE id = ?", [id])
      assert.equal((await call('/protected', 'GET', undefined, result.json.token)).status, 401)
      await dbRun("UPDATE users SET role = 'gc' WHERE id = ?", [id])
    }
  }
  const signup = await call('/auth/register', 'POST', { email: 'new@example.test', password, first_name: 'Test', last_name: 'User', phone: '555-222-1234', role: 'gc' })
  assert.equal(signup.status, 200); assert.ok(signup.json.token)
  assert.equal((await call('/auth/phones', 'GET', undefined, signup.json.token)).json.phones[0].phone, '(555) 222-1234')
  await dbRun("UPDATE users SET role = 'gc' WHERE id = ?", ['admin1'])
  assert.equal((await call('/admin', 'GET', undefined, adminToken)).status, 401)
})

test('MFA key is mandatory and old challenge expires', async () => {
  await dbRun("UPDATE users SET role = 'admin' WHERE id = ?", ['admin1'])
  const start = await login('admin1')
  fakeNow += 301000
  assert.equal((await call('/auth/admin-mfa/status', 'GET', undefined, start.json.challenge_token)).status, 401)
  const key = process.env.MFA_ENCRYPTION_KEY
  delete process.env.MFA_ENCRYPTION_KEY
  process.env.NODE_ENV = 'production'
  assert.equal((await login('admin1')).status, 503)
  assert.equal((await call('/admin', 'GET', undefined, adminToken)).status, 503)
  process.env.MFA_ENCRYPTION_KEY = key
  process.env.NODE_ENV = 'test'
})

after(async () => { Date.now = realNow; await new Promise<void>(resolve => server.close(() => resolve())); await rm(temp, { recursive: true, force: true }) })
