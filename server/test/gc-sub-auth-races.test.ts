import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { gcSubConsentService, CONSENT_V1, UnavailableError } from '../src/services/gcSubConsent.ts'

const url = process.env.GC_SUB_TEST_PG_URL
if (!url) throw new Error('GC_SUB_TEST_PG_URL required')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || !parsed.port || !/^\/gc_sub_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('Use an explicit disposable 127.0.0.1:port gc_sub_test_* database')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'test-issuer', audience: 'test-audience' }
const hash = (s: string) => createHash('sha256').update(s, 'ascii').digest()
const sign = (sub: string, opts: jwt.SignOptions = {}, claims: Record<string, unknown> = {}) => jwt.sign(claims, keys.privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: sub, jwtid: randomBytes(32).toString('base64url'), expiresIn: '15m', ...opts })

test('auth-v2 session binding, forced lock order and statement snapshot boundaries', { timeout: 90000 }, async () => {
  const schema = `gc_sub_test_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS n")
    assert.ok(version.rows[0].n >= 160000 && version.rows[0].n < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000 -c deadlock_timeout=100ms`, max: 15 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT NOT NULL, password_hash TEXT, name TEXT);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,company_name TEXT,trade TEXT,status TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT,carrier TEXT,effective_date TEXT,expiration_date TEXT,status TEXT);
      INSERT INTO users VALUES('gc','gc','legacy','GC'),('sub','sub','legacy','Sub'),('other','gc','legacy','Other');
      INSERT INTO subcontractors VALUES('s','Sub Co','trade','active');
      INSERT INTO cois VALUES('c','s','carrier','2020','2030','active')`)
    const c = await pool.connect()
    try { await migrateGcSubConsentV1(c); await migrateAuthV2V1(c) } finally { c.release() }
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled)
      SELECT id,id||'@example.test','unused',clock_timestamp(),'review',true FROM users`)
    const profile = randomUUID()
    await pool.query("INSERT INTO gc_sub_profiles VALUES($1,'s','sub',clock_timestamp(),'review',NULL)", [profile])
    await pool.query("INSERT INTO gc_sub_coi_ownership VALUES('c',$1,'s',clock_timestamp(),'review')", [profile])
    const service = gcSubConsentService(pool, config)
    const mint = async (user: string, opts: jwt.SignOptions = {}, claims: Record<string, unknown> = {}, rowUser = user, dbExpiry?: string) => {
      const token = sign(user, opts, claims)
      await pool!.query(`INSERT INTO auth_v2_sessions(token_hash,user_id,created_at,expires_at)
        VALUES($1,$2,clock_timestamp()-interval '2 hours',${dbExpiry || "clock_timestamp()+interval '10 minutes'"})`, [hash(token), rowUser])
      return token
    }
    const waitLock = async (fragment: string) => {
      for (let i = 0; i < 400; i++) {
        const r = await pool!.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${fragment}%`])
        if (r.rows[0].n) return
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Timed out waiting for lock: ${fragment}`)
    }
    const subjectFor = (op: string) => ['issue', 'preview', 'accept', 'revoke'].includes(op) ? 'sub' : 'gc'
    const operations = ['issue', 'redeem', 'invite', 'preview', 'accept', 'revoke', 'subs', 'cois'] as const
    type Op = typeof operations[number]
    const prepare = async (op: Op, gc: string, sub: string): Promise<() => Promise<unknown>> => {
      if (op === 'issue') return () => service.issueSubQr(sub, profile, CONSENT_V1)
      if (op === 'redeem') { const q = await service.issueSubQr(sub, profile, CONSENT_V1); return () => service.redeemSubQr(gc, q.token) }
      if (op === 'invite') return () => service.createGcInvite(gc, profile)
      if (op === 'preview' || op === 'accept') {
        const inv = await service.createGcInvite(gc, profile)
        return op === 'preview' ? () => service.previewGcInvite(sub, inv.token) : () => service.acceptGcInvite(sub, inv.token, CONSENT_V1)
      }
      if (op === 'revoke' || op === 'subs' || op === 'cois') {
        const q = await service.issueSubQr(sub, profile, CONSENT_V1); await service.redeemSubQr(gc, q.token)
        return op === 'revoke' ? () => service.revoke(sub, profile, 'gc') : op === 'subs' ? () => service.listGrantedSubs(gc) : () => service.listGrantedCois(gc, profile)
      }
      throw new Error('unknown operation')
    }
    // Every operation must reject all independently bad credentials, not merely
    // routes protected by middleware. Rows for bad JWTs do not rescue them.
    for (const op of operations) {
      const who = subjectFor(op)
      for (const variant of ['missing', 'revoked', 'expired-db', 'wrong-user', 'disabled', 'missing-account', 'bad-audience', 'bad-issuer', 'expired-jwt', 'bad-signature', 'too-long', 'future-iat', 'no-jti'] as const) {
        await pool.query("INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) VALUES($1,$1||'@example.test','unused',clock_timestamp(),'review',true) ON CONFLICT(user_id) DO NOTHING", [who])
        await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id=$1 AND NOT enabled", [who])
        const validGc = await mint('gc'), validSub = await mint('sub')
        const runValid = await prepare(op, validGc, validSub)
        let invalid: string
        if (variant === 'missing') invalid = sign(who)
        else if (variant === 'wrong-user') invalid = await mint(who, {}, {}, who === 'gc' ? 'other' : 'gc')
        else if (variant === 'bad-audience') invalid = await mint(who, { audience: ['test-audience', 'other'] })
        else if (variant === 'bad-issuer') invalid = await mint(who, { issuer: 'other' })
        else if (variant === 'expired-jwt') invalid = await mint(who, { expiresIn: -1 })
        else if (variant === 'bad-signature') {
          invalid = jwt.sign({ nonce: randomUUID() }, 'not-a-valid-key', { algorithm: 'HS256', issuer: config.issuer, audience: config.audience, subject: who, expiresIn: '15m' })
          await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')", [hash(invalid), who])
        }
        else if (variant === 'too-long') invalid = await mint(who, { expiresIn: '16m' })
        else if (variant === 'future-iat') invalid = await mint(who, {}, { iat: Math.floor(Date.now() / 1000) + 10 })
        else if (variant === 'no-jti') {
          invalid = jwt.sign({ nonce: randomUUID() }, keys.privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: who, expiresIn: '15m' })
          await pool.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')", [hash(invalid), who])
        } else {
          invalid = await mint(who, {}, {}, who, variant === 'expired-db' ? "clock_timestamp()-interval '1 hour'" : undefined)
          if (variant === 'revoked') await pool.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hash(invalid)])
          if (variant === 'missing-account') {
            await pool.query('DELETE FROM auth_v2_accounts WHERE user_id=$1', [who])
            invalid = await mint(who)
          }
          if (variant === 'disabled') {
            await pool.query('UPDATE auth_v2_accounts SET enabled=false WHERE user_id=$1', [who])
            // Even a non-revoked row under a disabled account is unusable.
            invalid = await mint(who)
          }
        }
        // prepare() captured the valid credentials; construct the same operation with
        // invalid credentials but reuse no one-use tokens from the valid closure.
        // For preparation, temporarily use a good token on the invalid subject too.
        let run: () => Promise<unknown>
        if (op === 'issue') run = () => service.issueSubQr(invalid, profile, CONSENT_V1)
        else if (op === 'invite') run = () => service.createGcInvite(invalid, profile)
        else if (op === 'subs') run = () => service.listGrantedSubs(invalid)
        else if (op === 'cois') run = () => service.listGrantedCois(invalid, profile)
        else if (op === 'revoke') run = () => service.revoke(invalid, profile, 'gc')
        else {
          // Obtain capability independently from the unaffected counterpart. When
          // sub is disabled, createGcInvite uses only its live role, not its account.
          if (op === 'redeem') { const q = await service.issueSubQr(validSub, profile, CONSENT_V1); run = () => service.redeemSubQr(invalid, q.token) }
          else { const inv = await service.createGcInvite(validGc, profile); run = op === 'preview' ? () => service.previewGcInvite(invalid, inv.token) : () => service.acceptGcInvite(invalid, inv.token, CONSENT_V1) }
        }
        const snapshot = async () => ({ caps: (await pool!.query('SELECT * FROM gc_sub_capabilities ORDER BY token_hash')).rows, grants: (await pool!.query('SELECT * FROM gc_sub_grants ORDER BY profile_id,gc_user_id')).rows, events: (await pool!.query('SELECT * FROM gc_sub_grant_events ORDER BY id')).rows })
        const before = await snapshot()
        await assert.rejects(run(), UnavailableError, `${op}: ${variant}`)
        assert.deepEqual(await snapshot(), before, `${op}: ${variant} caused a write`)
        void runValid
      }
    }
    await pool.query('UPDATE auth_v2_accounts SET enabled=true WHERE NOT enabled')
    // Claims never determine role, including misleading elevated roles.
    const claimedAdmin = await mint('gc', {}, { role: 'admin' })
    assert.ok(Array.isArray(await service.listGrantedSubs(claimedAdmin)))
    await assert.rejects(service.issueSubQr(claimedAdmin, profile, CONSENT_V1), UnavailableError)
    type Event = 'logout' | 'logout-all' | 'disable' | 'role'
    const applyEvent = async (client: pg.PoolClient, event: Event, who: string, token: string) => {
      if (event === 'logout') return client.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL', [hash(token), who])
      if (event === 'disable') return client.query('UPDATE auth_v2_accounts SET enabled=false WHERE user_id=$1', [who])
      if (event === 'role') return client.query("UPDATE users SET role='admin' WHERE id=$1", [who])
      // Same lock and update sequence as auth-v2 /logout-all.
      await client.query("SELECT id FROM users WHERE id=$1 AND role IN ('gc','sub','admin') FOR UPDATE", [who])
      await client.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE', [who])
      await client.query('SELECT token_hash FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE', [hash(token), who])
      return client.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [who])
    }
    const eventFragment = (event: Event) => event === 'logout' ? 'UPDATE auth_v2_sessions SET revoked_at=' : event === 'logout-all' ? "SELECT id FROM users WHERE id=$1 AND role IN" : event === 'disable' ? 'UPDATE auth_v2_accounts SET enabled=false' : "UPDATE users SET role='admin'"
    for (const op of operations) for (const event of ['logout', 'logout-all', 'disable', 'role'] as Event[]) for (const first of ['event', 'operation'] as const) {
      await pool.query("UPDATE users SET role=CASE id WHEN 'gc' THEN 'gc' WHEN 'sub' THEN 'sub' ELSE role END WHERE id IN ('gc','sub') AND role='admin'")
      await pool.query('UPDATE auth_v2_accounts SET enabled=true WHERE NOT enabled')
      const gc = await mint('gc'), sub = await mint('sub'), who = subjectFor(op), token = who === 'gc' ? gc : sub
      const run = await prepare(op, gc, sub)
      const blocker = await pool.connect(), changer = await pool.connect()
      try {
        if (first === 'event') {
          await changer.query('BEGIN'); await applyEvent(changer, event, who, token)
          const pending = run().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
          await waitLock(event === 'role' || event === 'logout-all' ? 'SELECT id, role FROM users' : event === 'disable' ? 'SELECT user_id FROM auth_v2_accounts' : 'SELECT token_hash FROM auth_v2_sessions')
          await changer.query('COMMIT')
          const result = await pending
          assert.equal(result.ok, false, `${op}/${event}/${first}`)
          if ('error' in result) assert.ok(result.error instanceof UnavailableError, `${op}/${event}/${first}: ${result.error}`)
        } else {
          await blocker.query('BEGIN')
          const isRead = ['preview', 'subs', 'cois'].includes(op)
          if (isRead) await blocker.query(`LOCK TABLE ${op === 'preview' ? 'gc_sub_capabilities' : op === 'subs' ? 'subcontractors' : 'cois'} IN ACCESS EXCLUSIVE MODE`)
          else await blocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [profile])
          const pending = run().then(value => ({ ok: true, value }), error => ({ ok: false, error }))
          await waitLock(isRead ? (op === 'preview' ? 'SELECT g.id AS gc_user_id' : op === 'subs' ? 'SELECT s.id, s.company_name' : 'SELECT c.id, c.subcontractor_id') : 'SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles')
          await changer.query('BEGIN')
          const change = applyEvent(changer, event, who, token)
          await waitLock(eventFragment(event))
          await blocker.query('COMMIT')
          const result = await pending
          assert.equal(result.ok, true, `${op}/${event}/${first}: ${'error' in result ? result.error : ''}`)
          await change; await changer.query('COMMIT')
          await assert.rejects(run(), UnavailableError, `${op}/${event}/after`)
        }
      } finally {
        await blocker.query('ROLLBACK').catch(() => {}); blocker.release()
        await changer.query('ROLLBACK').catch(() => {}); changer.release()
      }
    }
    // An otherwise-valid session may expire while queued on profile, or after
    // the pre-write check while its write is blocked. In either case roll back.
    await pool.query("UPDATE users SET role=CASE id WHEN 'gc' THEN 'gc' ELSE 'sub' END WHERE id IN ('gc','sub') AND role='admin'")
    await pool.query('UPDATE auth_v2_accounts SET enabled=true WHERE NOT enabled')
    for (const stage of ['profile', 'insert', 'jwt-insert'] as const) {
      const short = stage === 'jwt-insert' ? await mint('sub', { expiresIn: 3 }) : await mint('sub', {}, {}, 'sub', "clock_timestamp()+interval '800 milliseconds'")
      const gate = await pool.connect()
      try {
        const before = (await pool.query('SELECT count(*)::int AS n FROM gc_sub_capabilities')).rows[0].n
        await gate.query('BEGIN')
        if (stage === 'profile') await gate.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE', [profile])
        else await gate.query('LOCK TABLE gc_sub_capabilities IN ACCESS EXCLUSIVE MODE')
        const pending = service.issueSubQr(short, profile, CONSENT_V1).then(value => ({ ok: true, value }), error => ({ ok: false, error }))
        await waitLock(stage === 'profile' ? 'SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles' : 'INSERT INTO gc_sub_capabilities')
        const delay = stage === 'jwt-insert' ? Math.max(0, (jwt.decode(short) as jwt.JwtPayload).exp! * 1000 - Date.now() + 200) : 1000
        await new Promise(resolve => setTimeout(resolve, delay))
        await gate.query('COMMIT')
        const result = await pending
        assert.equal(result.ok, false, `session expiry at ${stage}`)
        if ('error' in result) assert.ok(result.error instanceof UnavailableError)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM gc_sub_capabilities')).rows[0].n, before)
      } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release() }
    }
    // A data read is a statement snapshot: even though subject session/role locks
    // serialize auth changes, concurrent grant revocation can commit during a read.
    await pool.query("UPDATE users SET role=CASE id WHEN 'gc' THEN 'gc' ELSE 'sub' END WHERE id IN ('gc','sub') AND role='admin'")
    await pool.query('UPDATE auth_v2_accounts SET enabled=true WHERE NOT enabled')
    const gc = await mint('gc'), sub = await mint('sub')
    const q = await service.issueSubQr(sub, profile, CONSENT_V1); await service.redeemSubQr(gc, q.token)
    await pool.query(`ALTER TABLE subcontractors RENAME TO subcontractors_base;
      CREATE FUNCTION pause_name(t text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
      BEGIN PERFORM pg_advisory_lock(7654321); PERFORM pg_advisory_unlock(7654321); RETURN t; END $$;
      CREATE VIEW subcontractors AS SELECT id,pause_name(company_name) AS company_name,trade,status FROM subcontractors_base`)
    const gate = await pool.connect()
    try {
      await gate.query('SELECT pg_advisory_lock(7654321)')
      const reading = service.listGrantedSubs(gc)
      await waitLock('SELECT s.id, s.company_name')
      assert.equal(await service.revoke(sub, profile, 'gc'), true)
      await gate.query('SELECT pg_advisory_unlock(7654321)')
      assert.deepEqual((await reading).map(r => r.id), ['s'], 'in-flight read sees its earlier statement snapshot')
      assert.deepEqual(await service.listGrantedSubs(gc), [], 'subsequent statement sees committed revoke')
    } finally { await gate.query('SELECT pg_advisory_unlock_all()'); gate.release() }
    const q2 = await service.issueSubQr(sub, profile, CONSENT_V1); await service.redeemSubQr(gc, q2.token)
    await pool.query(`ALTER TABLE cois RENAME TO cois_base;
      CREATE VIEW cois AS SELECT id,subcontractor_id,pause_name(carrier) AS carrier,effective_date,expiration_date,status FROM cois_base`)
    const coiGate = await pool.connect()
    try {
      await coiGate.query('SELECT pg_advisory_lock(7654321)')
      const reading = service.listGrantedCois(gc, profile)
      await waitLock('SELECT c.id, c.subcontractor_id')
      assert.equal(await service.revoke(sub, profile, 'gc'), true)
      await coiGate.query('SELECT pg_advisory_unlock(7654321)')
      assert.deepEqual((await reading).map(r => r.id), ['c'])
      assert.deepEqual(await service.listGrantedCois(gc, profile), [])
    } finally { await coiGate.query('SELECT pg_advisory_unlock_all()'); coiGate.release() }
    const invite = await service.createGcInvite(gc, profile)
    await pool.query(`ALTER TABLE gc_sub_capabilities RENAME TO gc_sub_capabilities_base;
      CREATE FUNCTION pause_expiry(t timestamptz) RETURNS timestamptz LANGUAGE plpgsql VOLATILE AS $$
      BEGIN PERFORM pg_advisory_lock(7654321); PERFORM pg_advisory_unlock(7654321); RETURN t; END $$;
      CREATE VIEW gc_sub_capabilities AS SELECT token_hash,kind,profile_id,gc_user_id,consent_version,consented_at,
        created_at,pause_expiry(expires_at) AS expires_at,used_at,invalidated_at FROM gc_sub_capabilities_base`)
    const inviteGate = await pool.connect()
    try {
      await inviteGate.query('SELECT pg_advisory_lock(7654321)')
      const reading = service.previewGcInvite(sub, invite.token)
      await waitLock('SELECT g.id AS gc_user_id')
      await pool.query('UPDATE gc_sub_capabilities_base SET invalidated_at=clock_timestamp() WHERE token_hash=$1', [hash(invite.token)])
      await inviteGate.query('SELECT pg_advisory_unlock(7654321)')
      assert.equal((await reading).gc_user_id, 'gc')
      await assert.rejects(service.previewGcInvite(sub, invite.token), UnavailableError)
    } finally { await inviteGate.query('SELECT pg_advisory_unlock_all()'); inviteGate.release() }
  } finally {
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
