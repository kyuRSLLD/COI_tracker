import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import express from 'express'
import type { RequestHandler } from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { postgresOwnerConnection } from '../src/db/ownerConnection.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { createVerifiedPrincipalAdapter } from '../src/secure-v2-synthetic.ts'
import { createGcOwnerV2Router } from '../src/routes/gcOwnerV2.ts'
import { withOwnerV2Transaction, OwnerV2AuthError } from '../src/services/ownerWrites.ts'

const url = process.env.SECURE_V2_TEST_PG_URL
if (!url || process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test and disposable SECURE_V2_TEST_PG_URL required')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || !parsed.port || !/^\/secure_v2_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('Explicit disposable loopback secure_v2_test_* database required')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'synthetic', audience: 'synthetic-client' }
const digest = (token: string) => createHash('sha256').update(token, 'ascii').digest()
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('real HTTP GC owner operations serialize with auth-v2 changes and recheck expiry', { timeout: 120000 }, async () => {
  const schema = `gc_race_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined, server: http.Server | undefined
  try {
    const version = (await admin.query("SELECT current_setting('server_version_num')::int v")).rows[0].v
    assert.ok(version >= 160000 && version < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c statement_timeout=8000 -c deadlock_timeout=100ms`, max: 15 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,user_id TEXT,company_name TEXT NOT NULL,trade TEXT NOT NULL,contact_person TEXT,phone TEXT,email TEXT,address TEXT,notes TEXT,status TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,am_best_rating TEXT,policy_number TEXT,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,reviewer_notes TEXT,certificate_url TEXT,certificate_key TEXT,certificate_name TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO users VALUES('gc1','gc1@example.test','legacy','one','gc','now'),('gc2','gc2@example.test','legacy','two','gc','now')`)
    const init = await pool.connect()
    try { await migrateOwnerFoundationV1(postgresOwnerConnection(init)); await migrateAuthV2V1(init) } finally { init.release() }
    const password = 'synthetic password only 123'
    const ph = await hashV2Password(password)
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled)
      SELECT id,email,$1,clock_timestamp(),'synthetic',true FROM users`, [ph])
    const auth = createV2Auth(pool, config), adapter = createVerifiedPrincipalAdapter(auth.requireAuth)
    let afterAuth: (() => Promise<void>) | undefined
    const authenticate: RequestHandler = (req, res, next) => adapter(req, res, err => {
      if (err) return next(err)
      const gate = afterAuth; afterAuth = undefined
      if (gate) void gate().then(() => next(), next); else next()
    })
    const app = express(); app.use('/auth', auth.router); app.use('/gc', createGcOwnerV2Router({ pool, authenticate }))
    server = app.listen(0, '127.0.0.1'); await new Promise<void>((r, j) => { server!.once('listening', r); server!.once('error', j) })
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const call = async (path: string, method = 'GET', token?: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : null }
    }
    const mint = async (who: string, seconds = 900, dbSeconds = 600, insert = true) => {
      const token = jwt.sign({}, keys.privateKey, { algorithm: 'RS256', issuer: config.issuer, audience: config.audience, subject: who, jwtid: randomBytes(32).toString('base64url'), expiresIn: seconds })
      if (insert) await pool!.query("INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second')", [digest(token), who, dbSeconds])
      return token
    }
    const waitLock = async (fragment: string) => {
      for (let i = 0; i < 500; i++) {
        const r = await pool!.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [`%${fragment}%`])
        if (r.rows[0].n) return
        await pause(10)
      }
      throw new Error(`Timed out waiting for ${fragment}`)
    }
    const snapshot = async () => {
      const out: unknown[] = []
      for (const table of ['subcontractors','cois','owner_subcontractor_connections','owner_coi_records']) out.push((await pool!.query(`SELECT * FROM ${table} ORDER BY 1`)).rows)
      return out
    }
    const login = await call('/auth/login', 'POST', undefined, { email: 'gc1@example.test', password })
    assert.equal(login.status, 200)
    const gc1 = login.body.token as string, gc2 = await mint('gc2')
    // Even a mistakenly retained transaction-bound service cannot be used after
    // commit; signature verified here before directly entering the trusted API.
    jwt.verify(gc1, keys.publicKey, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience, maxAge: 900 })
    const serviceClient = await pool.connect()
    try {
      const bound = await withOwnerV2Transaction(serviceClient, { subject: 'gc1', credential: gc1 }, async (reads, writes) => ({ reads, writes }))
      await assert.rejects(bound.reads.listSubcontractors(), OwnerV2AuthError)
      await assert.rejects(bound.writes.createSubcontractor({ company_name: 'late', trade: 'late' }), OwnerV2AuthError)
    } finally { serviceClient.release() }
    const s1 = await call('/gc/subcontractors', 'POST', gc1, { company_name: 'private one', trade: 'trade' })
    const s2 = await call('/gc/subcontractors', 'POST', gc2, { company_name: 'private two', trade: 'trade' })
    assert.equal(s1.status, 201); assert.equal(s2.status, 201)
    const coiBody = { carrier: 'private carrier', effective_date: '2025-01-01', expiration_date: '2030-01-01' }
    const c1 = await call(`/gc/subcontractors/${s1.body.id}/cois`, 'POST', gc1, coiBody)
    const c2 = await call(`/gc/subcontractors/${s2.body.id}/cois`, 'POST', gc2, coiBody)
    assert.equal(c1.status, 201); assert.equal(c2.status, 201)
    // Distinct COI updates by the same user must not contend on an upgraded
    // users-row lock (the authenticated scope takes a shared users lock).
    const c3 = await call(`/gc/subcontractors/${s1.body.id}/cois`, 'POST', gc1, coiBody)
    assert.equal(c3.status, 201)
    const concurrent = await Promise.all(Array.from({ length: 16 }, (_, i) => call(`/gc/cois/${i % 2 ? c1.body.id : c3.body.id}`, 'PATCH', gc1, { carrier: `concurrent-${i}` })))
    assert.ok(concurrent.every(r => r.status === 200), JSON.stringify(concurrent))
    const crossSnapshot = await snapshot()
    for (const [path, method, body] of [
      [`/gc/subcontractors/${s2.body.id}`, 'GET', undefined], [`/gc/subcontractors/${s2.body.id}`, 'PATCH', { trade: 'stolen' }],
      [`/gc/subcontractors/${s2.body.id}/cois`, 'GET', undefined], [`/gc/subcontractors/${s2.body.id}/cois`, 'POST', coiBody],
      [`/gc/cois/${c2.body.id}`, 'GET', undefined], [`/gc/cois/${c2.body.id}`, 'PATCH', { carrier: 'stolen' }],
    ] as const) assert.equal((await call(path, method, gc1, body)).status, 404)
    assert.deepEqual(await snapshot(), crossSnapshot)
    const absent = await mint('gc1', 900, 600, false)
    assert.equal((await call('/gc/subcontractors', 'GET', absent)).status, 401)
    const invalid = await mint('gc1', -1)
    assert.equal((await call('/gc/subcontractors', 'GET', invalid)).status, 401)

    const ops = [
      { path: '/gc/subcontractors', method: 'GET', table: 'subcontractors', query: 'SELECT s.id, s.company_name', success: 200 },
      { path: `/gc/subcontractors/${s1.body.id}`, method: 'GET', table: 'subcontractors', query: 'SELECT s.id, s.company_name', success: 200 },
      { path: '/gc/subcontractors', method: 'POST', table: 'subcontractors', query: 'INSERT INTO subcontractors', body: { company_name: 'new private', trade: 'x' }, success: 201 },
      { path: `/gc/subcontractors/${s1.body.id}`, method: 'PATCH', table: 'subcontractors', query: 'SELECT s.id, s.company_name', body: { trade: 'changed' }, success: 200 },
      { path: `/gc/subcontractors/${s1.body.id}/cois`, method: 'GET', table: 'cois', query: 'SELECT c.id, c.subcontractor_id', success: 200 },
      { path: `/gc/subcontractors/${s1.body.id}/cois`, method: 'POST', table: 'cois', query: 'INSERT INTO cois', body: coiBody, success: 201 },
      { path: `/gc/cois/${c1.body.id}`, method: 'GET', table: 'cois', query: 'SELECT c.id, c.subcontractor_id', success: 200 },
      { path: `/gc/cois/${c1.body.id}`, method: 'PATCH', table: 'cois', query: 'SELECT c.id, c.subcontractor_id', body: { carrier: 'changed' }, success: 200 },
    ]
    type Event = 'logout' | 'logout-all' | 'disable' | 'role'
    const apply = async (c: pg.PoolClient, event: Event, token: string) => {
      if (event === 'logout') return c.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL', [digest(token), 'gc1'])
      if (event === 'disable') return c.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc1'")
      if (event === 'role') return c.query("UPDATE users SET role='sub' WHERE id='gc1'")
      await c.query("SELECT id FROM users WHERE id=$1 AND role IN ('gc','sub','admin') FOR UPDATE", ['gc1'])
      await c.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE', ['gc1'])
      await c.query('SELECT token_hash FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE', [digest(token), 'gc1'])
      return c.query("UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id='gc1' AND revoked_at IS NULL")
    }
    const eventWait = (e: Event) => e === 'role' ? "UPDATE users SET role='sub'" : e === 'disable' ? 'UPDATE auth_v2_accounts SET enabled=false' : e === 'logout' ? 'UPDATE auth_v2_sessions SET revoked_at=' : "SELECT id FROM users WHERE id=$1 AND role IN"
    for (const op of ops) for (const event of ['logout','logout-all','disable','role'] as Event[]) for (const order of ['event','operation'] as const) {
      await pool.query("UPDATE users SET role='gc' WHERE id='gc1' AND role<>'gc'")
      await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc1' AND NOT enabled")
      const token = await mint('gc1')
      const gate = await pool.connect(), changer = await pool.connect()
      const label = `${op.method} ${op.path} ${event} ${order}`
      try {
        if (order === 'event') {
          let reached!: () => void, release!: () => void
          const ready = new Promise<void>(r => { reached = r }), proceed = new Promise<void>(r => { release = r })
          afterAuth = async () => { reached(); await proceed }
          const request = call(op.path, op.method, token, op.body)
          await ready
          await changer.query('BEGIN'); await apply(changer, event, token)
          const before = await snapshot(); release()
          await waitLock(event === 'role' || event === 'logout-all' ? 'SELECT id, role FROM users' : event === 'disable' ? 'SELECT user_id FROM auth_v2_accounts' : 'SELECT token_hash FROM auth_v2_sessions')
          await changer.query('COMMIT')
          const result = await request
          assert.ok(result.status === 401 || result.status === 404, `${label}: ${result.status}`)
          assert.doesNotMatch(JSON.stringify(result), /private one|private carrier/)
          assert.deepEqual(await snapshot(), before, label)
        } else {
          await gate.query('BEGIN'); await gate.query(`LOCK TABLE ${op.table} IN ACCESS EXCLUSIVE MODE`)
          const request = call(op.path, op.method, token, op.body)
          await waitLock(op.query)
          let change: Promise<unknown>
          if (event === 'logout' || event === 'logout-all') {
            change = call(`/auth/${event}`, 'POST', token, {})
          } else { await changer.query('BEGIN'); change = apply(changer, event, token) }
          await waitLock(eventWait(event))
          await gate.query('COMMIT')
          assert.equal((await request).status, op.success, label)
          const changed = await change
          if (event === 'logout' || event === 'logout-all') assert.equal((changed as { status: number }).status, 204, label)
          else await changer.query('COMMIT')
          const after = await snapshot()
          assert.equal((await call(op.path, op.method, token, op.body)).status, 401, label)
          assert.deepEqual(await snapshot(), after, label)
        }
      } finally { afterAuth = undefined; await gate.query('ROLLBACK').catch(() => {}); gate.release(); await changer.query('ROLLBACK').catch(() => {}); changer.release() }
    }
    await pool.query("UPDATE users SET role='gc' WHERE id='gc1' AND role<>'gc'")
    await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc1' AND NOT enabled")
    // Session can disappear after trusted middleware but before the transaction.
    {
      const token = await mint('gc1')
      let reached!: () => void, release!: () => void
      const ready = new Promise<void>(r => { reached = r }), proceed = new Promise<void>(r => { release = r })
      afterAuth = async () => { reached(); await proceed }
      const before = await snapshot()
      const pending = call('/gc/subcontractors', 'POST', token, { company_name: 'missing session', trade: 'x' })
      await ready
      await pool.query('DELETE FROM auth_v2_sessions WHERE token_hash=$1', [digest(token)])
      release()
      assert.equal((await pending).status, 401)
      assert.deepEqual(await snapshot(), before)
    }
    // Block after the source INSERT: expired authentication must roll back both
    // source and owner mapping. Test database expiry and JWT expiry independently.
    for (const mode of ['session', 'jwt'] as const) {
      const token = mode === 'jwt' ? await mint('gc1', 4, 600) : await mint('gc1', 900, 1)
      const exp = (jwt.decode(token) as jwt.JwtPayload).exp!
      const gate = await pool.connect()
      try {
        const before = await snapshot()
        await gate.query('BEGIN'); await gate.query('LOCK TABLE owner_subcontractor_connections IN ACCESS EXCLUSIVE MODE')
        const pending = call('/gc/subcontractors', 'POST', token, { company_name: 'never committed', trade: 'x' })
        await waitLock('INSERT INTO owner_subcontractor_connections')
        await pause(mode === 'jwt' ? Math.max(0, exp * 1000 - Date.now() + 250) : 1300)
        await gate.query('COMMIT')
        assert.equal((await pending).status, 401, mode)
        assert.deepEqual(await snapshot(), before, mode)
      } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release() }
    }
    // A read blocked after obtaining auth locks must not return its data when
    // the session expires during the data statement.
    {
      const token = await mint('gc1', 900, 1)
      const gate = await pool.connect()
      try {
        await gate.query('BEGIN'); await gate.query('LOCK TABLE subcontractors IN ACCESS EXCLUSIVE MODE')
        const pending = call(`/gc/subcontractors/${s1.body.id}`, 'GET', token)
        await waitLock('SELECT s.id, s.company_name')
        await pause(1300); await gate.query('COMMIT')
        assert.deepEqual(await pending, { status: 401, body: { error: 'Authentication required' } })
      } finally { await gate.query('ROLLBACK').catch(() => {}); gate.release() }
    }
    // READ COMMITTED protects auth state with locks, not unrelated owner-mapping
    // revocations during an already running SELECT: it uses its statement snapshot.
    {
      const token = await mint('gc1')
      const created = await call('/gc/subcontractors', 'POST', token, { company_name: 'snapshot row', trade: 'x' })
      assert.equal(created.status, 201)
      await pool.query(`ALTER TABLE subcontractors RENAME TO subcontractors_base;
        CREATE FUNCTION pause_gc_name(t text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
        BEGIN PERFORM pg_advisory_lock(762341); PERFORM pg_advisory_unlock(762341); RETURN t; END $$;
        CREATE VIEW subcontractors AS SELECT id,user_id,pause_gc_name(company_name) company_name,trade,contact_person,phone,email,address,notes,status,created_at,updated_at FROM subcontractors_base`)
      const gate = await pool.connect()
      try {
        await gate.query('SELECT pg_advisory_lock(762341)')
        const pending = call(`/gc/subcontractors/${created.body.id}`, 'GET', token)
        await waitLock('SELECT s.id, s.company_name')
        await pool.query('DELETE FROM owner_subcontractor_connections WHERE subcontractor_id=$1', [created.body.id])
        await gate.query('SELECT pg_advisory_unlock(762341)')
        assert.equal((await pending).status, 200, 'in-flight statement observes earlier mapping snapshot')
        assert.equal((await call(`/gc/subcontractors/${created.body.id}`, 'GET', token)).status, 404, 'later statement sees committed mapping removal')
      } finally { await gate.query('SELECT pg_advisory_unlock_all()'); gate.release() }
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())) }
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
