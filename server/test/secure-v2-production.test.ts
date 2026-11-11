import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { createSecureV2ProductionApp } from '../src/secure-v2-production.ts'
import type { SecureV2ProductionDependencies } from '../src/secure-v2-production.ts'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 })
const small = generateKeyPairSync('rsa', { modulusLength: 1024 })
const pem = (p: typeof pair) => ({ privateKey: p.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: p.publicKey.export({ type: 'spki', format: 'pem' }).toString() })
const keys = pem(pair)
const env = { SECURE_V2_CONFIG_VERSION: '1', SECURE_V2_DB_HOST: 'db.example.test', SECURE_V2_DB_PORT: '5432', SECURE_V2_DB_NAME: 'isolated_v2', SECURE_V2_DB_USER: 'v2_user', SECURE_V2_DB_PASSWORD: 'ephemeral-test-password',
  SECURE_V2_JWT_PRIVATE_KEY_PEM: keys.privateKey, SECURE_V2_JWT_PUBLIC_KEY_PEM: keys.publicKey, SECURE_V2_JWT_ISSUER: 'test-issuer', SECURE_V2_JWT_AUDIENCE: 'test-audience',
  SECURE_V2_SES_REGION: 'us-east-1', SECURE_V2_SES_FROM: 'verify@example.test', SECURE_V2_SES_TIMEOUT_MS: '1000', SECURE_V2_METADATA: 'disabled', SECURE_V2_FILES: 'disabled' }
function setup() {
  const pool = new pg.Pool({ host: env.SECURE_V2_DB_HOST, port: 5432, database: env.SECURE_V2_DB_NAME, user: env.SECURE_V2_DB_USER, password: env.SECURE_V2_DB_PASSWORD,
    ssl: { rejectUnauthorized: true }, options: '-c search_path=public', max: 3, connectionTimeoutMillis: 1000, statement_timeout: 1000, lock_timeout: 500, idle_in_transaction_session_timeout: 2000 })
  let queries = 0, sends = 0
  // All SQL is an in-memory stub. No real connection, database, AWS or scanner is used.
  ;(pool as any).query = async (sql: string) => {
    queries++
    if (sql.includes('SELECT u.role FROM auth_v2_sessions')) return { rowCount: 1, rows: [{ role: 'gc' }] }
    return { rowCount: 1, rows: [] }
  }
  const deps: SecureV2ProductionDependencies = { env: { ...env }, pool,
    limiter: { allow: async () => true, allowRegistration: async () => true },
    ses: { send: async () => { sends++; return { MessageId: 'mock' } } },
    authorizeRegistrationEmail: async () => false, authorizeInviteRecipient: async () => false }
  return { deps, pool, counts: () => ({ queries, sends }) }
}
async function listen(app: ReturnType<typeof createSecureV2ProductionApp>) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('invalid address')
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())) }
}
const token = () => jwt.sign({}, keys.privateKey, { algorithm: 'RS256', issuer: env.SECURE_V2_JWT_ISSUER, audience: env.SECURE_V2_JWT_AUDIENCE, subject: 'mock-gc', jwtid: randomBytes(32).toString('base64url'), expiresIn: '15m' })

