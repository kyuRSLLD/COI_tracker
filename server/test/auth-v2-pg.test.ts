import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { gcSubConsentService, CONSENT_V1, UnavailableError } from '../src/services/gcSubConsent.ts'

const url = process.env.AUTH_V2_TEST_PG_URL
if (!url) throw new Error('AUTH_V2_TEST_PG_URL is required; use a disposable local PostgreSQL 16 database')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || !/^\/auth_v2_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search || parsed.hash || !parsed.port) throw new Error('Explicit disposable 127.0.0.1:port auth_v2_test_* database without URL options required')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'synthetic-issuer', audience: 'synthetic-audience' }
const password = 'correct horse battery staple'
const hash = (s: string) => createHash('sha256').update(s).digest()

test('disposable PostgreSQL: sessions, lifecycle, HTTP and consent compatibility', async () => {
  const schema = `auth_v2_test_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined, server: import('node:http').Server | undefined
  try {
    const v = await admin.query("SELECT current_setting('server_version_num')::int AS version")
    assert.ok(v.rows[0].version >= 160000 && v.rows[0].version < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,role TEXT, created_at TEXT NOT NULL);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,user_id TEXT,company_name TEXT NOT NULL,trade TEXT NOT NULL,status TEXT,email TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT,effective_date TEXT,expiration_date TEXT,status TEXT)`)
    await pool.query(`INSERT INTO users VALUES('gc1','gc@example.test','legacy-hash','GC','gc','now'),('sub1','sub@example.test','legacy-hash','Sub','sub','now'),('admin1','admin@example.test','legacy-hash','Admin','admin','now')`)
    await pool.query("INSERT INTO subcontractors VALUES('legacy',NULL,'Legacy','trade','active','sub@example.test')")
    const c = await pool.connect()
    try {
      await c.query('CREATE TABLE auth_v2_sessions(dummy integer)')
      await assert.rejects(migrateAuthV2V1(c))
      assert.equal((await c.query("SELECT to_regclass('auth_v2_accounts') AS account, to_regclass('auth_v2_schema_migrations') AS ledger")).rows[0].account, null)
      assert.equal((await c.query("SELECT to_regclass('auth_v2_schema_migrations') AS ledger")).rows[0].ledger, null)
      await c.query('DROP TABLE auth_v2_sessions')
      assert.equal(await migrateAuthV2V1(c), 'applied')
      assert.equal(await migrateAuthV2V1(c), 'already-applied')
      const originalChecksum = (await c.query('SELECT checksum FROM auth_v2_schema_migrations WHERE version=1')).rows[0].checksum
      await c.query("UPDATE auth_v2_schema_migrations SET checksum='tampered'")
      await assert.rejects(migrateAuthV2V1(c), /changed/)
      await c.query('UPDATE auth_v2_schema_migrations SET checksum=$1 WHERE version=1', [originalChecksum])
      await migrateGcSubConsentV1(c)
    } finally { c.release() }
    const passhash = await hashV2Password(password)
    await pool.query(`INSERT INTO auth_v2_accounts VALUES ('gc1','gc@example.test',$1,clock_timestamp(),'synthetic-review',true),('sub1','sub@example.test',$1,clock_timestamp(),'synthetic-review',true),('admin1','admin@example.test',$1,clock_timestamp(),'synthetic-review',true)`, [passhash])
    const auth = createV2Auth(pool, config)
    const consent = gcSubConsentService(pool, { publicKey: config.publicKey, issuer: config.issuer, audience: config.audience })
    const app = express(); app.use('/api/v2/auth', auth.router)
    app.get('/guarded', auth.requireAuth, (_req, res) => res.json(res.locals.authV2))
    app.get('/consent', auth.requireAuth, async (_req, res) => {
      try { res.json(await consent.listGrantedSubs(res.locals.authV2.credential)) } catch { res.status(403).json({ error: 'Unavailable' }) }
    })
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server!.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const request = (path: string, opts: RequestInit = {}) => fetch(base + path, opts)
    const post = (path: string, body: unknown, token?: string) => request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
    const login = async (email: string, pass = password) => {
      const response = await post('/api/v2/auth/login', { email, password: pass }); assert.equal(response.status, 200); return (await response.json()).token as string
    }
    const me = (token: string) => request('/api/v2/auth/me', { headers: { authorization: `Bearer ${token}` } })
    assert.equal((await post('/api/v2/auth/register', { email: 'sub@example.test', role: 'sub', password })).status, 503)
    assert.equal((await post('/api/v2/auth/register', { role: 'admin' })).status, 400)
    assert.equal(Number((await pool.query('SELECT count(*) FROM users')).rows[0].count), 3)
    assert.equal(Number((await pool.query('SELECT count(*) FROM gc_sub_profiles')).rows[0].count), 0)
    assert.equal((await pool.query("SELECT user_id FROM subcontractors WHERE id='legacy'")).rows[0].user_id, null)
    for (const email of ['gc@example.test', 'unknown@example.test']) {
      const r = await post('/api/v2/auth/login', { email, password: 'wrong password' }); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'Invalid credentials' })
    }
    assert.equal((await post('/api/v2/auth/login', { email: {}, password })).status, 400)
    assert.equal((await request('/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400)
    assert.equal((await request('/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gc@example.test', password: 'a'.repeat(9000) }) })).status, 413)
    const gc = await login(' GC@example.test '), sub = await login('sub@example.test'), adminToken = await login('admin@example.test')
    const payload = jwt.verify(gc, publicKey, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience }) as jwt.JwtPayload
    assert.equal(payload.sub, 'gc1'); assert.equal(payload.role, undefined)
    assert.equal((await pool.query('SELECT count(*) FROM auth_v2_sessions WHERE token_hash=$1', [hash(gc)])).rows[0].count, '1')
    const m = await me(gc); assert.equal(m.status, 200); assert.equal(m.headers.get('cache-control'), 'no-store'); assert.deepEqual(await m.json(), { subject: 'gc1', role: 'gc' })
    assert.deepEqual(await (await me(adminToken)).json(), { subject: 'admin1', role: 'admin' })
    const guard = await request('/guarded', { headers: { authorization: `Bearer ${gc}` } }); assert.equal(guard.headers.get('cache-control'), 'no-store'); assert.deepEqual(await guard.json(), { subject: 'gc1', role: 'gc', credential: gc })
    assert.equal((await request('/api/v2/auth/me', { headers: { cookie: `token=${gc}` } })).status, 401)
    const duplicateStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/v2/auth/me`, { headers: ['Host', new URL(base).host, 'Authorization', `Bearer ${gc}`, 'Authorization', `Bearer ${gc}`] }, response => { response.resume(); resolve(response.statusCode!) })
      req.on('error', reject); req.end()
    })
    assert.equal(duplicateStatus, 401)
    const malicious = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) => jwt.sign(claims, privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: 'gc1', jwtid: randomBytes(32).toString('base64url'), expiresIn: '15m', ...opts })
    const invalidTokens = [malicious({}, { issuer: 'wrong' }), malicious({}, { audience: 'wrong' }), malicious({}, { audience: ['synthetic-audience', 'other'] }), malicious({}, { expiresIn: -1 }), malicious({}, { expiresIn: '16m' }), malicious({}, { notBefore: '5m' }), jwt.sign({ sub: 'gc1' }, 'secret', { algorithm: 'HS256', issuer: config.issuer, audience: config.audience, expiresIn: '15m' }), jwt.sign({ sub: 'gc1', jti: randomBytes(32).toString('base64url') }, privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience }), gc + 'x']
    for (const token of invalidTokens) {
      // A session row cannot rescue an invalid JWT, even if it is correctly signed.
      await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,'gc1',clock_timestamp()+interval '10 minutes')", [hash(token)])
      assert.equal((await me(token)).status, 401)
    }
    // Signed token with a stored hash but malicious role claims gets ONLY the live DB role.
    const forged = malicious({ role: 'admin' })
    await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,'gc1',clock_timestamp()+interval '10 minutes')", [hash(forged)])
    assert.deepEqual(await (await me(forged)).json(), { subject: 'gc1', role: 'gc' })
    const profile = randomUUID()
    await pool.query("INSERT INTO subcontractors VALUES('verified',NULL,'Verified','trade','active','other@example.test')")
    await pool.query("INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference) VALUES($1,'verified','sub1',clock_timestamp(),'synthetic-review')", [profile])
    const qr = await consent.issueSubQr(sub, profile, CONSENT_V1); await consent.redeemSubQr(gc, qr.token)
    assert.equal((await request('/consent', { headers: { authorization: `Bearer ${gc}` } })).status, 200)
    assert.equal((await post('/api/v2/auth/logout', {}, gc)).status, 204)
    assert.equal((await me(gc)).status, 401)
    assert.equal((await request('/consent', { headers: { authorization: `Bearer ${gc}` } })).status, 401)
    // The service itself rejects a logged-out credential, independently of middleware.
    await assert.rejects(consent.listGrantedSubs(gc), UnavailableError)
    const one = await login('gc@example.test'), two = await login('gc@example.test')
    assert.equal((await post('/api/v2/auth/logout-all', {}, one)).status, 204)
    assert.equal((await me(one)).status, 401); assert.equal((await me(two)).status, 401); assert.equal((await me(forged)).status, 401)
    // Emulate the share-locked issuance transaction: logout-all must wait and revoke
    // the session committed before it obtains the user lock.
    const existing = await login('gc@example.test')
    const issuer = await pool.connect()
    try {
      await issuer.query('BEGIN')
      await issuer.query("SELECT id FROM users WHERE id='gc1' FOR SHARE")
      const pendingHash = hash('synthetic pending session')
      await issuer.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,'gc1',clock_timestamp()+interval '10 minutes')", [pendingHash])
      let finished = false
      const logout = post('/api/v2/auth/logout-all', {}, existing).then(r => { finished = true; return r })
      await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(finished, false)
      await issuer.query('COMMIT')
      assert.equal((await logout).status, 204)
      assert.ok((await pool.query('SELECT revoked_at FROM auth_v2_sessions WHERE token_hash=$1', [pendingHash])).rows[0].revoked_at)
    } finally { await issuer.query('ROLLBACK'); issuer.release() }
    const oldRole = await login('gc@example.test')
    await pool.query("UPDATE users SET role='sub' WHERE id='gc1'")
    assert.equal((await me(oldRole)).status, 401)
    await pool.query("UPDATE users SET role='gc' WHERE id='gc1'")
    assert.equal((await me(oldRole)).status, 401)
    const disabled = await login('gc@example.test')
    await pool.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc1'")
    assert.equal((await me(disabled)).status, 401)
    assert.equal((await post('/api/v2/auth/login', { email: 'gc@example.test', password })).status, 401)
    await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc1'")
    assert.equal((await me(disabled)).status, 401)
    const deleted = await login('gc@example.test')
    await pool.query("DELETE FROM auth_v2_accounts WHERE user_id='gc1'")
    await pool.query("INSERT INTO auth_v2_accounts VALUES('gc1','gc@example.test',$1,clock_timestamp(),'synthetic-review',true)", [passhash])
    assert.equal((await me(deleted)).status, 401)
    const expired = await login('gc@example.test')
    await pool.query("UPDATE auth_v2_sessions SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1", [hash(expired)])
    assert.equal((await me(expired)).status, 401)
    const stale = await login('gc@example.test')
    await pool.query("UPDATE auth_v2_accounts SET password_hash=$1 WHERE user_id='gc1'", [await hashV2Password('a different long password')])
    assert.equal((await me(stale)).status, 401)
    assert.equal((await post('/api/v2/auth/login', { email: 'gc@example.test', password })).status, 401)
    const legacyStale = await login('gc@example.test', 'a different long password')
    await pool.query("UPDATE users SET password_hash='new-legacy-value' WHERE id='gc1'")
    assert.equal((await me(legacyStale)).status, 401)
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
