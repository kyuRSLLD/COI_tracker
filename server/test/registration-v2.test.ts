import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import express from 'express'
import pg from 'pg'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migrateRegistrationV2V1 } from '../src/db/migrations/004_registration_v2.ts'
import { createV2Auth } from '../src/v2/auth.ts'
import { createV2Registration } from '../src/v2/registration.ts'
import type { RegistrationDelivery, RegistrationRateLimiter } from '../src/v2/registration.ts'
import { gcSubConsentService, CONSENT_V1, UnavailableError } from '../src/services/gcSubConsent.ts'

const url = process.env.REGISTRATION_TEST_PG_URL
if (!url) throw new Error('REGISTRATION_TEST_PG_URL is required: disposable loopback PostgreSQL 16 database only')
const u = new URL(url)
if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !/^\/registration_test_[a-z0-9_]+$/.test(u.pathname) || u.searchParams.has('host')) throw new Error('Refusing non-disposable/non-loopback database')
const digest = (v: string) => createHash('sha256').update(v).digest()
const pw = 'a long unique password 917!'
const contact = { first_name: ' Example ', last_name: ' Owner ', phone: '+1 (202) 555-0123' }
const subFields = { role: 'sub', password: pw, ...contact, company_name: 'Matching Legacy Inc', trade: 'electrical' }
const gcFields = { role: 'gc', password: pw, ...contact }

