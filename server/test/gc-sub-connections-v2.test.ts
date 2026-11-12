import { migrateFreshFixture, addFreshFixtureEvidence } from './fresh-profile-fixture.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { RequestHandler } from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { createVerifiedPrincipalAdapter } from '../src/secure-v2-synthetic.ts'
import { gcSubConsentService, CONSENT_V2, QR_CONSENT_V2_TEXT, INVITE_CONSENT_V2_TEXT } from '../src/services/gcSubConsent.ts'
import { createGcSubConnectionsV2Router } from '../src/routes/gcSubConnectionsV2.ts'

const url = process.env.GC_SUB_TEST_PG_URL
if (!url) throw new Error('GC_SUB_TEST_PG_URL is required: use a disposable local PostgreSQL 16 database')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/gc_sub_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.searchParams.has('host')) throw new Error('Tests require an explicit loopback gc_sub_test_* PostgreSQL database')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'router-test', audience: 'router-client' }
const password = 'synthetic router password 123'
const credential = (sub: string, role: string, options: jwt.SignOptions = {}) => jwt.sign({ sub, role }, privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, expiresIn: '5m', ...options })

test('disconnected HTTP router: synthetic PostgreSQL consent, isolation and fail-closed controls', async () => {
  const schema = `gc_sub_test_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined
  const servers: Array<ReturnType<express.Express['listen']>> = []
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS version")
    assert.ok(version.rows[0].version >= 160000 && version.rows[0].version < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,name TEXT,password_hash TEXT);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,company_name TEXT NOT NULL,trade TEXT NOT NULL,status TEXT,contact_person TEXT,phone TEXT,email TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,certificate_key TEXT,certificate_url TEXT)`)
    const c = await pool.connect()
    try { await migrateGcSubConsentV1(c); await migrateAuthV2V1(c); await migrateFreshFixture(c) } finally { c.release() }
    await pool.query(`INSERT INTO users(id,role,name) VALUES ('gc1','gc','Same'),('gc2','gc','Same'),('sub1','sub','Same'),('sub2','sub','Same'),('client','admin','Client');
      INSERT INTO subcontractors VALUES ('s1','Same','Trade','active','secret','secret','secret'),('s2','Same','Trade','active','secret','secret','secret');
      INSERT INTO cois VALUES ('c1','s1','Carrier','2020','2030','active','secret-key','https://private'),('unmapped','s1','Carrier','2020','2030','active','secret-key','https://private'),('c2','s2','Carrier','2020','2030','active','secret-key','https://private')`)
    const passhash = await hashV2Password(password)
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) SELECT id,id||'@example.test',$1,clock_timestamp(),'synthetic',true FROM users`, [passhash])
    const p1 = randomUUID(), p2 = randomUUID(), nonexistent = randomUUID()
    await pool.query("INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference) VALUES($1,'s1','sub1',now(),'email-control-only:test-1'),($2,'s2','sub2',now(),'email-control-only:test-2')", [p1, p2])
    await addFreshFixtureEvidence(pool, p1); await addFreshFixtureEvidence(pool, p2)
    await pool.query("INSERT INTO gc_sub_coi_ownership VALUES('c1',$1,'s1',now(),'verified'),('c2',$2,'s2',now(),'verified')", [p1, p2])
    const service = gcSubConsentService(pool, config)
    const authV2 = createV2Auth(pool, config)
    const auth = createVerifiedPrincipalAdapter(authV2.requireAuth)
    let limit: 'allow' | 'deny-preauth' | 'deny-principal' | 'error-preauth' | 'error-principal' | 'hang-preauth' = 'allow'
    let policy: 'normal' | 'error' = 'normal'
    const phases: string[] = []
    const router = createGcSubConnectionsV2Router({ service, authenticate: auth,
      checkRateLimit: async input => {
        phases.push(input.phase)
        assert.ok(input.remoteAddress)
        assert.deepEqual(Object.keys(input).sort(), input.phase === 'principal' ? ['phase','remoteAddress','subject'] : ['phase','remoteAddress'])
        if (limit === `error-${input.phase}`) throw new Error('do not disclose rate backend')
        if (limit === `hang-${input.phase}`) return new Promise<boolean>(() => {})
        return limit !== `deny-${input.phase}`
      },
      authorizeInviteRecipient: async ({ gcSubject, profileId }) => {
        if (policy === 'error') throw new Error('do not disclose policy backend')
        return gcSubject === 'gc2' && profileId === p1
      },
    })
    const start = async (r: express.Router) => {
      const app = express(); app.use('/api/v2/auth', authV2.router); app.use('/api/v2/connections', r)
      const server = app.listen(0, '127.0.0.1'); servers.push(server)
      await new Promise<void>(resolve => server.once('listening', resolve))
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/connections`
    }
    const base = await start(router)
    const login = async (id: string) => {
      const response = await fetch(base.replace('/connections', '/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${id}@example.test`, password }) })
      assert.equal(response.status, 200); return (await response.json()).token as string
    }
    const gc1 = await login('gc1'), sub1 = await login('sub1'), sub2 = await login('sub2')
    let gc2 = await login('gc2')
    const client = await login('client')
    const call = async (path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      assert.match(res.headers.get('cache-control') || '', /no-store/)
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
      const text = await res.text()
      return { status: res.status, body: text ? JSON.parse(text) : null, text }
    }
    assert.deepEqual((await call('/general-contractors', sub1)).body, { generalContractors: [] })
    assert.deepEqual((await call('/general-contractors', sub2)).body, { generalContractors: [] })
    assert.equal((await call('/general-contractors', gc1)).status, 404)
    assert.notEqual((await call('/general-contractors', client)).status, 200)
    assert.notEqual((await call('/revoke', client, { profileId: p1, gcUserId: 'gc1' })).status, 204)
    assert.equal((await call('/general-contractors?profileId=' + p1, sub2)).status, 404)
    assert.equal((await fetch(base + '/general-contractors')).status, 401)
    const disclosure = await call('/consent', sub1)
    assert.deepEqual(disclosure.body, { version: CONSENT_V2, qrText: QR_CONSENT_V2_TEXT, invitationText: INVITE_CONSENT_V2_TEXT })
    assert.equal((await call('/qr', sub1, { profileId: p1, consentVersion: CONSENT_V2, affirmative: false })).status, 404)
    assert.equal((await call('/qr', sub1, { profileId: p1, consentVersion: 'wrong', affirmative: true })).status, 404)
    const unauthorized = await call('/qr', sub2, { profileId: p1, consentVersion: CONSENT_V2, affirmative: true })
    assert.equal(unauthorized.status, 404); assert.equal(unauthorized.text.includes(p1), false)
    const issued = await call('/qr', sub1, { profileId: p1, consentVersion: CONSENT_V2, affirmative: true })
    assert.equal(issued.status, 200); assert.match(issued.body.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await call('/qr/redeem', sub2, { token: issued.body.token })).status, 404)
    assert.equal((await call('/qr/redeem', gc1, { token: issued.body.token })).status, 204)
    assert.equal((await call('/qr/redeem', gc2, { token: issued.body.token })).status, 404)
    const discovered = await call('/general-contractors', sub1)
    assert.deepEqual(discovered.body, { generalContractors: [{ gc_user_id: 'gc1', gc_name: 'Same' }] })
    assert.ok(!/secret|private|example.test|carrier/i.test(discovered.text))
    assert.deepEqual((await call('/general-contractors', sub2)).body, { generalContractors: [] })
    assert.deepEqual((await call('/subcontractors', gc1)).body.subcontractors.map((x: any) => x.profile_id), [p1])
    assert.deepEqual((await call('/subcontractors', gc2)).body.subcontractors, [])
    assert.deepEqual((await call('/cois', gc2, { profileId: p1 })).body.cois, [])
    const cois = (await call('/cois', gc1, { profileId: p1 })).body.cois
    assert.deepEqual(cois, [])
    assert.ok(!JSON.stringify(cois).includes('secret')); assert.ok(!JSON.stringify(cois).includes('private'))
    assert.deepEqual((await call('/cois', gc1, { profileId: p2 })).body.cois, [])
    // Arbitrary/guessed UUIDs give no discovery oracle when policy denies both.
    const denied = await call('/invitations', gc1, { profileId: p1 })
    const unknown = await call('/invitations', gc1, { profileId: nonexistent })
    assert.equal(denied.status, 404); assert.deepEqual(denied, unknown); assert.equal(denied.text.includes(p1), false)
    assert.equal((await call('/invitations', gc2, { profileId: p2 })).status, 404)
    const invitation = await call('/invitations', gc2, { profileId: p1 })
    assert.equal(invitation.status, 200)
    assert.equal((await call('/invitations/preview', sub2, { token: invitation.body.token })).status, 404)
    const preview = await call('/invitations/preview', sub1, { token: invitation.body.token })
    assert.equal(preview.status, 200); assert.equal(preview.body.invitation.gc_user_id, 'gc2')
    assert.deepEqual(preview.body.consent, { version: CONSENT_V2, text: INVITE_CONSENT_V2_TEXT })
    assert.equal((await call('/invitations/accept', sub1, { token: invitation.body.token, consentVersion: CONSENT_V2, affirmative: false })).status, 404)
    assert.equal((await call('/invitations/accept', sub2, { token: invitation.body.token, consentVersion: CONSENT_V2, affirmative: true })).status, 404)
    assert.equal((await call('/invitations/accept', sub1, { token: invitation.body.token, consentVersion: CONSENT_V2, affirmative: true })).status, 204)
    assert.equal((await call('/invitations/accept', sub1, { token: invitation.body.token, consentVersion: CONSENT_V2, affirmative: true })).status, 404)
    assert.deepEqual((await call('/cois', gc2, { profileId: p1 })).body.cois.map((x: any) => x.id), [])
    const qr2 = await call('/qr', sub2, { profileId: p2, consentVersion: CONSENT_V2, affirmative: true })
    assert.equal((await call('/qr/redeem', gc2, { token: qr2.body.token })).status, 204)
    assert.deepEqual((await call('/cois', gc2, { profileId: p2 })).body.cois.map((x: any) => x.id), [])
    await pool.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc2'")
    assert.deepEqual((await call('/general-contractors', sub1)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc1'])
    assert.deepEqual((await call('/general-contractors', sub2)).body.generalContractors, [])
    await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc2'")
    gc2 = await login('gc2')
    assert.deepEqual((await call('/general-contractors', sub1)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc1', 'gc2'])
    assert.deepEqual((await call('/general-contractors', sub2)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc2'])
    // Bounded discovery must fail rather than silently conceal additional active recipients.
    await pool.query(`INSERT INTO users(id,role,name) SELECT 'extra-'||n,'gc',NULL FROM generate_series(1,499) n;
      INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) SELECT id,id||'@example.test','unused',now(),'synthetic',true FROM users WHERE id LIKE 'extra-%'`)
    await pool.query(`INSERT INTO gc_sub_grants(profile_id,gc_user_id,consent_version,consented_at,granted_at) SELECT $1,id,$2,now(),now() FROM users WHERE id LIKE 'extra-%'`, [p1, CONSENT_V2])
    const overLimit = await call('/general-contractors', sub1)
    assert.equal(overLimit.status, 503); assert.deepEqual(overLimit.body, { error: 'Unavailable' })
    await pool.query("DELETE FROM gc_sub_grants WHERE gc_user_id LIKE 'extra-%'; DELETE FROM auth_v2_accounts WHERE user_id LIKE 'extra-%'; DELETE FROM users WHERE id LIKE 'extra-%'")
    // A failed event insert must roll back both grant revocation and QR invalidation.
    const rollbackQr = await call('/qr', sub1, { profileId: p1, consentVersion: CONSENT_V2, affirmative: true })
    await pool.query(`CREATE FUNCTION fail_revoke_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='revoked' THEN RAISE EXCEPTION 'private failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_revoke_event BEFORE INSERT ON gc_sub_grant_events FOR EACH ROW EXECUTE FUNCTION fail_revoke_event()`)
    const failed = await call('/revoke', sub1, { profileId: p1, gcUserId: 'gc1' })
    assert.equal(failed.status, 503); assert.deepEqual(failed.body, { error: 'Unavailable' })
    assert.deepEqual((await call('/general-contractors', sub1)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc1', 'gc2'])
    await pool.query('DROP TRIGGER fail_revoke_event ON gc_sub_grant_events')
    assert.equal((await call('/qr/redeem', gc1, { token: rollbackQr.body.token })).status, 204)
    const before = (await pool.query('SELECT * FROM cois ORDER BY id')).rows
    const staleQr = await call('/qr', sub1, { profileId: p1, consentVersion: CONSENT_V2, affirmative: true })
    const staleInvite = await call('/invitations', gc2, { profileId: p1 })
    assert.equal((await call('/revoke', sub2, { profileId: p1, gcUserId: 'gc1' })).status, 404)
    assert.deepEqual((await call('/general-contractors', sub1)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc1', 'gc2'])
    assert.equal((await call('/revoke', sub1, { profileId: p1, gcUserId: 'gc1' })).status, 204)
    assert.deepEqual((await call('/general-contractors', sub1)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc2'])
    assert.deepEqual((await call('/general-contractors', sub2)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc2'])
    assert.equal((await call('/revoke', sub1, { profileId: p1, gcUserId: 'gc1' })).status, 204)
    assert.deepEqual((await call('/cois', gc1, { profileId: p1 })).body.cois, [])
    assert.deepEqual((await call('/subcontractors', gc1)).body.subcontractors, [])
    assert.deepEqual((await call('/cois', gc2, { profileId: p1 })).body.cois.map((x: any) => x.id), [])
    assert.equal((await call('/qr/redeem', gc1, { token: staleQr.body.token })).status, 404)
    assert.equal((await call('/revoke', sub1, { profileId: p1, gcUserId: 'gc2' })).status, 204)
    assert.equal((await call('/invitations/accept', sub1, { token: staleInvite.body.token, consentVersion: CONSENT_V2, affirmative: true })).status, 404)
    assert.deepEqual((await call('/general-contractors', sub1)).body, { generalContractors: [] })
    assert.deepEqual((await call('/general-contractors', sub2)).body.generalContractors.map((x: any) => x.gc_user_id), ['gc2'])
    await pool.query('ALTER TABLE gc_sub_grants RENAME TO temporarily_unavailable_grants')
    const listFailure = await call('/general-contractors', sub1)
    assert.equal(listFailure.status, 503); assert.deepEqual(listFailure.body, { error: 'Unavailable' })
    await pool.query('ALTER TABLE temporarily_unavailable_grants RENAME TO gc_sub_grants')
    assert.deepEqual((await call('/cois', gc2, { profileId: p1 })).body.cois, [])
    assert.deepEqual((await pool.query('SELECT * FROM cois ORDER BY id')).rows, before)
    await pool.query("UPDATE users SET role='admin' WHERE id='gc2'")
    assert.deepEqual((await call('/general-contractors', sub2)).body.generalContractors, [])
    assert.equal((await call('/subcontractors', gc2)).status, 401)
    await pool.query("UPDATE users SET role='gc' WHERE id='gc2'")
    assert.equal((await call('/subcontractors', gc2)).status, 401)
    gc2 = await login('gc2')
    assert.deepEqual((await call('/subcontractors', gc2)).body.subcontractors, [])
    assert.equal((await call('/invitations/not-a-token-route', sub1)).status, 404)
    assert.equal((await call('/consent?unexpected=1', sub1)).status, 404)
    await pool.query('ALTER TABLE cois RENAME TO temporarily_unavailable_cois')
    const dbFailure = await call('/cois', gc1, { profileId: p1 })
    assert.equal(dbFailure.status, 200); assert.deepEqual(dbFailure.body, { cois: [] }) // no COI query under profile-only consent
    await pool.query('ALTER TABLE temporarily_unavailable_cois RENAME TO cois')
    for (const bad of [credential('gc1','gc', { issuer: 'wrong' }), credential('gc1','gc', { audience: 'wrong' }), credential('gc1','gc', { expiresIn: -1 }), jwt.sign({ sub: 'gc1', role: 'gc' }, 'bad', { algorithm: 'HS256', issuer: config.issuer, audience: config.audience, expiresIn: '5m' })]) {
      assert.equal((await call('/subcontractors', bad)).status, 401)
    }
    for (const phase of ['preauth', 'principal'] as const) {
      limit = `deny-${phase}`; assert.equal((await call('/subcontractors', gc1)).status, 429)
      limit = `error-${phase}`; const failure = await call('/subcontractors', gc1); assert.equal(failure.status, 503); assert.deepEqual(failure.body, { error: 'Unavailable' })
    }
    limit = 'hang-preauth'; assert.equal((await call('/subcontractors', gc1)).status, 503)
    assert.ok(phases.includes('preauth') && phases.includes('principal')); limit = 'allow'
    policy = 'error'; const failPolicy = await call('/invitations', gc2, { profileId: p1 }); assert.equal(failPolicy.status, 503); assert.deepEqual(failPolicy.body, { error: 'Unavailable' }); policy = 'normal'
    const malformed = await fetch(base + '/qr', { method: 'POST', headers: { authorization: `Bearer ${sub1}`, 'content-type': 'application/json' }, body: '{bad' })
    assert.equal(malformed.status, 503); assert.deepEqual(await malformed.json(), { error: 'Unavailable' }); assert.match(malformed.headers.get('cache-control') || '', /no-store/)
    const oversized = await call('/qr', sub1, { profileId: p1, consentVersion: 'x'.repeat(5000), affirmative: true })
    assert.equal(oversized.status, 503); assert.deepEqual(oversized.body, { error: 'Unavailable' })
    const throwingAuth: RequestHandler = () => { throw new Error('sensitive authentication error') }
    const throwingBase = await start(createGcSubConnectionsV2Router({ service, authenticate: throwingAuth, checkRateLimit: async () => true, authorizeInviteRecipient: async () => false }))
    const authFailure = await fetch(throwingBase + '/subcontractors')
    assert.equal(authFailure.status, 503); assert.deepEqual(await authFailure.json(), { error: 'Unavailable' }); assert.match(authFailure.headers.get('cache-control') || '', /no-store/)
    // Deliberately broken synthetic auth: the service must independently reject credentials.
    const fakeAuth: RequestHandler = (req, _res, next) => { (req as any).securePrincipal = { subject: 'gc1', role: 'gc', credential: req.headers.authorization?.slice(7) }; next() }
    const brokenBase = await start(createGcSubConnectionsV2Router({ service, authenticate: fakeAuth, checkRateLimit: async () => true, authorizeInviteRecipient: async () => false }))
    const invalid = ['not-a-jwt', credential('gc1','gc'), credential('gc1','gc', { issuer: 'wrong' }), credential('gc1','gc', { audience: 'wrong' }), credential('gc1','gc', { expiresIn: -1 }), jwt.sign({ sub: 'gc1' }, 'bad', { algorithm: 'HS256', issuer: config.issuer, audience: config.audience, expiresIn: '5m' }), jwt.sign({ sub: 'gc1' }, privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience })]
    for (const token of invalid) {
      const independent = await fetch(brokenBase + '/subcontractors', { headers: { authorization: `Bearer ${token}` } })
      assert.equal(independent.status, 404); assert.match(independent.headers.get('cache-control') || '', /no-store/)
      assert.deepEqual(await independent.json(), { error: 'Unavailable' })
    }
    assert.throws(() => createGcSubConnectionsV2Router({ service, authenticate: auth } as any), /required/)
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))))
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
