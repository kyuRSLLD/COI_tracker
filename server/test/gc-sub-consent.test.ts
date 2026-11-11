import { migrateFreshFixture, addFreshFixtureEvidence } from './fresh-profile-fixture.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, randomBytes, createHash } from 'node:crypto'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { postgresOwnerConnection } from '../src/db/ownerConnection.ts'
import { ownerReads } from '../src/services/ownerReads.ts'
import { gcSubConsentService, CONSENT_V2, UnavailableError } from '../src/services/gcSubConsent.ts'

const url = process.env.GC_SUB_TEST_PG_URL
if (!url) throw new Error('GC_SUB_TEST_PG_URL is required: supply a disposable local PostgreSQL 16 database')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/gc_sub_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.searchParams.has('host')) {
  throw new Error('Tests require an explicit loopback gc_sub_test_* PostgreSQL database')
}
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const auth = (sub: string, options: jwt.SignOptions = {}) => jwt.sign({ sub }, privateKey, { algorithm: 'RS256', issuer: 'test-issuer', audience: 'test-audience', expiresIn: '5m', jwtid: randomBytes(32).toString('base64url'), ...options })
const bad = (p: Promise<unknown>) => assert.rejects(p, UnavailableError)
const hash = (token: string) => createHash('sha256').update(token).digest()

