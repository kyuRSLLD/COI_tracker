// Run with: node --experimental-strip-types --test server/test/auth-errors.test.ts
// This suite uses only a temporary SQLite database and never contacts production.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import jwt from 'jsonwebtoken'

const temp = await mkdtemp(path.join(tmpdir(), 'coi-auth-errors-test-'))
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-only-auth-secret'

const { dbExec, dbGet, dbRun, isPostgres } = await import('../src/db/db.ts')
const { requireAuth, requireAdmin, signToken } = await import('../src/middleware/auth.ts')
const { authRouter } = await import('../src/routes/auth.ts')
assert.equal(isPostgres, false)

const app = express()
app.set('trust proxy', true) // Synthetic IPs isolate the registration rate limiter in this test only.
app.use(express.json())
app.use('/auth', authRouter)
app.get('/protected', requireAuth, (req: any, res) => res.json({ user: req.user }))
app.get('/admin', requireAdmin, (_req, res) => res.json({ ok: true }))
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await rm(temp, { recursive: true, force: true })
})
let nextIp = 1
async function request(url: string, options: { token?: string, body?: unknown } = {}) {
  const response = await fetch(`${base}${url}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${nextIp++}`, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() as any }
}

const userPayload = { id: 'user-sensitive-id', email: 'test@example.test', role: 'gc', name: 'Test' }
const validToken = signToken(userPayload)

test('invalid, expired, missing-subject and forged tokens fail with 401 even if the database is unavailable', async () => {
  const invalidTokens = [
    'not-a-jwt',
    jwt.sign(userPayload, 'wrong-secret'),
    jwt.sign(userPayload, process.env.JWT_SECRET!, { expiresIn: -1 }),
    jwt.sign({ email: 'test@example.test' }, process.env.JWT_SECRET!),
    jwt.sign({ id: '' }, process.env.JWT_SECRET!),
    jwt.sign('string-payload', process.env.JWT_SECRET!),
  ]
  assert.deepEqual(await request('/protected'), { status: 401, body: { error: 'Authentication required' } })
  for (const token of invalidTokens) {
    assert.deepEqual(await request('/protected', { token }), { status: 401, body: { error: 'Invalid or expired token' } })
  }
})

test('registration validates and normalizes emails across login, user, subcontractor and token', async () => {
  await dbExec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, first_name TEXT, last_name TEXT, phone TEXT, company_name TEXT, role TEXT, created_at TEXT, subcontractor_id TEXT);
CREATE TABLE subcontractors (id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT, trade TEXT, contact_person TEXT, phone TEXT, email TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE user_phones (id TEXT PRIMARY KEY, user_id TEXT, phone TEXT, label TEXT, is_primary INTEGER, created_at TEXT);`)
  for (const email of [null, 12, {}, '   ', 'not-an-email', 'a@@example.com', 'a b@example.com', 'a..b@example.com', `${'a'.repeat(245)}@example.test`]) {
    assert.equal((await request('/auth/register', { body: { email, password: 'password123', name: 'Test' } })).status, 400)
  }
  assert.equal((await dbGet<any>('SELECT COUNT(*) AS n FROM users')).n, 0)
  const registered = await request('/auth/register', { body: { email: '  New.Sub@Example.Test\t', password: 'password123', name: 'New Sub', role: 'sub' } })
  assert.equal(registered.status, 200)
  assert.equal(registered.body.user.email, 'new.sub@example.test')
  assert.equal((jwt.verify(registered.body.token, process.env.JWT_SECRET!) as any).email, 'new.sub@example.test')
  assert.equal((await dbGet<any>('SELECT email FROM users WHERE id = ?', [registered.body.user.id])).email, 'new.sub@example.test')
  assert.equal((await dbGet<any>('SELECT email FROM subcontractors WHERE id = ?', [registered.body.user.subcontractor_id])).email, 'new.sub@example.test')
  assert.equal((await request('/auth/register', { body: { email: ' NEW.SUB@example.test ', password: 'password123', name: 'Duplicate' } })).status, 409)
  const login = await request('/auth/login', { body: { email: '  NEW.SUB@EXAMPLE.TEST ', password: 'password123' } })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.email, 'new.sub@example.test')
  assert.equal((await request('/auth/login', { body: { email: 'new.sub@example.test', password: 'wrong-password' } })).status, 401)
})

test('common mixed-case and whitespace legacy records are not migrated or duplicated', async () => {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['legacy', '\t Legacy@Example.Test\u00a0', 'not-a-real-hash', 'Legacy', 'gc', new Date().toISOString()])
  const registration = await request('/auth/register', { body: { email: 'legacy@example.test', password: 'password123', name: 'Collision' } })
  assert.equal(registration.status, 409)
  assert.equal((await dbGet<any>('SELECT email FROM users WHERE id = ?', ['legacy'])).email, '\t Legacy@Example.Test\u00a0')
  assert.equal((await request('/auth/login', { body: { email: 'legacy@example.test', password: 'password123' } })).status, 401)
})

test('valid tokens use the current database user and a missing user is unauthorized', async () => {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userPayload.id, userPayload.email, 'not-a-real-hash', 'Database Name', 'gc', new Date().toISOString()])
  const protectedResult = await request('/protected', { token: validToken })
  assert.equal(protectedResult.status, 200)
  assert.equal(protectedResult.body.user.name, 'Database Name')
  const forgedRole = signToken({ ...userPayload, role: 'admin' })
  assert.equal((await request('/admin', { token: forgedRole })).status, 403)
  assert.equal((await request('/protected', { token: signToken({ ...userPayload, id: 'missing-user' }) })).status, 401)
})

test('lookup failures yield sanitized 503 and safe server logs; login and registration errors are sanitized', async () => {
  await dbExec('DROP TABLE users')
  const logs: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { logs.push(args) }
  try {
    const result = await request('/protected', { token: validToken })
    assert.deepEqual(result, { status: 503, body: { error: 'Authentication temporarily unavailable' } })
    const admin = await request('/admin', { token: validToken })
    assert.deepEqual(admin, { status: 503, body: { error: 'Authentication temporarily unavailable' } })
    assert.deepEqual(await request('/auth/login', { body: { email: 'test@example.test', password: 'password123' } }), { status: 500, body: { error: 'Unable to sign in' } })
    assert.deepEqual(await request('/auth/register', { body: { email: 'fresh@example.test', password: 'password123', name: 'New' } }), { status: 500, body: { error: 'Unable to register' } })
    assert.deepEqual(logs, [
      ['[auth] User lookup failed; authentication temporarily unavailable'],
      ['[auth] User lookup failed; authentication temporarily unavailable'],
      ['[auth] Login failed'],
      ['[auth] Registration failed'],
    ])
    const output = JSON.stringify({ result, admin, logs })
    for (const sensitive of [validToken, userPayload.id, userPayload.email, process.env.JWT_SECRET!, temp, 'no such table', 'password123']) {
      assert.ok(!output.includes(sensitive), `output must not contain ${sensitive}`)
    }
  } finally {
    console.error = original
  }
})