test('disconnected registration on PostgreSQL 16: verification, isolation, failures and races', async () => {
  const schema = `registration_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS v")
    assert.ok(version.rows[0].v >= 160000 && version.rows[0].v < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 20 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,first_name TEXT,last_name TEXT,phone TEXT,company_name TEXT,role TEXT,subcontractor_id TEXT,created_at TEXT NOT NULL);
      CREATE TABLE user_phones(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,phone TEXT NOT NULL,label TEXT DEFAULT 'mobile',is_primary INTEGER DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,user_id TEXT,company_name TEXT NOT NULL,trade TEXT NOT NULL,contact_person TEXT,phone TEXT,email TEXT,address TEXT,notes TEXT,status TEXT DEFAULT 'pending_review',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT);
      INSERT INTO users VALUES('legacy','Legacy@Example.test','legacy-hash','legacy',NULL,NULL,NULL,NULL,'gc',NULL,'now');
      INSERT INTO subcontractors(id,company_name,trade,email,created_at,updated_at) VALUES('old-sub','Matching Legacy Inc','electrical','newsub@example.test','now','now')`)
    const c = await pool.connect()
    try {
      assert.equal(await migrateGcSubConsentV1(c), 'applied')
      assert.equal(await migrateAuthV2V1(c), 'applied')
      // Dirty normalized legacy duplicates fail migration atomically; no claims/backfill.
      await c.query("INSERT INTO users VALUES('legacy-duplicate','LEGACY@example.test','legacy-hash','legacy',NULL,NULL,NULL,NULL,'gc',NULL,'now')")
      await assert.rejects(migrateRegistrationV2V1(c))
      assert.equal((await c.query("SELECT to_regclass('registration_v2_schema_migrations') AS ledger")).rows[0].ledger, null)
      await c.query("DELETE FROM users WHERE id='legacy-duplicate'")
      await c.query("INSERT INTO users VALUES('legacy-dirty',' legacy@example.test ','legacy-hash','legacy',NULL,NULL,NULL,NULL,'gc',NULL,'now')")
      await assert.rejects(migrateRegistrationV2V1(c))
      await c.query("DELETE FROM users WHERE id='legacy-dirty'")
      assert.equal(await migrateRegistrationV2V1(c), 'applied')
      assert.equal(await migrateRegistrationV2V1(c), 'already-applied')
      await assert.rejects(c.query("INSERT INTO users VALUES('legacy-duplicate','LEGACY@example.test','x','x',NULL,NULL,NULL,NULL,'gc',NULL,'now')"), /unique/)
      await assert.rejects(c.query("INSERT INTO users VALUES('legacy-dirty',' legacy@example.test ','x','x',NULL,NULL,NULL,NULL,'gc',NULL,'now')"), /check constraint/)
    } finally { c.release() }
    const messages: { email: string; token: string; expiresInSeconds: number }[] = []
    let failDelivery = false, allow = true, attemptedDuringDelivery = false
    let base = ''
    const delivery: RegistrationDelivery = { async sendVerification(message) {
      messages.push(message)
      if (message.email === 'during@example.test') {
        const r = await fetch(`${base}/reg/register/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: message.token, ...gcFields }) })
        assert.equal(r.status, 200); attemptedDuringDelivery = true
        assert.equal((await pool!.query("SELECT count(*)::int AS n FROM users WHERE email='during@example.test'")).rows[0].n, 0)
      }
      if (failDelivery) throw new Error('provider failure with sensitive details')
    } }
    const limiter: RegistrationRateLimiter = { async allow() { return allow } }
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const auth = createV2Auth(pool, { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'test', audience: 'test' })
    const app = express(); app.use('/reg', createV2Registration(pool, { delivery, rateLimiter: limiter })); app.use('/disabled', createV2Registration(pool)); app.use('/no-delivery', createV2Registration(pool, { rateLimiter: limiter })); app.use('/no-limiter', createV2Registration(pool, { delivery })); app.use('/auth', auth.router)
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    assert.ok(server)
    const addr = server.address(); assert.ok(addr && typeof addr !== 'string'); base = `http://127.0.0.1:${addr.port}`
    const post = async (path: string, body: object) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') } }
    const request = async (email: string) => { const before = messages.length; const r = await post('/reg/register/request', { email }); assert.equal(r.status, 202); assert.equal(r.cache, 'no-store'); assert.equal(messages.length, before + 1); assert.deepEqual(Object.keys(r.body), ['message']); return messages.at(-1)!.token }
    const confirm = (token: string, fields: object = subFields) => post('/reg/register/confirm', { token, ...fields })
    for (const p of ['/disabled', '/no-delivery', '/no-limiter']) assert.equal((await post(`${p}/register/request`, { email: 'x@example.test' })).status, 503)
    allow = false; assert.equal((await post('/reg/register/request', { email: 'x@example.test' })).status, 503); allow = true
    assert.equal((await post('/reg/register/request', { email: 'x@example.test', delivery: 'fake', token: 'spoof' })).status, 400)
    assert.equal((await post('/reg/register/request', { email: 'x@example.test', password: pw })).status, 400)
    assert.equal((await post('/reg/register/request', { email: 'x@example.test', ...contact })).status, 400)
    assert.equal(messages.length, 0)
    // A sender cannot supply a password or target a preexisting source record at request time.
    const token = await request(' NewSub@Example.test ')
    assert.equal(token.length, 43)
    const stored = await pool.query('SELECT * FROM auth_v2_registration_challenges WHERE token_hash=$1', [digest(token)])
    assert.equal(stored.rowCount, 1); assert.equal(stored.rows[0].token_hash.equals(digest(token)), true)
    assert.equal(JSON.stringify(stored.rows).includes(token), false)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE lower(email)='newsub@example.test'")).rows[0].n, 0)
    assert.equal((await post('/auth/login', { email: 'newsub@example.test', password: pw })).status, 401)
    assert.equal((await post('/reg/register/confirm', { token, ...subFields, subcontractor_id: 'old-sub' })).status, 400)
    assert.equal((await post('/reg/register/confirm', { token, ...subFields, role: 'admin' })).status, 400)
    assert.equal((await post('/reg/register/confirm', { token, ...subFields, name: 'Impersonated Name' })).status, 400)
    for (const fields of [
      { first_name: undefined }, { last_name: undefined }, { phone: undefined },
      { first_name: '' }, { last_name: '  ' }, { first_name: 'x'.repeat(101) }, { last_name: 'x'.repeat(101) },
      { first_name: 'A\u0000B' }, { last_name: '\ud800' }, { first_name: 42 },
      { phone: '' }, { phone: 2025550123 }, { phone: '202555012' }, { phone: '20255501234' },
      { phone: '+120255501234' }, { phone: '2025550123 ext 42' }, { phone: '2025550123#42' },
      { phone: '2025550123\n' }, { phone: '2025550123' + ' '.repeat(33) }, { phone: '++12025550123' },
      { phone: '+44 20 7946 0958' }, { phone: '4165550123' }, { phone: '0125550123' },
      { phone: '2021550123' }, { phone: '2025550123garbage' }, { phone: '２０２５５５０１２３' },
    ]) {
      assert.equal((await confirm(token, { ...subFields, ...fields })).status, 400, JSON.stringify(fields))
    }
    assert.equal((await pool.query('SELECT used_at FROM auth_v2_registration_challenges WHERE token_hash=$1', [digest(token)])).rows[0].used_at, null)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='newsub@example.test'")).rows[0].n, 0)
    allow = false; assert.equal((await confirm(token)).status, 503); allow = true
    const completed = await confirm(token); assert.equal(completed.status, 200)
    const identity = await pool.query(`SELECT u.id,u.subcontractor_id,u.name,u.first_name,u.last_name,u.phone,u.password_hash AS legacy_hash,a.password_hash,a.email_verified_at,a.verification_reference,
      s.user_id,s.company_name,s.contact_person,p.id AS profile_id,p.sub_user_id,p.subcontractor_id AS profile_sub,p.verification_reference AS profile_ref
      FROM users u JOIN auth_v2_accounts a ON a.user_id=u.id JOIN subcontractors s ON s.id=u.subcontractor_id JOIN auth_v2_sub_profiles p ON p.subcontractor_id=s.id WHERE u.email='newsub@example.test'`)
    assert.equal(identity.rowCount, 1)
    const i = identity.rows[0]; assert.notEqual(i.subcontractor_id, 'old-sub'); assert.equal(i.user_id, i.id); assert.equal(i.sub_user_id, i.id); assert.equal(i.profile_sub, i.subcontractor_id); assert.match(i.password_hash, /^scrypt-v1\$/); assert.equal(i.legacy_hash, '!v2-only!'); assert.match(i.profile_ref, /^email-control-only:/); assert.equal(i.profile_ref, i.verification_reference); assert.ok(i.email_verified_at)
    assert.deepEqual([i.first_name, i.last_name, i.name, i.phone, i.contact_person], ['Example', 'Owner', 'Example Owner', '(202) 555-0123', 'Example Owner'])
    assert.deepEqual((await pool.query('SELECT phone,label,is_primary FROM user_phones WHERE user_id=$1', [i.id])).rows, [{ phone: '(202) 555-0123', label: 'mobile', is_primary: 1 }])
    assert.equal((await pool.query('SELECT count(*)::int n FROM gc_sub_profiles')).rows[0].n, 0)
    await assert.rejects(pool.query('UPDATE auth_v2_sub_profiles SET sub_user_id=$1 WHERE id=$2', ['legacy', i.profile_id]), /immutable/)
    assert.equal((await pool.query('SELECT count(*)::int n FROM gc_sub_coi_ownership')).rows[0].n, 0)
    const login = await post('/auth/login', { email: 'newsub@example.test', password: pw }); assert.equal(login.status, 200); assert.ok(login.body.token)
    const me = await fetch(base + '/auth/me', { headers: { authorization: `Bearer ${login.body.token}` } }); assert.equal(me.status, 200); assert.deepEqual(await me.json(), { subject: i.id, role: 'sub' })
    const otherToken = await request('other-sub@example.test'); await confirm(otherToken)
    const otherLogin = await post('/auth/login', { email: 'other-sub@example.test', password: pw }); assert.equal(otherLogin.status, 200)
    const service = gcSubConsentService(pool, { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'test', audience: 'test' })
    await assert.rejects(service.issueSubQr(otherLogin.body.token, i.profile_id, CONSENT_V1), UnavailableError)
    await assert.rejects(service.issueSubQr(login.body.token, i.profile_id, CONSENT_V1), UnavailableError)
    const replay = await confirm(token); assert.equal(replay.status, 200); assert.deepEqual(replay.body, completed.body)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='newsub@example.test'")).rows[0].n, 1)
    const gt = await request('gc@example.test'); await confirm(gt, gcFields)
    assert.equal((await pool.query("SELECT count(*)::int n FROM auth_v2_sub_profiles p JOIN users u ON u.id=p.sub_user_id WHERE u.email='gc@example.test'")).rows[0].n, 0)
    assert.deepEqual((await pool.query("SELECT u.first_name,u.last_name,u.name,u.phone,p.phone AS primary_phone,p.is_primary FROM users u JOIN user_phones p ON p.user_id=u.id WHERE u.email='gc@example.test'")).rows, [{ first_name: 'Example', last_name: 'Owner', name: 'Example Owner', phone: '(202) 555-0123', primary_phone: '(202) 555-0123', is_primary: 1 }])
    assert.equal((await post('/auth/login', { email: 'gc@example.test', password: pw })).status, 200)
    for (const [idx, phone] of ['2025550123', '1-202-555-0123', '(202) 555-0123', '202.555.0123', '+12025550123'].entries()) {
      const email = `format${idx}@example.test`, t = await request(email)
      const fields = { ...gcFields, first_name: 'Élodie', last_name: 'x'.repeat(100), phone }
      assert.equal((await confirm(t, fields)).status, 200)
      const rows = await pool.query('SELECT u.first_name,u.last_name,u.name,u.phone,p.phone AS primary_phone FROM users u JOIN user_phones p ON p.user_id=u.id WHERE u.email=$1', [email])
      assert.deepEqual(rows.rows, [{ first_name: 'Élodie', last_name: 'x'.repeat(100), name: `Élodie ${'x'.repeat(100)}`, phone: '(202) 555-0123', primary_phone: '(202) 555-0123' }])
    }
    const legacy = await request('LEGACY@example.test'); const legacyResult = await confirm(legacy, subFields); assert.equal(legacyResult.status, 200); assert.deepEqual(legacyResult.body, completed.body)
    const duplicate = await request('newsub@example.test'); const duplicateResult = await confirm(duplicate, gcFields); assert.equal(duplicateResult.status, 200); assert.deepEqual(duplicateResult.body, completed.body)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE lower(btrim(email))='legacy@example.test'")).rows[0].n, 1)
    assert.equal((await pool.query("SELECT count(*)::int n FROM auth_v2_accounts WHERE user_id='legacy'")).rows[0].n, 0)
    assert.deepEqual((await pool.query("SELECT name,first_name,last_name,phone FROM users WHERE id='legacy'")).rows[0], { name: 'legacy', first_name: null, last_name: null, phone: null })
    assert.equal((await pool.query("SELECT count(*)::int n FROM user_phones WHERE user_id='legacy'")).rows[0].n, 0)
    const expired = await request('expired@example.test')
    await pool.query("UPDATE auth_v2_registration_challenges SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1", [digest(expired)])
    const expiredResult = await confirm(expired); assert.equal(expiredResult.status, 200); assert.deepEqual(expiredResult.body, completed.body)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='expired@example.test'")).rows[0].n, 0)
    failDelivery = true; assert.equal((await post('/reg/register/request', { email: 'failure@example.test' })).status, 503); const failed = messages.at(-1)!.token; failDelivery = false
    assert.equal((await confirm(failed)).status, 200); assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='failure@example.test'")).rows[0].n, 0)
    const during = await request('during@example.test'); assert.ok(attemptedDuringDelivery); await confirm(during, gcFields)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='during@example.test'")).rows[0].n, 1)
    const race = await request('race@example.test'); const raceResults = await Promise.all(Array.from({ length: 5 }, () => confirm(race)))
    assert.ok(raceResults.every(r => r.status === 200 && r.body.message === raceResults[0].body.message))
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='race@example.test'")).rows[0].n, 1)
    const t1 = await request('two@example.test'), t2 = await request('TWO@example.test')
    const two = await Promise.all([confirm(t1), confirm(t2, gcFields)])
    assert.deepEqual(two.map(r => r.status), [200, 200]); assert.deepEqual(two[0].body, two[1].body)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='two@example.test'")).rows[0].n, 1)
    const legacyRace = await request('legacy-race@example.test')
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query("INSERT INTO users VALUES('legacy-race','LEGACY-RACE@example.test','legacy-hash','legacy',NULL,NULL,NULL,NULL,'gc',NULL,'now')")
      const simultaneous = confirm(legacyRace)
      await new Promise(resolve => setTimeout(resolve, 200))
      await writer.query('COMMIT')
      assert.equal((await simultaneous).status, 200)
    } finally { await writer.query('ROLLBACK'); writer.release() }
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE lower(email COLLATE \"C\")='legacy-race@example.test'")).rows[0].n, 1)
    assert.equal((await pool.query("SELECT count(*)::int n FROM auth_v2_accounts WHERE login_email='legacy-race@example.test'")).rows[0].n, 0)
    const bad = await request('rollback@example.test')
    await pool.query(`CREATE FUNCTION test_fail_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'failure'; END $$; CREATE TRIGGER test_fail BEFORE INSERT ON auth_v2_sub_profiles FOR EACH ROW EXECUTE FUNCTION test_fail_profile()`)
    assert.equal((await confirm(bad)).status, 503)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='rollback@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query("SELECT count(*)::int n FROM auth_v2_accounts WHERE login_email='rollback@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query("SELECT count(*)::int n FROM subcontractors WHERE email='rollback@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM user_phones p LEFT JOIN users u ON u.id=p.user_id WHERE u.id IS NULL')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT used_at FROM auth_v2_registration_challenges WHERE token_hash=$1', [digest(bad)])).rows[0].used_at, null)
    await pool.query('DROP TRIGGER test_fail ON auth_v2_sub_profiles; DROP FUNCTION test_fail_profile()')
    assert.equal((await confirm(bad)).status, 200)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='rollback@example.test'")).rows[0].n, 1)
    const noPhoneTable = await request('schema-drift@example.test')
    await pool.query('ALTER TABLE user_phones RENAME TO temporarily_missing_user_phones')
    assert.equal((await confirm(noPhoneTable, gcFields)).status, 503)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='schema-drift@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query("SELECT count(*)::int n FROM auth_v2_accounts WHERE login_email='schema-drift@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query('SELECT used_at FROM auth_v2_registration_challenges WHERE token_hash=$1', [digest(noPhoneTable)])).rows[0].used_at, null)
    await pool.query('ALTER TABLE temporarily_missing_user_phones RENAME TO user_phones')
    assert.equal((await confirm(noPhoneTable, gcFields)).status, 200)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users u JOIN user_phones p ON p.user_id=u.id WHERE u.email='schema-drift@example.test'")).rows[0].n, 1)
    const phoneFailure = await request('phone-unique-failure@example.test')
    await pool.query(`CREATE FUNCTION test_fail_phone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE unique_violation USING CONSTRAINT = 'test_phone_unique'; END $$; CREATE TRIGGER test_fail_phone AFTER INSERT ON user_phones FOR EACH ROW EXECUTE FUNCTION test_fail_phone()`)
    assert.equal((await confirm(phoneFailure, gcFields)).status, 503)
    assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE email='phone-unique-failure@example.test'")).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM user_phones p LEFT JOIN users u ON u.id=p.user_id WHERE u.id IS NULL')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT used_at FROM auth_v2_registration_challenges WHERE token_hash=$1', [digest(phoneFailure)])).rows[0].used_at, null)
    await pool.query('DROP TRIGGER test_fail_phone ON user_phones; DROP FUNCTION test_fail_phone()')
    assert.equal((await confirm(phoneFailure, gcFields)).status, 200)
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()))
    if (pool) await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end()
  }
})
