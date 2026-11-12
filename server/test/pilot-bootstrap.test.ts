import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createPilot } from '../src/pilot-bootstrap.ts'
import { createPilotLimiter, pilotLimiterKeyCheck } from '../src/pilot-limiter.ts'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const env = {
  SECURE_V2_CONFIG_VERSION: '1', SECURE_V2_DB_HOST: 'localhost', SECURE_V2_DB_PORT: '1', SECURE_V2_DB_NAME: 'pilot', SECURE_V2_DB_USER: 'pilot', SECURE_V2_DB_PASSWORD: 'not-used',
  SECURE_V2_JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), SECURE_V2_JWT_PUBLIC_KEY_PEM: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), SECURE_V2_JWT_ISSUER: 'pilot', SECURE_V2_JWT_AUDIENCE: 'pilot',
  SECURE_V2_SES_REGION: 'us-east-1', SECURE_V2_SES_FROM: 'sender@example.test', SECURE_V2_SES_TIMEOUT_MS: '1000', SECURE_V2_METADATA: 'disabled', SECURE_V2_FILES: 'disabled',
  PILOT_LIMITER_HMAC_KEY: randomBytes(32).toString('base64url'), PILOT_REGISTRATION_MAILBOXES: 'one@example.test,two@example.test',
}
async function close(p: ReturnType<typeof createPilot>) { await p.pool.end(); p.ses.destroy(); p.httpsAgent.destroy() }

test('factory requires exact feature flags, explicit mailbox list and HMAC secret', async () => {
  for (const bad of [
    { PILOT_REGISTRATION_MAILBOXES: '' }, { PILOT_REGISTRATION_MAILBOXES: 'one@example.test, one@example.test' },
    { PILOT_REGISTRATION_MAILBOXES: 'ONE@example.test' }, { PILOT_LIMITER_HMAC_KEY: 'bad' },
    { PILOT_REGISTRATION_MAILBOXES: 'a..b@example.test' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { SECURE_V2_FILES: 'enabled' }, { SECURE_V2_METADATA: 'enabled' }, { SECURE_V2_DB_HOST: '' },
    { SECURE_V2_JWT_PRIVATE_KEY_PEM: '' }, { SECURE_V2_SES_REGION: 'not valid' }, { PILOT_DB_CA_PEM: 'bad' },
  ]) assert.throws(() => createPilot({ ...env, ...bad }), { message: 'Invalid pilot configuration' })
  const p = createPilot(env)
  try { assert.equal(p.pool.totalCount, 0); assert.equal((p.pool.options.ssl as any).rejectUnauthorized, true) } finally { await close(p) }
})

test('only explicit routes are exposed and database failure blocks allowed calls', async () => {
  const p = createPilot(env), server = p.app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200)
    for (const path of ['/api/v2/gc/subcontractors', '/api/v2/connections/cois', '/api/v2/connections/invitations', '/api/v2/self-reported-coi-metadata/connected-gcs', '/api/v2/self-reported-private-files', '/uploads/a', '/api/v2/auth/login?x=1', '/api/v2/%61uth/login']) assert.equal((await fetch(base + path)).status, 404, path)
    assert.equal((await fetch(base + '/api/v2/connections/general-contractors')).status, 503) // admitted by the allowlist, then denied by the unavailable limiter DB
    assert.equal((await fetch(base + '/api/v2/connections/general-contractors?x=1')).status, 404)
    const r = await fetch(base + '/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.test', password: 'password-secret' }) })
    assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('password-secret'))
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); await close(p) }
})

