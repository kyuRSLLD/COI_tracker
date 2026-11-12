// Regression test for version-bound consent. Never uses an inherited database.
// SQLite: node --experimental-strip-types --test server/test/join-disconnect-admission.test.ts
// PostgreSQL: JOIN_RACE_TEST_POSTGRES=1 node --experimental-strip-types --test server/test/join-disconnect-admission.test.ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import pg from 'pg'

const temp = await mkdtemp(path.join(tmpdir(), 'coi-join-disconnect-'))
const usePg = process.env.JOIN_RACE_TEST_POSTGRES === '1'
const pgBin = process.env.JOIN_RACE_TEST_POSTGRES_BIN || '/usr/lib/postgresql/16/bin'
let pgStarted = false
const pools: pg.Pool[] = []
if (usePg) {
  const OriginalPool = pg.Pool
  pg.Pool = class TestPool extends OriginalPool {
    constructor(config: pg.PoolConfig) { super(config); pools.push(this) }
  }
}
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'isolated-join-race-test-secret'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
if (usePg) {
  const pg = (program: string, args: string[]) => execFileSync(path.join(pgBin, program), args, { stdio: 'pipe' })
  const port = '55441' // socket-only, inside the private temporary directory
  try {
    pg('initdb', ['-D', path.join(temp, 'data'), '-A', 'trust', '-U', userInfo().username, '--no-locale', '--encoding=UTF8'])
    pg('pg_ctl', ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'postgres.log'), '-o', `-h '' -k ${temp} -p ${port}`, '-w', 'start'])
    pgStarted = true
    pg('createdb', ['-h', temp, '-p', port, 'coi_join_race_test'])
    process.env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@localhost/coi_join_race_test?host=${encodeURIComponent(temp)}&port=${port}`
  } catch (error) {
    if (pgStarted) pg('pg_ctl', ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}
const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet, isPostgres } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')
assert.equal(isPostgres, usePg)
const app = await createApp()
const server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
const address = server.address()
assert.ok(address && typeof address !== 'string')
const port = address.port
const base = `http://127.0.0.1:${port}`
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await Promise.all(pools.map(pool => pool.end()))
  if (pgStarted) execFileSync(path.join(pgBin, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
  await rm(temp, { recursive: true, force: true })
})

const now = new Date().toISOString()
const password = 'test-password-123'
const hash = await bcrypt.hash(password, 4)
const invite = `join-${'a'.repeat(36)}`
const makeToken = (id: string) => signToken({ id, email: `${id}@example.test`, name: id, role: 'sub' })
await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['gc', 'gc@example.test', hash, 'gc', 'gc', now])
await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', ['other-gc', 'other-gc@example.test', hash, 'other-gc', 'gc', now])
await dbRun('INSERT INTO gc_settings (id, user_id, company_name, invite_code, updated_at) VALUES (?, ?, ?, ?, ?)', ['settings', 'gc', 'GC', invite, now])
for (const id of ['bearer', 'password', 'fresh']) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, hash, id, 'sub', now])
  await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`profile-${id}`, id, id, 'trade', now, now])
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['gc', `profile-${id}`, now])
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['other-gc', `profile-${id}`, now])
}

async function intentFor(token: string) {
  const response = await fetch(`${base}/api/sub/join-intent/${invite}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return (await response.json()).intent as string
}
async function connect(token: string, intent: string, consent: unknown = true) {
  return fetch(`${base}/api/sub/join/${invite}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ intent, consent }) })
}

for (const mode of ['bearer', 'password'] as const) {
  test(`disconnect supersedes a pending ${mode} request (${usePg ? 'PostgreSQL' : 'SQLite'})`, async () => {
    const token = makeToken(mode)
    const intent = await intentFor(token)
    let sawData!: () => void
    const dataSeen = new Promise<void>(resolve => { sawData = resolve })
    const observe = (req: http.IncomingMessage) => {
      if (req.url === `/api/sub/join/${invite}` && req.headers['x-test-case'] === mode) req.once('data', sawData)
    }
    server.on('request', observe)
    let resultResolve!: (result: { status: number; body: string }) => void
    let resultReject!: (error: Error) => void
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => { resultResolve = resolve; resultReject = reject })
    const req = http.request({ host: '127.0.0.1', port, path: `/api/sub/join/${invite}`, method: 'POST', headers: {
      'content-type': 'application/json', 'x-test-case': mode,
      ...(mode === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
    } }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resultResolve({ status: response.statusCode || 0, body }))
    })
    req.on('error', resultReject)
    try {
      // Legacy credential joins are retired; a delayed password-bearing request
      // must fail closed even if it carries an intent from the same account.
      const payload = JSON.stringify(mode === 'bearer' ? { intent, consent: true } : { email: 'password@example.test', password, intent, consent: true })
      req.write(payload.slice(0, 1))
      await dataSeen
      const removed = await fetch(`${base}/api/sub/connections/gc`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
      assert.equal(removed.status, 200)
      req.end(payload.slice(1))
      const join = await result
      const row = await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc', `profile-${mode}`])
      const unrelated = await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['other-gc', `profile-${mode}`])
      assert.ok(unrelated)
      assert.deepEqual({ status: join.status, connected: Boolean(row) }, { status: 409, connected: false })
      for (const secret of [password, intent, token, 'password@example.test']) assert.ok(!join.body.includes(secret))
      // The same pre-disconnect intent cannot be converted into an authenticated join.
      assert.equal((await connect(token, intent)).status, 409)
    } finally {
      server.off('request', observe)
      if (!req.writableEnded) req.destroy()
    }
  })
}

test(`fresh consent, replay, identity and session boundaries (${usePg ? 'PostgreSQL' : 'SQLite'})`, async () => {
  const token = makeToken('fresh')
  const headers = { authorization: `Bearer ${token}` }
  const before = await intentFor(token)
  assert.equal((await connect(token, before, false)).status, 400)
  assert.equal((await connect(makeToken('bearer'), before)).status, 409)
  const secondSession = signToken({ id: 'fresh', email: 'fresh@example.test', name: 'other-session', role: 'sub' })
  assert.equal((await connect(secondSession, before)).status, 409)
  const removed = await fetch(`${base}/api/sub/connections/gc`, { method: 'DELETE', headers })
  assert.equal(removed.status, 200)
  assert.equal((await connect(token, before)).status, 409)
  const fresh = await intentFor(token)
  assert.equal((await connect(token, fresh)).status, 200)
  assert.equal((await connect(token, fresh)).status, 409)
  assert.ok(await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc', 'profile-fresh']))
  assert.ok(await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['other-gc', 'profile-fresh']))
})


test(`expired and rotated invitation intents fail closed (${usePg ? 'PostgreSQL' : 'SQLite'})`, async () => {
  const token = makeToken('fresh')
  const expired = await intentFor(token)
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(expired).digest('hex')
  await dbRun('UPDATE sub_join_intents SET expires_at = ? WHERE token_hash = ?', ['2000-01-01T00:00:00.000Z', digest])
  assert.equal((await connect(token, expired)).status, 409)
  const rotated = await intentFor(token)
  const replacement = `join-${'b'.repeat(36)}`
  await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ?', [replacement, 'settings'])
  assert.equal((await connect(token, rotated)).status, 409)
  await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ?', [invite, 'settings'])
})
