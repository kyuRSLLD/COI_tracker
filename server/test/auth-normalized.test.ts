// SQLite: node --experimental-strip-types --test server/test/auth-normalized.test.ts
// PostgreSQL: AUTH_TEST_POSTGRES=1 node --experimental-strip-types --test server/test/auth-normalized.test.ts
// The PG mode starts a fresh local, socket-only temporary cluster; it never uses DATABASE_URL.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import express from 'express'
import bcrypt from 'bcryptjs'

const temp = await mkdtemp(path.join(tmpdir(), 'coi-auth-normalized-'))
const usePg = process.env.AUTH_TEST_POSTGRES === '1'
const pgBin = process.env.AUTH_TEST_POSTGRES_BIN || '/usr/lib/postgresql/16/bin'
let pgStarted = false
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = '' // Never honor an inherited production connection string.
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'isolated-auth-test-secret'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_REGION = ''
if (usePg) {
  // Unix socket and data live in a uniquely created private directory. No TCP listening.
  const port = '55439'
  const pg = (program: string, args: string[]) => execFileSync(path.join(pgBin, program), args, { stdio: 'pipe' })
  try {
    pg('initdb', ['-D', path.join(temp, 'data'), '-A', 'trust', '-U', userInfo().username, '--no-locale', '--encoding=UTF8'])
    pg('pg_ctl', ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p ${port}`, '-w', 'start'])
    pgStarted = true
    pg('createdb', ['-h', temp, '-p', port, 'coi_auth_test'])
    process.env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@localhost/coi_auth_test?host=${encodeURIComponent(temp)}&port=${port}`
  } catch (error) {
    if (pgStarted) pg('pg_ctl', ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
const { dbExec, dbRun, dbAll, isPostgres } = await import('../src/db/db.ts')
const { authRouter } = await import('../src/routes/auth.ts')
const { subPortalRouter } = await import('../src/routes/subPortal.ts')
const { signToken } = await import('../src/middleware/auth.ts')
assert.equal(isPostgres, usePg)
const app = express()
app.set('trust proxy', true) // Each synthetic test address gets an independent rate-limit bucket.
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/sub', subPortalRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (pgStarted) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
  await rm(temp, { recursive: true, force: true })
})
let ip = 0
function nextIp() { ip += 1; return `10.0.${Math.floor(ip / 250)}.${(ip % 250) + 1}` }
async function request(url: string, options: { body?: unknown; token?: string; ip?: string } = {}) {
  const response = await fetch(`${base}${url}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': options.ip || nextIp(), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  return { status: response.status, body: await response.json() as any }
}
const invite = `join-${'a'.repeat(36)}`
const join = `/api/sub/join/${invite}`
const now = '2026-01-01T00:00:00.000Z'
const password = 'correct-password'
const hash = await bcrypt.hash(password, 4)
async function addUser(id: string, email: string, role = 'sub', userHash = hash) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, email, userHash, id, role, now])
}
async function snapshot() {
  return {
    users: await dbAll('SELECT id, email, password_hash, subcontractor_id FROM users ORDER BY id'),
    subs: await dbAll('SELECT id, user_id, email FROM subcontractors ORDER BY id'),
    links: await dbAll('SELECT gc_user_id, subcontractor_id FROM gc_sub_connections ORDER BY gc_user_id, subcontractor_id'),
  }
}

test('normalized authentication and invitation integration', async (t) => {
  await dbExec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, first_name TEXT, last_name TEXT, phone TEXT, company_name TEXT, role TEXT, created_at TEXT, subcontractor_id TEXT);
CREATE TABLE subcontractors (id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT, trade TEXT, contact_person TEXT, phone TEXT, email TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE user_phones (id TEXT PRIMARY KEY, user_id TEXT, phone TEXT, label TEXT, is_primary INTEGER, created_at TEXT);
CREATE TABLE gc_settings (id TEXT PRIMARY KEY, user_id TEXT, invite_code TEXT, company_name TEXT);
CREATE TABLE gc_sub_connections (gc_user_id TEXT, subcontractor_id TEXT, created_at TEXT, PRIMARY KEY (gc_user_id, subcontractor_id));
CREATE TABLE sub_join_versions (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE sub_join_intents (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, gc_user_id TEXT NOT NULL, gc_settings_id TEXT NOT NULL, invite_code TEXT NOT NULL, version INTEGER NOT NULL, expires_at TEXT NOT NULL);`)
  await addUser('gc', 'gc@example.test', 'gc')
  await dbRun('INSERT INTO gc_settings (id, user_id, invite_code, company_name) VALUES (?, ?, ?, ?)', ['settings', 'gc', invite, 'GC'])

  await t.test('single legacy identity logs in without modifying stored email, including Unicode case/trim', async () => {
    await addUser('legacy', '\t Legacy@Example.Test\u00a0')
    await addUser('kelvin', '\ufeffKELVIN@example.test\u3000')
    const before = await snapshot()
    for (const [email, id] of [[' LEGACY@EXAMPLE.TEST ', 'legacy'], ['kelvin@example.test', 'kelvin']]) {
      const result = await request('/api/auth/login', { body: { email, password } })
      assert.equal(result.status, 200)
      assert.equal(result.body.user.id, id)
      assert.equal((await request('/api/auth/login', { body: { email, password: 'wrong-password' } })).status, 401)
      assert.equal((await request('/api/auth/register', { body: { email, password, name: 'Duplicate' } })).status, 409)
    }
    assert.deepEqual(await snapshot(), before)
    assert.equal((await request('/api/auth/login', { body: { email: {}, password } })).status, 400)
  })

  await t.test('ambiguous exact and whitespace variants always fail closed for both passwords', async () => {
    await addUser('collision-a', 'collision@example.test')
    await addUser('collision-b', '  COLLISION@example.test\t', 'sub', await bcrypt.hash('other-password', 4))
    const before = await snapshot()
    for (const p of [password, 'other-password']) {
      assert.deepEqual(await request('/api/auth/login', { body: { email: 'collision@example.test', password: p } }), { status: 401, body: { error: 'Invalid email or password' } })
      assert.equal((await request(join, { body: { email: 'collision@example.test', password: p, name: 'Cannot create' } })).status, 409)
    }
    assert.equal((await request('/api/auth/register', { body: { email: ' COLLISION@example.test ', password, name: 'Duplicate' } })).status, 409)
    assert.deepEqual(await snapshot(), before)
    const rateIp = nextIp()
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/login', { ip: rateIp, body: { email: 'collision@example.test', password } })).status, 401)
    assert.equal((await request('/api/auth/login', { ip: rateIp, body: { email: 'collision@example.test', password } })).status, 429)
  })

  await t.test('Unicode normalized collisions are ambiguous across both databases', async () => {
    await addUser('kelvin-duplicate', 'kelvin@example.test')
    const before = await snapshot()
    assert.equal((await request('/api/auth/login', { body: { email: 'KELVIN@example.test', password } })).status, 401)
    assert.equal((await request(join, { body: { email: 'kelvin@example.test', password, name: 'Duplicate' } })).status, 409)
    assert.equal((await request('/api/auth/register', { body: { email: 'kelvin@example.test', password, name: 'Duplicate' } })).status, 409)
    assert.deepEqual(await snapshot(), before)
  })

  await t.test('normalized login precedes fresh invite consent without creating duplicates', async () => {
    await addUser('invite-legacy', ' \t InViTe@Example.Test\u00a0')
    const before = await snapshot()
    assert.equal((await request('/api/auth/login', { body: { email: 'invite@example.test', password: 'wrong-password' } })).status, 401)
    const gcLogin = await request('/api/auth/login', { body: { email: ' GC@EXAMPLE.TEST ', password } })
    assert.equal((await request(`/api/sub/join-intent/${invite}`, { token: gcLogin.body.token, body: {} })).status, 403)
    assert.deepEqual(await snapshot(), before)
    const login = await request('/api/auth/login', { body: { email: ' INVITE@example.test ', password } })
    assert.equal(login.status, 200)
    assert.equal(login.body.user.id, 'invite-legacy')
    const intent = await request(`/api/sub/join-intent/${invite}`, { token: login.body.token, body: {} })
    assert.equal(intent.status, 200)
    const result = await request(join, { token: login.body.token, body: { intent: intent.body.intent, consent: true } })
    assert.equal(result.status, 200)
    assert.equal(result.body.mode, 'authenticated')
    const state = await snapshot()
    assert.equal(state.users.filter((u: any) => u.id === 'invite-legacy').length, 1)
    assert.equal(state.subs.filter((s: any) => s.user_id === 'invite-legacy').length, 1)
    assert.equal(state.links.length, before.links.length + 1)
  })

  await t.test('normalized login rate limit remains enforced', async () => {
    const rateIp = nextIp()
    for (let i = 0; i < 10; i++) assert.equal((await request('/api/auth/login', { ip: rateIp, body: { email: ' INVITE@example.test ', password: 'wrong' } })).status, 401)
    assert.equal((await request('/api/auth/login', { ip: rateIp, body: { email: 'invite@example.test', password } })).status, 429)
  })

  await t.test('invite signup is separate, retains data, and needs explicit consent', async () => {
    const before = await snapshot()
    for (const email of [null, 12, {}, '   ', 'not-an-email', 'a@@example.com', 'a..b@example.com', `${'a'.repeat(245)}@example.test`]) {
      assert.equal((await request('/api/auth/register', { body: { email, password, name: 'New', role: 'sub' } })).status, 400)
    }
    assert.deepEqual(await snapshot(), before)
    const result = await request('/api/auth/register', { body: { email: '  NEW.JOIN@Example.Test\t', password, name: 'New', trade: 'Painting', role: 'sub' } })
    assert.equal(result.status, 200)
    assert.equal(result.body.user.email, 'new.join@example.test')
    assert.equal((await dbAll('SELECT trade FROM subcontractors WHERE user_id = ?', [result.body.user.id]))[0].trade, 'Painting')
    assert.equal((await request('/api/auth/login', { body: { email: 'NEW.JOIN@example.test', password } })).body.user.id, result.body.user.id)
    const afterRegistration = await snapshot()
    assert.equal(afterRegistration.links.length, before.links.length)
    const intent = await request(`/api/sub/join-intent/${invite}`, { token: result.body.token, body: {} })
    assert.equal((await request(join, { token: result.body.token, body: { intent: intent.body.intent, consent: true } })).status, 200)
    assert.equal((await request('/api/auth/register', { body: { email: 'new.join@example.test', password, name: 'Duplicate' } })).status, 409)
  })

  await t.test('finds collisions across page boundaries rather than accepting an early match', async () => {
    await addUser('aaa-page-first', 'pagination@example.test')
    for (let i = 0; i < 505; i++) await addUser(`middle-${String(i).padStart(4, '0')}`, `filler${i}@example.test`)
    await addUser('zzz-page-last', ' PAGINATION@example.test ')
    const before = await snapshot()
    assert.equal((await request('/api/auth/login', { body: { email: 'pagination@example.test', password } })).status, 401)
    assert.equal((await request(join, { body: { email: 'pagination@example.test', password, name: 'Duplicate' } })).status, 409)
    assert.deepEqual(await snapshot(), before)
  })

  await t.test('/me query errors return only a generic message and log', async () => {
    const token = signToken({ id: 'legacy', email: 'not-used@example.test', role: 'sub', name: 'Legacy' })
    await dbExec('DROP TABLE user_phones')
    const logs: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logs.push(args) }
    try {
      const result = await request('/api/auth/me', { token })
      assert.deepEqual(result, { status: 500, body: { error: 'Unable to load account' } })
      assert.deepEqual(logs, [['[auth] Profile lookup failed']])
      for (const sensitive of [token, 'legacy', 'user_phones', 'no such table', temp]) assert.ok(!JSON.stringify({ result, logs }).includes(sensitive))
    } finally { console.error = original }
  })

  await t.test('invite database errors do not expose details', async () => {
    await dbExec('DROP TABLE gc_settings')
    const logs: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logs.push(args) }
    try {
      const token = signToken({ id: 'legacy', email: 'ignored', role: 'sub', name: 'ignored' })
      const result = await request(`/api/sub/join-intent/${invite}`, { token, body: {} })
      assert.deepEqual(result, { status: 500, body: { error: 'Unable to prepare connection' } })
      assert.deepEqual(logs, [['[auth] Invitation intent failed']])
      for (const sensitive of ['gc_settings', 'no such table', password, temp]) assert.ok(!JSON.stringify({ result, logs }).includes(sensitive))
    } finally { console.error = original }
  })
})
