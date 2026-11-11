import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import { Readable } from 'node:stream'
import express from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migratePrivateCertificateMetadataV1 } from '../src/db/migrations/003_private_certificate_metadata.ts'
import { postgresOwnerConnection } from '../src/db/ownerConnection.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { createSecureV2SyntheticTestApp, createVerifiedPrincipalAdapter } from '../src/secure-v2-synthetic.ts'

const url = process.env.SECURE_V2_TEST_PG_URL
if (!url || process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test and a disposable SECURE_V2_TEST_PG_URL are required')
const u = new URL(url)
if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || !u.port || !/^\/secure_v2_test_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error('Explicit disposable loopback secure_v2_test_* database required')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'synthetic-only', audience: 'synthetic-client' }
const password = 'unique synthetic password 123'

test('real HTTP composition with PostgreSQL 16 and synthetic identities, mock S3 only', async () => {
  const schema = `v2_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  let pool: pg.Pool | undefined
  const servers: http.Server[] = []
  try {
    const version = (await admin.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v
    assert.ok(version >= 160000 && version < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,user_id TEXT,company_name TEXT NOT NULL,trade TEXT NOT NULL,contact_person TEXT,phone TEXT,email TEXT,address TEXT,notes TEXT,status TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,am_best_rating TEXT,policy_number TEXT,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,reviewer_notes TEXT,certificate_url TEXT,certificate_key TEXT,certificate_name TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`)
    const c = await pool.connect()
    try {
      assert.equal(await migrateOwnerFoundationV1(postgresOwnerConnection(c)), 'applied')
      assert.equal(await migrateGcSubConsentV1(c), 'applied')
      assert.equal(await migrateAuthV2V1(c), 'applied')
      assert.equal(await migratePrivateCertificateMetadataV1(c), 'applied')
    } finally { c.release() }
    const passhash = await hashV2Password(password)
    await pool.query(`INSERT INTO users VALUES ('gc1','gc1@example.test','legacy','GC One','gc','now'),('gc2','gc2@example.test','legacy','GC Two','gc','now'),('sub1','sub1@example.test','legacy','Sub One','sub','now'),('sub2','sub2@example.test','legacy','Sub Two','sub','now');`)
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled)
      SELECT id,email,$1,clock_timestamp(),'synthetic-only',true FROM users`, [passhash])
    const phases: string[] = []
    let mode: 'allow' | 'deny' | 'error' = 'allow'
    const testRateLimit = async (x: { scope: string; phase: string; remoteAddress: string; subject?: string }) => {
      phases.push(`${x.scope}:${x.phase}`); assert.ok(x.remoteAddress)
      if (mode === 'error') throw new Error('sensitive test limiter error')
      return mode === 'allow'
    }
    const objects = new Map<string, { body: Buffer; mime: string }>()
    let s3Calls = 0
    const s3 = {
      async put(command: any) { s3Calls++; objects.set(command.input.Key, { body: Buffer.from(command.input.Body), mime: command.input.ContentType }) },
      async get(command: any) { s3Calls++; const obj = objects.get(command.input.Key); if (!obj) throw Error('secret mock S3 key'); return { Body: Readable.from([obj.body]), ContentLength: obj.body.length, ContentType: obj.mime } },
    }
    const options = { pool, authConfig: config, testRateLimit, unsafeTestOnlyEnableConsent: true, unsafeTestOnlyMockS3: s3 }
    const unsafePool = new pg.Pool({ connectionString: 'postgresql://synthetic@192.0.2.1:5432/secure_v2_test_fake' })
    try { assert.throws(() => createSecureV2SyntheticTestApp({ ...options, pool: unsafePool }), /loopback/) } finally { await unsafePool.end() }
    const savedEnv = process.env.NODE_ENV
    try { process.env.NODE_ENV = 'production'; assert.throws(() => createSecureV2SyntheticTestApp(options), /NODE_ENV=test/) } finally { process.env.NODE_ENV = savedEnv }
    const app = createSecureV2SyntheticTestApp(options)
    const start = async (app: express.Express) => {
      const s = app.listen(0, '127.0.0.1'); servers.push(s)
      await new Promise<void>((resolve, reject) => { s.once('listening', resolve); s.once('error', reject) })
      return `http://127.0.0.1:${(s.address() as import('node:net').AddressInfo).port}`
    }
    const base = await start(app)
    const call = async (path: string, method = 'GET', token?: string, body?: unknown, extra: Record<string,string> = {}) => {
      const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      assert.match(r.headers.get('cache-control') || '', /no-store/)
      const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null, text: t }
    }
    const login = async (email: string) => {
      const r = await call('/api/v2/auth/login', 'POST', undefined, { email, password }); assert.equal(r.status, 200); return r.body.token as string
    }
    assert.deepEqual(await call('/api/v2/auth/login', 'POST', undefined, { email: 'gc1@example.test', password: 'wrong' }), { status: 401, body: { error: 'Invalid credentials' }, text: '{"error":"Invalid credentials"}' })
    const gc1 = await login('gc1@example.test'), sub1 = await login('sub1@example.test'), sub2 = await login('sub2@example.test')
    let gc2 = await login('gc2@example.test')
    const payload = jwt.verify(gc1, keys.publicKey, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience }) as jwt.JwtPayload
    assert.equal(payload.sub, 'gc1'); assert.equal(payload.role, undefined)
    const own = await call('/api/v2/gc/subcontractors', 'POST', gc1, { company_name: 'Synthetic', trade: 'Trade' }, { 'x-user-id': 'gc2', 'x-role': 'admin' })
    assert.equal(own.status, 201)
    const other = await call('/api/v2/gc/subcontractors', 'POST', gc2, { company_name: 'Synthetic', trade: 'Trade' })
    assert.equal(other.status, 201)
    assert.equal((await call(`/api/v2/gc/subcontractors/${own.body.id}`, 'GET', gc1)).status, 200)
    assert.deepEqual((await call(`/api/v2/gc/subcontractors/${own.body.id}`, 'GET', gc2)).body, { error: 'Not found' })
    assert.equal((await call('/api/v2/gc/subcontractors?owner_user_id=gc1', 'GET', gc2)).body.length, 1)
    assert.equal((await call('/api/v2/gc/subcontractors', 'POST', gc1, { company_name: 'X', trade: 'T', owner_user_id: 'gc2' })).status, 400)
    assert.equal((await call('/api/v2/gc/subcontractors', 'GET', sub1)).status, 404)
    const coi = await call(`/api/v2/gc/subcontractors/${own.body.id}/cois`, 'POST', gc1, { carrier: 'Carrier', effective_date: '2025-01-01', expiration_date: '2030-01-01' })
    assert.equal(coi.status, 201)
    assert.equal((await call(`/api/v2/gc/cois/${coi.body.id}`, 'GET', gc2)).status, 404)
    const profile = randomUUID()
    await pool.query("INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference) VALUES($1,$2,'sub1',now(),'synthetic-only')", [profile, own.body.id])
    await pool.query("INSERT INTO gc_sub_coi_ownership(coi_id,profile_id,subcontractor_id,verified_at,verification_reference) VALUES($1,$2,$3,now(),'synthetic-only')", [coi.body.id,profile,own.body.id])
    const disclose = await call('/api/v2/connections/consent', 'GET', sub1)
    assert.equal(disclose.status, 200); assert.ok(disclose.body.qrText)
    assert.equal((await call('/api/v2/connections/qr', 'POST', sub2, { profileId: profile, consentVersion: disclose.body.version, affirmative: true })).status, 404)
    assert.equal((await call('/api/v2/connections/qr', 'POST', sub1, { profileId: profile, consentVersion: disclose.body.version, affirmative: false })).status, 404)
    const qr = await call('/api/v2/connections/qr', 'POST', sub1, { profileId: profile, consentVersion: disclose.body.version, affirmative: true })
    assert.equal(qr.status, 200)
    assert.equal((await call('/api/v2/connections/qr/redeem', 'POST', gc2, { token: qr.body.token })).status, 204)
    assert.equal((await call('/api/v2/connections/qr/redeem', 'POST', gc1, { token: qr.body.token })).status, 404)
    assert.deepEqual((await call('/api/v2/connections/cois', 'POST', gc2, { profileId: profile })).body.cois.map((x: any) => x.id), [coi.body.id])
    assert.deepEqual((await call('/api/v2/connections/invitations', 'POST', gc1, { profileId: profile })).body, { error: 'Unavailable' })
    const file = `/api/v2/certificates/${coi.body.id}`
    const pdf = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF')
    for (const method of ['GET','PUT']) {
      const r = await fetch(base + file, { method, headers: { authorization: `Bearer ${gc2}`, ...(method === 'PUT' ? { 'content-type': 'application/pdf' } : {}) }, ...(method === 'PUT' ? { body: pdf } : {}) })
      assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'Unavailable' })
    }
    assert.equal(s3Calls, 0, 'metadata consent never grants file access')
    assert.equal((await call(file, 'GET', sub2)).status, 404)
    const jsonFile = await fetch(base + file, { method: 'PUT', headers: { authorization: `Bearer ${sub1}`, 'content-type': 'application/json' }, body: '{broken' })
    assert.equal(jsonFile.status, 400); assert.deepEqual(await jsonFile.json(), { error: 'Invalid request' })
    const forgedRole = jwt.sign({ role: 'sub' }, keys.privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: 'gc2', jwtid: randomBytes(32).toString('base64url'), expiresIn: 900 })
    await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,'gc2',now()+interval '10 minutes')", [createHash('sha256').update(forgedRole).digest()])
    assert.equal((await call(file, 'GET', forgedRole)).status, 503, 'JWT role claim cannot elevate a GC to a sub')
    const upload = await fetch(base + file, { method: 'PUT', headers: { authorization: `Bearer ${sub1}`, 'content-type': 'application/pdf' }, body: pdf })
    assert.equal(upload.status, 201); assert.deepEqual(await upload.json(), { mime: 'application/pdf', size: pdf.length })
    const download = await fetch(base + file, { headers: { authorization: `Bearer ${sub1}` } })
    assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf)
    assert.equal((await call('/api/v2/connections/revoke', 'POST', sub2, { profileId: profile, gcUserId: 'gc2' })).status, 404)
    assert.equal((await call('/api/v2/connections/revoke', 'POST', sub1, { profileId: profile, gcUserId: 'gc2' })).status, 204)
    assert.deepEqual((await call('/api/v2/connections/cois', 'POST', gc2, { profileId: profile })).body.cois, [])
    const normal = await call('/api/v2/gc/subcontractors', 'GET', undefined, undefined, { 'x-user-id': 'gc1', 'x-role': 'gc' })
    assert.deepEqual(normal.body, { error: 'Authentication required' }); assert.equal(normal.status, 401)
    const duplicateStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/v2/gc/subcontractors`, { headers: ['Host', new URL(base).host, 'Authorization', `Bearer ${gc2}`, 'Authorization', `Bearer ${gc1}`] }, res => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject); req.end()
    })
    assert.equal(duplicateStatus, 401)
    const expired = jwt.sign({}, keys.privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: 'gc1', jwtid: randomBytes(32).toString('base64url'), expiresIn: -1 })
    await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,'gc1',now()+interval '10 minutes')", [createHash('sha256').update(expired).digest()])
    for (const token of ['bad.bad.bad', expired, gc1 + 'x']) assert.equal((await call('/api/v2/gc/subcontractors', 'GET', token)).status, 401)
    assert.equal((await call('/api/v2/auth/logout', 'POST', gc1, {})).status, 204)
    for (const path of ['/api/v2/auth/me','/api/v2/gc/subcontractors','/api/v2/connections/consent',file]) assert.equal((await call(path, 'GET', gc1)).status, 401)
    for (const path of ['/api/cois','/api/auth/login','/uploads/file.pdf','/api/v1/gc','/api/client/share/x','/api/v2/gcc/subcontractors']) assert.equal((await call(path, 'GET', gc2)).status, 404)
    const oversized = await call('/api/v2/connections/qr', 'POST', sub1, { profileId: profile, consentVersion: 'x'.repeat(5000), affirmative: true })
    assert.equal(oversized.status, 503); assert.deepEqual(oversized.body, { error: 'Unavailable' })
    const oversizedAuth = await call('/api/v2/auth/login', 'POST', undefined, { email: 'a@example.test', password: 'x'.repeat(9000) })
    assert.equal(oversizedAuth.status, 413)
    assert.ok(phases.includes('auth:preauth') && phases.includes('protected:preauth') && phases.includes('protected:principal') && phases.includes('connections-router:preauth') && phases.includes('connections-router:principal'))
    mode = 'deny'; assert.equal((await call('/api/v2/auth/login', 'POST', undefined, {})).status, 429); assert.equal((await call('/api/v2/gc/subcontractors', 'GET', gc2)).status, 429)
    mode = 'error'; const limitError = await call('/api/v2/gc/subcontractors', 'GET', gc2); assert.equal(limitError.status, 503); assert.deepEqual(limitError.body, { error: 'Unavailable' }); mode = 'allow'
    const defaults = await start(createSecureV2SyntheticTestApp({ pool, authConfig: config, testRateLimit }))
    assert.equal((await fetch(defaults + '/api/v2/connections/consent', { headers: { authorization: `Bearer ${sub1}` } })).status, 503)
    assert.equal((await fetch(defaults + file, { headers: { authorization: `Bearer ${sub1}` } })).status, 503)
    const invitationApp = await start(createSecureV2SyntheticTestApp({ ...options, testAuthorizeInviteRecipient: async ({ gcSubject, profileId }) => gcSubject === 'gc2' && profileId === profile }))
    const invite = await fetch(invitationApp + '/api/v2/connections/invitations', { method: 'POST', headers: { authorization: `Bearer ${gc2}`, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: profile }) })
    assert.equal(invite.status, 200); assert.match((await invite.json()).token, /^[A-Za-z0-9_-]{43}$/)
    const deniedInvite = await fetch(invitationApp + '/api/v2/connections/invitations', { method: 'POST', headers: { authorization: `Bearer ${gc2}`, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: randomUUID() }) })
    assert.equal(deniedInvite.status, 404); assert.deepEqual(await deniedInvite.json(), { error: 'Unavailable' })
    // Force invalidation after both auth middleware passes but before the consent
    // transaction, via the real recipient-policy callback. No capability may persist.
    for (const event of ['logout', 'disable'] as const) {
      const current = await login('gc2@example.test')
      const before = Number((await pool.query('SELECT count(*) FROM gc_sub_capabilities')).rows[0].count)
      const boundary = await start(createSecureV2SyntheticTestApp({ ...options, testAuthorizeInviteRecipient: async () => {
        if (event === 'logout') assert.equal((await call('/api/v2/auth/logout', 'POST', current, {})).status, 204)
        else await pool!.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc2'")
        return true
      } }))
      const denied = await fetch(boundary + '/api/v2/connections/invitations', { method: 'POST', headers: { authorization: `Bearer ${current}`, 'content-type': 'application/json' }, body: JSON.stringify({ profileId: profile }) })
      assert.equal(denied.status, 404, event); assert.deepEqual(await denied.json(), { error: 'Unavailable' })
      assert.equal(Number((await pool.query('SELECT count(*) FROM gc_sub_capabilities')).rows[0].count), before, event)
      assert.equal((await call('/api/v2/connections/subcontractors', 'GET', current)).status, 401)
      if (event === 'disable') await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc2'")
    }
    // Real HTTP logout waits behind a consent transaction that already holds
    // the session lock. The consent commits first, then logout takes effect.
    const concurrentSub = await login('sub1@example.test')
    const gate = await pool.connect()
    const waitLock = async (fragment: string) => {
      for (let i = 0; i < 400; i++) {
        const r = await pool!.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${fragment}%`])
        if (r.rows[0].n) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Timed out waiting for ${fragment}`)
    }
    try {
      await gate.query('BEGIN')
      await gate.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [profile])
      const writing = call('/api/v2/connections/qr', 'POST', concurrentSub, { profileId: profile, consentVersion: disclose.body.version, affirmative: true })
      await waitLock('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles')
      const loggingOut = call('/api/v2/auth/logout', 'POST', concurrentSub, {})
      await waitLock('UPDATE auth_v2_sessions SET revoked_at=')
      await gate.query('COMMIT')
      assert.equal((await writing).status, 200)
      assert.equal((await loggingOut).status, 204)
      assert.equal((await call('/api/v2/connections/qr', 'POST', concurrentSub, { profileId: profile, consentVersion: disclose.body.version, affirmative: true })).status, 401)
    } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release() }
    gc2 = await login('gc2@example.test')
    const malformedConsent = await fetch(base + '/api/v2/connections/qr', { method: 'POST', headers: { authorization: `Bearer ${sub1}`, 'content-type': 'application/json' }, body: '{broken' })
    assert.equal(malformedConsent.status, 503); assert.deepEqual(await malformedConsent.json(), { error: 'Unavailable' })
    const malformedAuth = await fetch(base + '/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })
    assert.equal(malformedAuth.status, 400); assert.deepEqual(await malformedAuth.json(), { error: 'Invalid request' })
    const oversizedOwner = await call('/api/v2/gc/subcontractors', 'POST', await login('gc1@example.test'), { company_name: 'x'.repeat(66000), trade: 'T' })
    assert.equal(oversizedOwner.status, 413)
    const noLimiter = await start(createSecureV2SyntheticTestApp({ pool, authConfig: config }))
    assert.equal((await fetch(noLimiter + '/api/v2/auth/login', { method: 'POST' })).status, 503)
    // Prepopulated foreign request identities cannot bypass the boundary.
    const poisoned = express()
    poisoned.use((req: any, _res, next) => { req.securePrincipal = { subject: 'sub1', role: 'sub', credential: 'forged' }; next() })
    poisoned.use(createSecureV2SyntheticTestApp(options))
    const poisonBase = await start(poisoned)
    assert.equal((await fetch(poisonBase + file, { headers: { authorization: `Bearer ${sub2}` } })).status, 401)
    // A second invocation re-verifies the real JWT/session and retains an immutable identity.
    const verifier = createV2Auth(pool, config).requireAuth
    const adapter = createVerifiedPrincipalAdapter(verifier)
    const probe = express()
    probe.use(adapter, adapter, (req: any, res) => {
      const p = req.securePrincipal, d = Object.getOwnPropertyDescriptor(req, 'securePrincipal')!
      assert.equal(Object.isFrozen(p), true); assert.equal(d.configurable, false); assert.equal(d.writable, false)
      assert.throws(() => { req.securePrincipal = { subject: 'gc1' } })
      assert.equal(req.securePrincipal.subject, 'gc2'); res.json({ ok: true })
    })
    const probeBase = await start(probe)
    assert.equal((await fetch(probeBase, { headers: { authorization: `Bearer ${gc2}` } })).status, 200)
    const fresh = await login('gc2@example.test')
    const repeated = express()
    repeated.use(adapter, (_req, _res, next) => {
      void pool!.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [createHash('sha256').update(fresh).digest()]).then(() => next(), next)
    }, adapter, (_req, res) => { res.status(200).end() })
    const repeatBase = await start(repeated)
    const revokedBetweenChecks = await fetch(repeatBase, { headers: { authorization: `Bearer ${fresh}` } })
    assert.equal(revokedBetweenChecks.status, 401); assert.deepEqual(await revokedBetweenChecks.json(), { error: 'Authentication required' })
  } finally {
    await Promise.all(servers.map(s => { s.closeAllConnections(); return new Promise<void>(resolve => s.close(() => resolve())) }))
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  }
})