test('PostgreSQL 16: consented relationships are isolated, live, revocable and race-safe', async () => {
  const schema = `gc_sub_test_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined
  try {
    const ver = await admin.query("SELECT current_setting('server_version_num')::int AS version")
    assert.ok(ver.rows[0].version >= 160000 && ver.rows[0].version < 170000, 'test on PostgreSQL 16')
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,email TEXT,name TEXT,password_hash TEXT);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,company_name TEXT NOT NULL,trade TEXT NOT NULL,status TEXT, contact_person TEXT, phone TEXT, email TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,certificate_key TEXT,certificate_url TEXT)`)
    await pool.query(`INSERT INTO users(id,role,email,name) VALUES
      ('gc1','gc','gc1@example.test','same'),('gc2','gc','gc2@example.test','same'),
      ('sub1','sub','sub1@example.test','same'),('sub2','sub','sub2@example.test','same'),('admin','admin','admin@example.test','same')`)
    await pool.query("INSERT INTO subcontractors(id,company_name,trade,status) VALUES('s1','same','trade','active'),('s2','same','trade','active'),('legacy','same','trade','active')")
    await pool.query(`INSERT INTO cois VALUES
      ('c1','s1','carrier','2020','2030','active','private','https://private'),
      ('other-owner','s1','carrier','2020','2030','active','private','https://private'),
      ('c2','s2','carrier','2020','2030','active','private','https://private'),
      ('legacy','legacy','carrier','2020','2030','active','private','https://private')`)
    const client = await pool.connect()
    try {
      assert.equal(await migrateOwnerFoundationV1(postgresOwnerConnection(client)), 'applied')
      // A conflicting object half-way through DDL must leave no partial schema or ledger.
      await client.query('CREATE TABLE gc_sub_grants(dummy integer)')
      await assert.rejects(migrateGcSubConsentV1(client))
      const rollback = await client.query("SELECT to_regclass('gc_sub_profiles') AS profile, to_regclass('gc_sub_schema_migrations') AS ledger, to_regclass('gc_sub_cois_id_sub_uq') AS idx")
      assert.deepEqual(rollback.rows[0], { profile: null, ledger: null, idx: null })
      await client.query('DROP TABLE gc_sub_grants')
      assert.equal(await migrateGcSubConsentV1(client), 'applied')
      assert.equal(await migrateGcSubConsentV1(client), 'already-applied')
      assert.equal(await migrateAuthV2V1(client), 'applied')
      await migrateFreshFixture(client)
    } finally { client.release() }
    await pool.query("INSERT INTO owner_subcontractor_connections VALUES('s1','gc1','now')")
    await pool.query("INSERT INTO owner_coi_records VALUES('other-owner','s1','gc1','now')")
    const p1 = randomUUID(), p2 = randomUUID()
    await pool.query(`INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference)
      VALUES($1,'s1','sub1',clock_timestamp(),'email-control-only:test-1'),($2,'s2','sub2',clock_timestamp(),'email-control-only:test-2')`, [p1, p2])
    await addFreshFixtureEvidence(pool, p1); await addFreshFixtureEvidence(pool, p2)
    await pool.query(`INSERT INTO gc_sub_coi_ownership VALUES('c1',$1,'s1',clock_timestamp(),'review-c1'),('c2',$2,'s2',clock_timestamp(),'review-c2')`, [p1, p2])
    await assert.rejects(pool.query("UPDATE gc_sub_profiles SET sub_user_id='sub2' WHERE id=$1", [p1]), /immutable|conflicting profile identity/)
    await assert.rejects(pool.query("INSERT INTO gc_sub_coi_ownership VALUES('c2',$1,'s1',clock_timestamp(),'fake')", [p1]))
    const service = gcSubConsentService(pool, { publicKey: pub, issuer: 'test-issuer', audience: 'test-audience' })
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled)
      SELECT id,id || '@example.test','not-used',clock_timestamp(),'verified',true FROM users`)
    const mint = async (id: string) => {
      const token = auth(id)
      await pool!.query('INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,to_timestamp($3))', [hash(token), id, (jwt.decode(token) as jwt.JwtPayload).exp])
      return token
    }
    let gc1 = await mint('gc1'), gc2 = await mint('gc2'), sub1 = await mint('sub1')
    const sub2 = await mint('sub2'), adminToken = await mint('admin')
    await bad(service.issueSubQr(sub1, p1, false))
    await bad(service.issueSubQr(sub2, p1, CONSENT_V2))
    await bad(service.issueSubQr(adminToken, p1, CONSENT_V2))
    await bad(service.issueSubQr(auth('sub1', { issuer: 'wrong' }), p1, CONSENT_V2))
    await bad(service.issueSubQr(auth('sub1', { audience: 'wrong' }), p1, CONSENT_V2))
    await bad(service.issueSubQr(auth('sub1', { expiresIn: -1 }), p1, CONSENT_V2))
    await bad(service.listGrantedSubs(jwt.sign({ sub: 'gc1' }, 'bad-secret', { algorithm: 'HS256', issuer: 'test-issuer', audience: 'test-audience', expiresIn: '5m' })))
    await bad(service.listGrantedSubs(jwt.sign({ sub: 'gc1' }, privateKey, { algorithm: 'RS256', issuer: 'test-issuer', audience: 'test-audience' })))
    assert.deepEqual(await service.listGrantedSubs(gc1), [])
    const q1 = await service.issueSubQr(sub1, p1, CONSENT_V2)
    assert.equal(q1.token.length, 43)
    const stored = await pool.query('SELECT token_hash,consent_version FROM gc_sub_capabilities WHERE token_hash=$1', [hash(q1.token)])
    assert.equal(stored.rowCount, 1); assert.notEqual(stored.rows[0].token_hash.toString('hex'), q1.token)
    await bad(service.redeemSubQr(sub2, q1.token))
    await service.redeemSubQr(gc1, q1.token)
    await bad(service.redeemSubQr(gc2, q1.token))
    const ownerClient = await pool.connect()
    try {
      const owner = ownerReads(postgresOwnerConnection(ownerClient), 'gc1')
      assert.deepEqual((await owner.listCois('s1')).map(x => x.id), ['other-owner'])
      assert.deepEqual(await ownerReads(postgresOwnerConnection(ownerClient), 'gc2').listCois('s1'), [])
    } finally { ownerClient.release() }
    assert.deepEqual((await service.listGrantedSubs(gc1)).map(x => x.id), ['s1'])
    assert.deepEqual(await service.listGrantedSubs(gc2), [])
    assert.deepEqual((await service.listGrantedCois(gc1, p1)).map(x => x.id), [])
    assert.deepEqual(await service.listGrantedCois(gc1, p2), [])
    await pool.query("INSERT INTO cois VALUES('future','s1','future-carrier','2030','2040','active','private','https://private')")
    assert.deepEqual((await service.listGrantedCois(gc1, p1)).map(x => x.id), [])
    await pool.query("INSERT INTO gc_sub_coi_ownership VALUES('future',$1,'s1',clock_timestamp(),'new-sub-owned')", [p1])
    assert.deepEqual((await service.listGrantedCois(gc1, p1)).map(x => x.id), [])
    // Live roles, not token claims, control reads and writes.
    const gcStaleInvite = await service.createGcInvite(gc1, p1)
    await pool.query("UPDATE users SET role='sub' WHERE id='gc1'")
    await bad(service.listGrantedSubs(gc1))
    await bad(service.createGcInvite(gc1, p1))
    await pool.query("UPDATE users SET role='gc' WHERE id='gc1'")
    await bad(service.listGrantedSubs(gc1))
    gc1 = await mint('gc1')
    assert.deepEqual(await service.listGrantedSubs(gc1), [])
    await bad(service.acceptGcInvite(sub1, gcStaleInvite.token, CONSENT_V2))
    const newGrant = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await service.redeemSubQr(gc1, newGrant.token)
    const subStaleQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await pool.query("UPDATE users SET role='admin' WHERE id='sub1'")
    assert.deepEqual(await service.listGrantedCois(gc1, p1), [])
    await bad(service.issueSubQr(sub1, p1, CONSENT_V2))
    await pool.query("UPDATE users SET role='sub' WHERE id='sub1'")
    await bad(service.issueSubQr(sub1, p1, CONSENT_V2))
    sub1 = await mint('sub1')
    assert.deepEqual(await service.listGrantedSubs(gc1), [])
    await bad(service.redeemSubQr(gc1, subStaleQr.token))
    const newGrant2 = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await service.redeemSubQr(gc1, newGrant2.token)
    assert.ok(Number((await pool.query("SELECT count(*) FROM gc_sub_grant_events WHERE action='revoked_role'")).rows[0].count) >= 2)
    // Invitation is bound to a live GC and the explicitly verified profile owner.
    const invite = await service.createGcInvite(gc2, p1)
    assert.equal((await service.previewGcInvite(sub1, invite.token)).gc_user_id, 'gc2')
    await bad(service.previewGcInvite(sub2, invite.token))
    await bad(service.acceptGcInvite(sub2, invite.token, CONSENT_V2))
    await bad(service.acceptGcInvite(sub1, invite.token, 'yes'))
    await pool.query("UPDATE users SET role='admin' WHERE id='gc2'")
    await bad(service.acceptGcInvite(sub1, invite.token, CONSENT_V2))
    await pool.query("UPDATE users SET role='gc' WHERE id='gc2'")
    await bad(service.acceptGcInvite(sub1, invite.token, CONSENT_V2))
    await bad(service.createGcInvite(gc2, p1))
    gc2 = await mint('gc2')
    const invite2 = await service.createGcInvite(gc2, p1)
    await service.acceptGcInvite(sub1, invite2.token, CONSENT_V2)
    await bad(service.acceptGcInvite(sub1, invite2.token, CONSENT_V2))
    assert.deepEqual((await service.listGrantedCois(gc2, p1)).map(x => x.id), [])
    const q2 = await service.issueSubQr(sub2, p2, CONSENT_V2)
    await service.redeemSubQr(gc2, q2.token)
    assert.deepEqual((await service.listGrantedSubs(gc2)).map(x => x.id), ['s1', 's2'])
    assert.deepEqual((await service.listGrantedCois(gc2, p2)).map(x => x.id), [])
    assert.deepEqual(await service.listGrantedCois(gc1, p2), [])
    // Revoke does not delete or modify source COIs; stale QRs and matching invites die.
    const before = (await pool.query('SELECT * FROM cois ORDER BY id')).rows
    const staleQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    const staleInvite = await service.createGcInvite(gc1, p1)
    await bad(service.revoke(sub2, p1, 'gc1'))
    assert.equal(await service.revoke(sub1, p1, 'gc1'), true)
    assert.deepEqual(await service.listGrantedCois(gc1, p1), [])
    assert.deepEqual((await service.listGrantedCois(gc2, p1)).map(x => x.id), [])
    await bad(service.redeemSubQr(gc1, staleQr.token))
    await bad(service.acceptGcInvite(sub1, staleInvite.token, CONSENT_V2))
    assert.deepEqual((await pool.query('SELECT * FROM cois ORDER BY id')).rows, before)
    // Expiry is evaluated by the database at the consumption point.
    const expired = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await pool.query("UPDATE gc_sub_capabilities SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1", [hash(expired.token)])
    await bad(service.redeemSubQr(gc1, expired.token))
    const expiredInvite = await service.createGcInvite(gc1, p1)
    await pool.query("UPDATE gc_sub_capabilities SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE token_hash=$1", [hash(expiredInvite.token)])
    await bad(service.acceptGcInvite(sub1, expiredInvite.token, CONSENT_V2))
    // Independent DB sessions race for a one-use capability; exactly one wins.
    const raceQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    const race = await Promise.allSettled([service.redeemSubQr(gc1, raceQr.token), service.redeemSubQr(gc2, raceQr.token)])
    assert.equal(race.filter(x => x.status === 'fulfilled').length, 1)
    const raceInvite = await service.createGcInvite(gc1, p1)
    const race2 = await Promise.allSettled([service.acceptGcInvite(sub1, raceInvite.token, CONSENT_V2), service.acceptGcInvite(sub1, raceInvite.token, CONSENT_V2)])
    assert.equal(race2.filter(x => x.status === 'fulfilled').length, 1)
    // Fault-injection after consumption proves grant, event, and redemption roll back together.
    await service.revoke(sub1, p1, 'gc1')
    const rollbackQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await pool.query(`CREATE FUNCTION fail_gc_sub_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail_gc_sub_event BEFORE INSERT ON gc_sub_grant_events FOR EACH ROW EXECUTE FUNCTION fail_gc_sub_event()`)
    await assert.rejects(service.redeemSubQr(gc1, rollbackQr.token), /injected/)
    assert.equal((await pool.query('SELECT used_at FROM gc_sub_capabilities WHERE token_hash=$1', [hash(rollbackQr.token)])).rows[0].used_at, null)
    assert.deepEqual(await service.listGrantedCois(gc1, p1), [])
    await pool.query('DROP TRIGGER fail_gc_sub_event ON gc_sub_grant_events')
    await service.redeemSubQr(gc1, rollbackQr.token)
    const waitForBlocked = async (fragment: string, count: number) => {
      for (let i = 0; i < 150; i++) {
        const r = await pool!.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`, [`%${fragment}%`])
        if (r.rows[0].n >= count) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('Timed out waiting for blocked operations')
    }
    const expiring = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await pool.query("UPDATE gc_sub_capabilities SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE token_hash=$1", [hash(expiring.token)])
    const timeBlocker = await pool.connect()
    try {
      await timeBlocker.query('BEGIN')
      await timeBlocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [p1])
      const pending = service.redeemSubQr(gc1, expiring.token).then(() => ({ ok: true }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles', 1)
      await new Promise(resolve => setTimeout(resolve, 350))
      await timeBlocker.query('COMMIT')
      const result = await pending
      assert.equal(result.ok, false); if ('error' in result) assert.ok(result.error instanceof UnavailableError)
    } finally { await timeBlocker.query('ROLLBACK'); timeBlocker.release() }
    // Force revocation into the profile lock queue before redemption.
    const blockedQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [p1])
      const revocation = service.revoke(sub1, p1, 'gc1').then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles', 1)
      const redemption = service.redeemSubQr(gc1, blockedQr.token).then(() => ({ ok: true }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles', 2)
      await blocker.query('COMMIT')
      assert.equal((await revocation).ok, true)
      const result = await redemption
      assert.equal(result.ok, false); if ('error' in result) assert.ok(result.error instanceof UnavailableError)
      assert.deepEqual(await service.listGrantedCois(gc1, p1), [])
    } finally { await blocker.query('ROLLBACK'); blocker.release() }
    const firstQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    const blocker2 = await pool.connect()
    try {
      await blocker2.query('BEGIN')
      await blocker2.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [p1])
      const redemption = service.redeemSubQr(gc1, firstQr.token).then(() => ({ ok: true }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles', 1)
      const revocation = service.revoke(sub1, p1, 'gc1').then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles', 2)
      await blocker2.query('COMMIT')
      assert.equal((await redemption).ok, true)
      assert.equal((await revocation).ok, true)
      assert.deepEqual(await service.listGrantedCois(gc1, p1), [])
    } finally { await blocker2.query('ROLLBACK'); blocker2.release() }
    // A role change that commits while a request waits is observed at the lock, not the old token.
    const roleBlocker = await pool.connect()
    try {
      await roleBlocker.query('BEGIN')
      await roleBlocker.query("UPDATE users SET role='admin' WHERE id='gc1'")
      const pending = service.createGcInvite(gc1, p1).then(() => ({ ok: true }), e => ({ ok: false, error: e }))
      await waitForBlocked('SELECT id, role FROM users', 1)
      await roleBlocker.query('COMMIT')
      const result = await pending
      assert.equal(result.ok, false); if ('error' in result) assert.ok(result.error instanceof UnavailableError)
    } finally { await roleBlocker.query('ROLLBACK'); roleBlocker.release() }
    await pool.query("UPDATE users SET role='gc' WHERE id='gc1'")
    await bad(service.listGrantedSubs(gc1))
    gc1 = await mint('gc1')
    // Suspension is checked on every read and blocks redemption.
    const suspendedQr = await service.issueSubQr(sub1, p1, CONSENT_V2)
    await pool.query('UPDATE gc_sub_profiles SET revoked_at=clock_timestamp() WHERE id=$1', [p1])
    assert.deepEqual(await service.listGrantedSubs(gc1), [])
    await bad(service.redeemSubQr(gc1, suspendedQr.token))
    await assert.rejects(pool.query('UPDATE gc_sub_profiles SET revoked_at=NULL WHERE id=$1', [p1]), /irreversible/)
    // Migration history modification fails closed.
    await pool.query("UPDATE gc_sub_schema_migrations SET checksum='tampered'")
    const c = await pool.connect()
    try { await assert.rejects(migrateGcSubConsentV1(c), /history/) } finally { c.release() }
  } finally {
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