test('explicit configuration and dependencies fail closed, without leaking secrets or touching dependencies', async () => {
  const { deps, pool, counts } = setup()
  try {
    assert.doesNotThrow(() => createSecureV2ProductionApp(deps))
    const cases: Partial<SecureV2ProductionDependencies>[] = [
      { env: {} }, { env: { ...env, SECURE_V2_JWT_PRIVATE_KEY_PEM: undefined, JWT_SECRET: 'legacy-secret' } },
      { env: { ...env, SECURE_V2_DB_PASSWORD: undefined, DATABASE_URL: 'postgres://legacy' } },
      { env: { ...env, SECURE_V2_JWT_PUBLIC_KEY_PEM: pem(wrong).publicKey } },
      { env: { ...env, SECURE_V2_JWT_PRIVATE_KEY_PEM: pem(small).privateKey, SECURE_V2_JWT_PUBLIC_KEY_PEM: pem(small).publicKey } },
      { env: { ...env, SECURE_V2_JWT_AUDIENCE: ' bad ' } }, { env: { ...env, SECURE_V2_SES_FROM: 'bad\r\naddress' } },
      { env: { ...env, SECURE_V2_METADATA: 'yes' } }, { env: { ...env, SECURE_V2_FILES: 'enabled' } },
      { env: { ...env, SECURE_V2_METADATA: 'enabled', SECURE_V2_FILES: 'enabled' } },
      { limiter: undefined }, { ses: undefined }, { authorizeRegistrationEmail: undefined }, { authorizeInviteRecipient: undefined },
      { pool: new pg.Pool() },
    ]
    for (const c of cases) assert.throws(() => createSecureV2ProductionApp({ ...deps, ...c } as SecureV2ProductionDependencies), e => {
      assert.equal((e as Error).message, 'Invalid secure-v2 configuration or dependencies')
      assert.ok(!(e as Error).stack?.includes(env.SECURE_V2_DB_PASSWORD)); return true
    })
    const fileEnv = { ...env, SECURE_V2_METADATA: 'enabled', SECURE_V2_FILES: 'enabled', SECURE_V2_FILE_S3_BUCKET: 'private-test-bucket', SECURE_V2_FILE_S3_EXPECTED_OWNER: '123456789012', SECURE_V2_FILE_MAX_BYTES: '1024', SECURE_V2_FILE_S3_DEADLINE_MS: '1000', SECURE_V2_FILE_UPLOAD_DEADLINE_MS: '2000' }
    const files = { inspector: { inspect: async () => { throw Error('must not scan') } }, s3: { send: async () => { throw Error('must not contact s3') } } } as any
    assert.doesNotThrow(() => createSecureV2ProductionApp({ ...deps, env: fileEnv, files }))
    assert.throws(() => createSecureV2ProductionApp({ ...deps, env: { ...fileEnv, SECURE_V2_FILE_S3_EXPECTED_OWNER: 'wrong' }, files }))
    assert.throws(() => createSecureV2ProductionApp({ ...deps, env: fileEnv, files: { ...files, s3: undefined } as any }))
    const original = pool.options.ssl
    try {
      pool.options.ssl = { rejectUnauthorized: false }
      assert.throws(() => createSecureV2ProductionApp(deps))
      pool.options.ssl = true
      assert.throws(() => createSecureV2ProductionApp(deps))
      pool.options.ssl = { rejectUnauthorized: true, checkServerIdentity: () => undefined }
      assert.throws(() => createSecureV2ProductionApp(deps))
    } finally { pool.options.ssl = original }
    assert.deepEqual(counts(), { queries: 0, sends: 0 })
  } finally { await pool.end() }
})