test('verified local PostgreSQL gates registration to explicit mailboxes without contacting SES', { skip: !process.env.PILOT_TEST_TLS_CA }, async () => {
  const caPath = process.env.PILOT_TEST_TLS_CA!
  assert.match(caPath, /^\/tmp\/pilot-pg-[A-Za-z0-9]+\/data\/server\.crt$/)
  const untrusted = createPilot({ ...env, SECURE_V2_DB_PORT: '55432', SECURE_V2_DB_NAME: 'postgres', SECURE_V2_DB_USER: 'ubuntu' })
  try { await assert.rejects(untrusted.pool.query('SELECT 1')) } finally { await close(untrusted) }
  const p = createPilot({ ...env, SECURE_V2_DB_PORT: '55432', SECURE_V2_DB_NAME: 'postgres', SECURE_V2_DB_USER: 'ubuntu', PILOT_DB_CA_PEM: readFileSync(caPath, 'utf8') })
  const server = p.app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const allowed = randomBytes(32).toString('base64url'), blocked = randomBytes(32).toString('base64url')
  const hash = (v: string) => createHash('sha256').update(v).digest()
  try {
    await p.pool.query('INSERT INTO public.pilot_rate_config_v1(singleton,key_check) VALUES(true,$1)', [pilotLimiterKeyCheck(Buffer.from(env.PILOT_LIMITER_HMAC_KEY, 'base64url'))])
    await p.pool.query('CREATE TABLE public.auth_v2_registration_challenges(token_hash bytea PRIMARY KEY,email text,delivered_at timestamptz,used_at timestamptz,expires_at timestamptz)')
    await p.pool.query("INSERT INTO public.auth_v2_registration_challenges VALUES ($1,'one@example.test',now(),NULL,now()+interval '1 minute'),($2,'other@example.test',now(),NULL,now()+interval '1 minute')", [hash(allowed), hash(blocked)])
    const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/api/v2/auth/register/request', { email: 'other@example.test' })).status, 503)
    assert.equal((await post('/api/v2/auth/register/confirm', { token: blocked })).status, 503)
    // Allowed challenge passes the outer gate and hits the real handler's input validation.
    assert.equal((await post('/api/v2/auth/register/confirm', { token: allowed })).status, 400)
    assert.equal((await p.pool.query('SELECT count(*)::int AS n FROM public.auth_v2_registration_challenges')).rows[0].n, 2)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    await p.pool.query('DROP TABLE IF EXISTS public.auth_v2_registration_challenges')
    await p.pool.query('TRUNCATE public.pilot_rate_config_v1, public.pilot_rate_buckets_v1')
    await close(p)
  }
})

test('actual shared PostgreSQL limiter is atomic, scoped and fails closed', { skip: !process.env.PILOT_TEST_PG_SOCKET }, async () => {
  // Explicit disposable local socket only, never a database URL or cloud target.
  const socket = process.env.PILOT_TEST_PG_SOCKET!
  assert.match(socket, /^\/tmp\/pilot-pg-[A-Za-z0-9]+\/socket$/)
  const pool = new pg.Pool({ host: socket, port: 55432, database: 'postgres', user: 'ubuntu', max: 8, statement_timeout: 5000, lock_timeout: 4000 })
  const key = randomBytes(32), a = createPilotLimiter(pool, key), b = createPilotLimiter(pool, key)
  try {
    assert.equal(await a.verify(), false)
    assert.equal(await a.front('127.0.0.1'), false)
    await pool.query('INSERT INTO public.pilot_rate_config_v1(singleton, key_check) VALUES(true, $1)', [pilotLimiterKeyCheck(key)])
    assert.equal(await a.verify(), true)
    const mismatched = createPilotLimiter(pool, randomBytes(32))
    assert.equal(await mismatched.verify(), false)
    assert.equal(await mismatched.front('127.0.0.1'), false)
    const calls = await Promise.all(Array.from({ length: 16 }, (_, n) => (n % 2 ? a : b).login(`127.0.0.${n + 1}`, 'person@example.test')))
    assert.equal(calls.filter(Boolean).length, 5)
    assert.equal(await a.login('127.0.0.100', 'other@example.test'), true)
    const registration = await Promise.all(Array.from({ length: 8 }, (_, n) => (n % 2 ? a : b).allowRegistration({ action: 'request', clientAddress: `127.0.1.${n + 1}`, identityHash: 'a'.repeat(64) })))
    assert.equal(registration.filter(Boolean).length, 3)
    const peer = await Promise.all(Array.from({ length: 100 }, (_, n) => (n % 2 ? a : b).front('127.0.2.1')))
    assert.ok(peer.filter(Boolean).length <= 90)
    assert.ok(peer.some(Boolean))
    let successes = 0
    for (let batch = 0; batch < 15; batch++) {
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => (n % 2 ? a : b).allow({ scope: 'auth', phase: 'preauth', remoteAddress: `127.1.${batch}.${n + 1}` })))
      successes += results.filter(Boolean).length
    }
    assert.equal(successes, 120)
    assert.equal(await a.allow({ scope: 'auth', phase: 'preauth', remoteAddress: '127.8.1.1' }), false)
    assert.equal(await a.allow({ scope: 'auth', phase: 'preauth', remoteAddress: 'not-ip' }), false)
    assert.equal(await a.allow({ scope: 'protected', phase: 'principal', remoteAddress: '127.0.0.1' }), false)
    const row = await pool.query('SELECT bucket_key FROM public.pilot_rate_buckets_v1 LIMIT 1')
    assert.equal(row.rows[0].bucket_key.length, 32)
    await pool.query('DROP TABLE public.pilot_rate_buckets_v1')
    assert.equal(await b.front('127.0.0.1'), false)
    await pool.query('DROP TABLE public.pilot_rate_config_v1')
  } finally { await pool.end() }
})
