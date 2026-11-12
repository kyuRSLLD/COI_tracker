import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import pg from 'pg'
import { createSecureV2ProductionApp } from '../src/secure-v2-production.ts'
import type { SecureV2ProductionDependencies } from '../src/secure-v2-production.ts'
import { hashV2Password } from '../src/v2/auth.ts'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const baseEnv = {
  SECURE_V2_CONFIG_VERSION: '1', SECURE_V2_DB_HOST: 'db.example.test', SECURE_V2_DB_PORT: '5432',
  SECURE_V2_DB_NAME: 'isolated_v2', SECURE_V2_DB_USER: 'v2_user', SECURE_V2_DB_PASSWORD: 'synthetic-db-password',
  SECURE_V2_JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  SECURE_V2_JWT_PUBLIC_KEY_PEM: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  SECURE_V2_JWT_ISSUER: 'test-issuer', SECURE_V2_JWT_AUDIENCE: 'test-audience',
  SECURE_V2_SES_REGION: 'us-east-1', SECURE_V2_SES_FROM: 'verify@example.test', SECURE_V2_SES_TIMEOUT_MS: '1000',
  SECURE_V2_METADATA: 'disabled', SECURE_V2_FILES: 'disabled',
}
const password = 'synthetic test password'
function fixture() {
  const pool = new pg.Pool({ host: baseEnv.SECURE_V2_DB_HOST, port: 5432, database: baseEnv.SECURE_V2_DB_NAME,
    user: baseEnv.SECURE_V2_DB_USER, password: baseEnv.SECURE_V2_DB_PASSWORD, ssl: { rejectUnauthorized: true },
    options: '-c search_path=public', max: 3, connectionTimeoutMillis: 1000, statement_timeout: 1000,
    lock_timeout: 500, idle_in_transaction_session_timeout: 2000 })
  let queries = 0
  ;(pool as any).query = async () => { queries++; return { rows: [], rowCount: 0 } }
  const deps: SecureV2ProductionDependencies = { env: { ...baseEnv }, pool,
    limiter: { allow: async () => true, allowRegistration: async () => true },
    ses: { send: async () => ({}) }, authorizeRegistrationEmail: async () => false, authorizeInviteRecipient: async () => false }
  return { pool, deps, queries: () => queries }
}
async function listen(deps: SecureV2ProductionDependencies) {
  const server = createSecureV2ProductionApp(deps).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Invalid test address')
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
function post(url: string, body: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/json' }, path = '/api/v2/auth/login') {
  return fetch(url + path, { method: 'POST', headers, body: body as any })
}
const payload = (email = 'Person@example.test', pw = password) => JSON.stringify({ email, password: pw })

// No external database or service is contacted. All keys and identities are ephemeral/synthetic.
test('opt-in requires both an account limiter and canonical 32-byte HMAC key, with no downgrade', async () => {
  const { pool, deps, queries } = fixture()
  const key = randomBytes(32).toString('base64url')
  const allow = async () => true
  try {
    assert.doesNotThrow(() => createSecureV2ProductionApp(deps))
    assert.throws(() => createSecureV2ProductionApp({ ...deps, env: { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: key } }), /Invalid secure-v2 configuration or dependencies/)
    assert.throws(() => createSecureV2ProductionApp({ ...deps, limiter: { ...deps.limiter, allowLoginAccount: allow } }), /Invalid secure-v2 configuration or dependencies/)
    for (const bad of ['', 'bad', key + '=', 'A'.repeat(42) + 'B', null, 7]) {
      assert.throws(() => createSecureV2ProductionApp({ ...deps, env: { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: bad as any }, limiter: { ...deps.limiter, allowLoginAccount: allow } }), e => {
        assert.equal((e as Error).message, 'Invalid secure-v2 configuration or dependencies'); return true
      })
    }
    assert.throws(() => createSecureV2ProductionApp({ ...deps, env: { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: key }, limiter: { ...deps.limiter, allowLoginAccount: null as any } }))
    assert.doesNotThrow(() => createSecureV2ProductionApp({ ...deps, env: { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: key }, limiter: { ...deps.limiter, allowLoginAccount: allow } }))
    assert.equal(queries(), 0)
  } finally { await pool.end() }
})

test('default composition retains the original login behavior without an account dependency', async () => {
  const { pool, deps, queries } = fixture(), app = await listen(deps)
  try {
    const invalid = await post(app.url, payload('bad-email'))
    assert.equal(invalid.status, 400); assert.equal(queries(), 0)
    const login = await post(app.url, payload())
    assert.equal(login.status, 401); assert.deepEqual(await login.json(), { error: 'Invalid credentials' })
    assert.equal(queries(), 1)
  } finally { await app.close(); await pool.end() }
})

test('preauth precedes one bounded strict parse; only valid login attempts send normalized keyed hashes', async () => {
  const { pool, deps, queries } = fixture(), key = randomBytes(32)
  deps.env = { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: key.toString('base64url') }
  const events: string[] = [], hashes: string[] = []
  let preauth = true, result: unknown = true
  deps.limiter.allow = async input => { events.push(input.scope + ':' + input.phase); return preauth }
  deps.limiter.allowLoginAccount = async input => {
    events.push('account'); assert.deepEqual(Object.keys(input), ['accountHash']); hashes.push(input.accountHash); return result as boolean
  }
  const app = await listen(deps)
  try {
    preauth = false
    assert.equal((await post(app.url, '{')).status, 429)
    assert.deepEqual(events, ['auth:preauth']); assert.equal(hashes.length, 0); assert.equal(queries(), 0)
    preauth = true; events.length = 0
    const malformed = await post(app.url, '{"email":"secret@example.test",')
    assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes('secret'))
    assert.equal((await post(app.url, JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(9000) }))).status, 413)
    const compressed = gzipSync(JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(9000) }))
    assert.equal((await post(app.url, compressed, { 'content-type': 'application/json', 'content-encoding': 'gzip' })).status, 413)
    assert.equal((await post(app.url, '"not an object"')).status, 400)
    assert.equal((await post(app.url, payload(), { 'content-type': 'text/plain' })).status, 400)
    assert.equal((await post(app.url, payload('not-an-email'))).status, 400)
    assert.equal((await post(app.url, payload('person@example.test', ''))).status, 400)
    assert.equal(hashes.length, 0); assert.equal(queries(), 0)
    events.length = 0
    for (const [email, path] of [['  PERSON@Example.Test  ', '/api/v2/auth/login'], ['person@example.test', '/api/v2/auth/LOGIN'], ['Person@example.test', '/api/v2/auth/login/']]) {
      const response = await post(app.url, payload(email), undefined, path)
      assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'Invalid credentials' })
      assert.match(response.headers.get('cache-control')!, /no-store/)
    }
    assert.deepEqual(events, ['auth:preauth', 'account', 'auth:preauth', 'account', 'auth:preauth', 'account'])
    const expected = createHmac('sha256', key).update('secure-v2:login-account:v1\0').update('person@example.test').digest('base64url')
    assert.deepEqual(hashes, [expected, expected, expected]); assert.equal(queries(), 3)
    result = false
    let response = await post(app.url, payload('different@example.test'))
    assert.equal(response.status, 429); assert.deepEqual(await response.json(), { error: 'Unavailable' }); assert.equal(queries(), 3)
    assert.notEqual(hashes.at(-1), expected)
    for (const value of [undefined, null, 1, 'true', {}]) {
      result = value; response = await post(app.url, payload())
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'Unavailable' }); assert.equal(queries(), 3)
    }
    assert.equal((await post(app.url, '{}', undefined, '/api/v2/auth/register')).status, 503)
    assert.equal(queries(), 3)
  } finally { await app.close(); await pool.end() }
})