test('real composition blocks legacy routes, verifies JWTs, keeps disabled features unavailable, and health is only liveness', async () => {
  const { deps, pool, counts } = setup(), instance = await listen(createSecureV2ProductionApp(deps))
  try {
    const get = (path: string, headers: Record<string,string> = {}, method = 'GET') => fetch(instance.url + path, { headers, method })
    const live = await get('/healthz')
    assert.equal(live.status, 200); assert.deepEqual(await live.json(), { status: 'live' }); assert.match(live.headers.get('cache-control')!, /no-store/)
    assert.match(live.headers.get('permissions-policy')!, /camera=\(\)/)
    assert.equal((await get('/healthz', {}, 'POST')).status, 404)
    assert.equal((await get('/readyz')).status, 404)
    for (const path of ['/api/health', '/api/auth/login', '/api/cois', '/uploads/a.pdf', '/api/v2/authentic', '/api/v2/GC', '/api/v2/connections//qr', '/api/v2/%63onnections']) assert.equal((await get(path)).status, 404, path)
    assert.deepEqual(counts(), { queries: 0, sends: 0 })
    assert.equal((await get('/api/v2/connections/consent')).status, 401)
    assert.equal((await get('/api/v2/connections/consent', { authorization: 'Bearer invalid' })).status, 401)
    const headers = { authorization: `Bearer ${token()}` }
    for (const path of ['/api/client/share/example', '/api/v2/client/share/example']) {
      assert.equal((await get(path)).status, 404)
      assert.equal((await get(path, headers)).status, 404)
    }
    assert.equal((await get('/api/v2/connections/consent', headers)).status, 200)
    assert.equal((await get('/api/v2/self-reported-coi-metadata/consent', headers)).status, 503)
    assert.equal((await get('/api/v2/self-reported-private-files/consent', headers)).status, 503)
    assert.equal((await get('/api/v2/certificates/anything', headers)).status, 503)
    assert.equal((await get('/api/v2/auth/me', headers)).status, 200)
  } finally { await instance.close(); await pool.end() }
})

test('explicit metadata/files composition and invitation recipient policy remain separately gated', async () => {
  const { deps, pool } = setup()
  deps.env = { ...env, SECURE_V2_METADATA: 'enabled', SECURE_V2_FILES: 'enabled', SECURE_V2_FILE_S3_BUCKET: 'private-test-bucket', SECURE_V2_FILE_S3_EXPECTED_OWNER: '123456789012', SECURE_V2_FILE_MAX_BYTES: '1024', SECURE_V2_FILE_S3_DEADLINE_MS: '1000', SECURE_V2_FILE_UPLOAD_DEADLINE_MS: '2000' }
  deps.files = { inspector: { inspect: async () => { throw Error('must not inspect') } }, s3: { send: async () => { throw Error('must not contact storage') } } as any }
  let policyCalls = 0
  deps.authorizeInviteRecipient = async input => { policyCalls++; assert.equal(input.gcSubject, 'mock-gc'); return false }
  const instance = await listen(createSecureV2ProductionApp(deps))
  try {
    const headers = { authorization: `Bearer ${token()}` }
    assert.equal((await fetch(instance.url + '/api/v2/self-reported-coi-metadata/consent', { headers })).status, 200)
    assert.equal((await fetch(instance.url + '/api/v2/self-reported-private-files/consent', { headers })).status, 200)
    const invitation = await fetch(instance.url + '/api/v2/connections/invitations', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: '00000000-0000-4000-8000-000000000001' }) })
    assert.equal(invitation.status, 404); assert.equal(policyCalls, 1)
  } finally { await instance.close(); await pool.end() }
})

test('policies require literal authorization and sanitize dependency failures', async () => {
  const { deps, pool, counts } = setup()
  let limiterMode: 'ok'|'deny'|'error' = 'ok', emailAllowed = false
  deps.limiter.allow = async () => { if (limiterMode === 'error') throw Error('secret'); return limiterMode === 'ok' }
  deps.authorizeRegistrationEmail = async ({ email }) => emailAllowed && email === 'allowed@example.test'
  const instance = await listen(createSecureV2ProductionApp(deps))
  try {
    const register = (email: string) => fetch(instance.url + '/api/v2/auth/register/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
    assert.equal((await register('not-allowed@example.test')).status, 503); assert.equal(counts().sends, 0)
    emailAllowed = true
    assert.equal((await register('not-allowed@example.test')).status, 503); assert.equal(counts().sends, 0)
    assert.equal((await register('allowed@example.test')).status, 202); assert.equal(counts().sends, 1)
    limiterMode = 'deny'; assert.equal((await register('allowed@example.test')).status, 429)
    limiterMode = 'error'; const result = await register('allowed@example.test'); assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('secret'))
    assert.equal(counts().sends, 1)
  } finally { await instance.close(); await pool.end() }
})
