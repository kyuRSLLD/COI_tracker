// Isolated SQLite only; never reads an inherited production database or object store.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const temp = await mkdtemp(path.join(tmpdir(), 'coi-rollout-'))
process.env.SQLITE_PATH = path.join(temp, 'isolated.sqlite')
process.env.DATABASE_URL = ''
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'isolated-rollout-test-secret'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
delete process.env.DISCONNECT_PAUSED
const { createApp } = await import('../src/app.ts')
const { dbGet, dbRun } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')
const { LOCAL_UPLOADS } = await import('../src/services/storage.ts')
const server = (await createApp()).listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const now = new Date().toISOString()
const invite = `join-${'f'.repeat(36)}`
const password = 'isolated-password'
const hash = await bcrypt.hash(password, 4)
for (const [id, role] of [['sub','sub'], ['gc','gc'], ['gc2','gc']]) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, hash, id, role, now])
}
await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['profile', 'sub', 'Sub', 'Test', now, now])
await dbRun('INSERT INTO gc_settings (id, user_id, company_name, invite_code, updated_at) VALUES (?, ?, ?, ?, ?)', ['settings', 'gc', 'GC', invite, now])
await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['gc', 'profile', now])
const sub = signToken({ id: 'sub', email: 'sub@example.test', name: 'sub', role: 'sub' })
const gc = signToken({ id: 'gc2', email: 'gc2@example.test', name: 'gc2', role: 'gc' })
const legacy = jwt.sign({ id: 'sub', email: 'sub@example.test', name: 'sub', role: 'sub' }, process.env.JWT_SECRET!, { expiresIn: '30d' })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
let uploadedKey: string | undefined
async function call(url: string, token?: string, method = 'GET', body?: object | FormData) {
  const form = body instanceof FormData
  const response = await fetch(base + url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !form ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: form ? body : JSON.stringify(body) } : {}) })
  return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') }
}
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (uploadedKey && /^[a-f0-9]{64}$/.test(uploadedKey)) await rm(path.join(LOCAL_UPLOADS, uploadedKey), { force: true })
  await rm(temp, { recursive: true, force: true })
})

test('paused removal fails closed without affecting login, upload, join or QR', async () => {
  process.env.DISCONNECT_PAUSED = 'true'
  const login = await call('/api/auth/login', undefined, 'POST', { email: 'sub@example.test', password })
  assert.equal(login.status, 200)
  assert.ok(jwt.decode(login.body.token) && (jwt.decode(login.body.token) as any).jti)
  const dashboard = await call('/api/sub/my', sub)
  assert.equal(dashboard.status, 200)
  assert.equal(dashboard.body.disconnect_available, false)
  assert.equal(dashboard.cache, 'no-store')
  assert.ok(!JSON.stringify(dashboard.body).includes('DISCONNECT_PAUSED'))
  const issue = await call('/api/connection-qr', legacy, 'POST', { consent: true })
  assert.equal(issue.status, 200)
  const removed = await call('/api/sub/connections/gc', sub, 'DELETE')
  assert.equal(removed.status, 503)
  assert.equal(removed.body.code, 'CONNECTION_REMOVAL_UNAVAILABLE')
  assert.match(removed.body.error, /temporarily unavailable/i)
  assert.equal(removed.cache, 'no-store')
  assert.ok(await dbGet('SELECT * FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc','profile']))
  assert.equal(await dbGet('SELECT * FROM sub_join_versions WHERE user_id = ?', ['sub']), undefined)
  assert.equal((await call('/api/connection-qr/redeem', gc, 'POST', { token: issue.body.token })).status, 200)
  const intent = await call(`/api/sub/join-intent/${invite}`, sub, 'POST')
  assert.equal(intent.status, 200)
  assert.equal((await call(`/api/sub/join/${invite}`, sub, 'POST', { intent: intent.body.intent, consent: true })).status, 200)
  const form = new FormData()
  form.append('certificate', new Blob(['%PDF-1.4\nsynthetic isolated test'], { type: 'application/pdf' }), 'test.pdf')
  const uploaded = await call('/api/sub/quick-upload', legacy, 'POST', form)
  assert.equal(uploaded.status, 200)
  uploadedKey = (await dbGet('SELECT certificate_key FROM cois WHERE id = ?', [uploaded.body.id]))?.certificate_key
  assert.match(uploadedKey!, /^[a-f0-9]{64}$/)
  // Auth still applies, including when paused.
  assert.equal((await call('/api/sub/connections/gc', undefined, 'DELETE')).status, 401)
  assert.equal((await call('/api/sub/connections/gc', gc, 'DELETE')).status, 403)
})

test('legacy JWT can use portal but cannot create or consume even a matching old intent', async () => {
  assert.equal((await call('/api/auth/me', legacy)).status, 200)
  assert.equal((await call('/api/sub/my', legacy)).status, 200)
  const intent = 'a'.repeat(43)
  await dbRun('INSERT INTO sub_join_intents (token_hash, user_id, session_hash, gc_user_id, gc_settings_id, invite_code, version, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [digest(intent), 'sub', digest(`Bearer ${legacy}`), 'gc', 'settings', invite, 0, '2099-01-01T00:00:00.000Z'])
  for (const result of [await call(`/api/sub/join-intent/${invite}`, legacy, 'POST'), await call(`/api/sub/join/${invite}`, legacy, 'POST', { intent, consent: true })]) {
    assert.equal(result.status, 401)
    assert.equal(result.body.code, 'JOIN_SESSION_REAUTH_REQUIRED')
    assert.match(result.body.error, /sign out and sign in again/i)
    assert.equal(result.cache, 'no-store')
    assert.ok(!JSON.stringify(result.body).includes(legacy))
  }
  assert.ok(await dbGet('SELECT * FROM sub_join_intents WHERE token_hash = ?', [digest(intent)]))
  const blank = jwt.sign({ id: 'sub', jti: '   ' }, process.env.JWT_SECRET!)
  assert.equal((await call(`/api/sub/join-intent/${invite}`, blank, 'POST')).status, 401)
  const fresh = await call(`/api/sub/join-intent/${invite}`, sub, 'POST')
  assert.equal(fresh.status, 200)
  const row = await dbGet('SELECT * FROM sub_join_intents WHERE token_hash = ?', [digest(fresh.body.intent)])
  assert.equal(row.session_hash, digest(`Bearer ${sub}`))
  assert.equal((await call(`/api/sub/join/${invite}`, sub, 'POST', { intent: fresh.body.intent, consent: true })).status, 200)
})

test('false and unset restore normal removal', async () => {
  process.env.DISCONNECT_PAUSED = 'false'
  assert.equal((await call('/api/sub/my', sub)).body.disconnect_available, true)
  assert.equal((await call('/api/sub/connections/gc2', sub, 'DELETE')).status, 200)
  delete process.env.DISCONNECT_PAUSED
  assert.equal((await call('/api/sub/my', sub)).body.disconnect_available, true)
  assert.equal((await call('/api/sub/connections/gc', sub, 'DELETE')).status, 200)
})