test('limiter exceptions and timeouts fail closed and late approval cannot trigger login', async () => {
  const { pool, deps, queries } = fixture()
  deps.env = { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: randomBytes(32).toString('base64url') }
  let mode = 'throw'
  deps.limiter.allowLoginAccount = async () => {
    if (mode === 'throw') throw new Error('synthetic-password-and-secret')
    return new Promise(resolve => setTimeout(() => resolve(true), 2200))
  }
  const app = await listen(deps)
  try {
    let response = await post(app.url, payload())
    assert.equal(response.status, 503); assert.equal(await response.text(), '{"error":"Unavailable"}'); assert.equal(queries(), 0)
    mode = 'timeout'
    response = await post(app.url, payload())
    assert.equal(response.status, 503); assert.equal(await response.text(), '{"error":"Unavailable"}')
    await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(queries(), 0)
  } finally { await app.close(); await pool.end() }
})

test('shared limiter budgets span instances and count attempts before database work', async () => {
  const a = fixture(), b = fixture(), key = randomBytes(32).toString('base64url'), counts = new Map<string, number>()
  let calls = 0
  const shared = async ({ accountHash }: { accountHash: string }) => {
    calls++; const n = (counts.get(accountHash) ?? 0) + 1; counts.set(accountHash, n); return n <= 2
  }
  for (const f of [a, b]) { f.deps.env = { ...f.deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: key }; f.deps.limiter.allowLoginAccount = shared }
  const appA = await listen(a.deps), appB = await listen(b.deps)
  try {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => post(i % 2 ? appA.url : appB.url, payload(i % 2 ? '  PERSON@example.test ' : 'person@EXAMPLE.TEST'))))
    assert.equal(responses.filter(r => r.status === 401).length, 2)
    assert.equal(responses.filter(r => r.status === 429).length, 4)
    assert.equal(calls, 6); assert.equal(counts.size, 1); assert.equal(a.queries() + b.queries(), 2)
    assert.equal((await post(appB.url, payload('other@example.test'))).status, 401)
    assert.equal(counts.size, 2)
  } finally { await appA.close(); await appB.close(); await a.pool.end(); await b.pool.end() }
})

test('allowed valid credentials use the original parsed body and issue a session', async () => {
  const { pool, deps } = fixture(), storedHash = await hashV2Password(password), seen: string[] = []
  deps.env = { ...deps.env, SECURE_V2_LOGIN_ACCOUNT_HMAC_KEY: randomBytes(32).toString('base64url') }
  deps.limiter.allowLoginAccount = async ({ accountHash }) => { seen.push(accountHash); return true }
  ;(pool as any).query = async (sql: string, values: unknown[]) => {
    assert.match(sql, /WHERE a.login_email=\$1/); assert.deepEqual(values, ['person@example.test'])
    return { rows: [{ user_id: 'synthetic-user', password_hash: storedHash }], rowCount: 1 }
  }
  ;(pool as any).connect = async () => ({
    query: async (sql: string) => {
      if (sql.includes('SELECT role')) return { rows: [{ role: 'gc' }], rowCount: 1 }
      if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'synthetic-user' }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }, release() {},
  })
  const app = await listen(deps)
  try {
    const response = await post(app.url, payload('  PERSON@Example.Test '))
    assert.equal(response.status, 200); const json = await response.json() as any
    assert.equal(json.token_type, 'Bearer'); assert.equal(typeof json.token, 'string'); assert.equal(seen.length, 1)
  } finally { await app.close(); await pool.end() }
})
