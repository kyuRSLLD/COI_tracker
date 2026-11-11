import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { RequestHandler } from 'express'
import pg from 'pg'
import { createGcOwnerV2Router } from '../src/routes/gcOwnerV2.ts'

const url = process.env.GC_OWNER_V2_TEST_PG_URL
function safeUrl(value: string | undefined): string {
  if (!value) throw new Error('GC_OWNER_V2_TEST_PG_URL must identify a disposable loopback database')
  const p = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(p.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(p.hostname) ||
      !/^\/owner_foundation_test_[a-z0-9_]+$/.test(p.pathname) || p.search || p.hash) {
    throw new Error('Tests require a disposable loopback owner_foundation_test_* database without URL options')
  }
  return value
}

test('factory requires explicit authentication and a pool', () => {
  assert.throws(() => createGcOwnerV2Router({ pool: {} as pg.Pool, authenticate: (() => {}) as RequestHandler }))
  assert.throws(() => createGcOwnerV2Router({ pool: { connect() {} } as pg.Pool, authenticate: undefined as any }))
})

test('disposable PostgreSQL: authenticated owner-scoped HTTP operations', async () => {
  const connectionString = safeUrl(url)
  const schema = `gc_api_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString })
  await admin.connect()
  let pool: pg.Pool | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let createdSchema = false
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); createdSchema = true
    // The random, generated schema is set on every pooled connection, not through
    // a shared or guessed search_path. These are synthetic tables, no migration.
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
    const sql = [
      `CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL)`,
      `CREATE TABLE subcontractors (id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT NOT NULL, trade TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE cois (id TEXT PRIMARY KEY, subcontractor_id TEXT NOT NULL, carrier TEXT NOT NULL, am_best_rating TEXT, policy_number TEXT, effective_date TEXT NOT NULL, expiration_date TEXT NOT NULL, status TEXT, reviewer_notes TEXT, certificate_url TEXT, certificate_key TEXT, certificate_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id, subcontractor_id))`,
      `CREATE TABLE owner_subcontractor_connections (subcontractor_id TEXT PRIMARY KEY REFERENCES subcontractors(id), owner_user_id TEXT NOT NULL REFERENCES users(id), assigned_at TEXT NOT NULL, UNIQUE(owner_user_id, subcontractor_id))`,
      `CREATE TABLE owner_coi_records (coi_id TEXT PRIMARY KEY, subcontractor_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, assigned_at TEXT NOT NULL, FOREIGN KEY(coi_id, subcontractor_id) REFERENCES cois(id, subcontractor_id), FOREIGN KEY(owner_user_id, subcontractor_id) REFERENCES owner_subcontractor_connections(owner_user_id, subcontractor_id))`,
      `INSERT INTO users VALUES ('gc1','gc'),('gc2','gc'),('sub1','sub'),('admin1','admin'),('stale','sub')`,
      `INSERT INTO subcontractors (id,company_name,trade,status,created_at,updated_at) VALUES ('legacy','Legacy','Trade','pending_review','now','now')`,
    ]
    for (const statement of sql) await pool.query(statement)
    const sessions: Record<string, { subject: string; role: 'gc' | 'sub' | 'admin' }> = {
      'token-one': { subject: 'gc1', role: 'gc' }, 'token-two': { subject: 'gc2', role: 'gc' },
      'token-sub': { subject: 'sub1', role: 'sub' }, 'token-admin': { subject: 'admin1', role: 'admin' },
      // Simulate a verified but stale session: DB role always wins.
      'token-stale': { subject: 'stale', role: 'gc' }, 'token-unknown': { subject: 'unknown', role: 'gc' },
    }
    const authenticate: RequestHandler = (req, res, next) => {
      const token = req.get('authorization')?.replace(/^Bearer /, '')
      if (token === 'missing-principal') { next(); return }
      if (token === 'malformed-principal') {
        Object.defineProperty(req, 'securePrincipal', { value: Object.freeze({ subject: 'gc1', role: 'gc', credential: '' }) })
        next(); return
      }
      if (token === 'error-middleware') throw new Error('secret middleware details')
      const identity = token && sessions[token]
      if (!identity) { res.status(401).json({ error: 'Authentication required' }); return }
      Object.defineProperty(req, 'securePrincipal', { value: Object.freeze({ ...identity, credential: token }), writable: false, configurable: false })
      next()
    }
    const app = express()
    app.use('/api/v2', createGcOwnerV2Router({ pool, authenticate }))
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const addr = server.address()
    assert.ok(addr && typeof addr !== 'string')
    const base = `http://127.0.0.1:${addr.port}/api/v2`
    async function call(method: string, path: string, token?: string, body?: unknown, extras: Record<string, string> = {}) {
      const headers: Record<string, string> = { ...extras }
      if (token) headers.authorization = `Bearer ${token}`
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { status: response.status, body: await response.json() as any }
    }
    const notFound = { status: 404, body: { error: 'Not found' } }
    const unauthenticated = { status: 401, body: { error: 'Authentication required' } }
    const invalid = { status: 400, body: { error: 'Invalid input' } }
    const sub = { company_name: 'Same', trade: 'Trade', email: 'private@example.test' }
    const coi = { carrier: 'Carrier', effective_date: '2025-01-01', expiration_date: '2026-01-01' }
    assert.deepEqual(await call('GET', '/subcontractors', undefined, undefined, { 'x-user-id': 'gc1', 'x-role': 'gc' }), unauthenticated)
    assert.deepEqual(await call('GET', '/subcontractors', 'gc1'), unauthenticated)
    assert.deepEqual(await call('GET', '/subcontractors', 'missing-principal'), unauthenticated)
    assert.deepEqual(await call('GET', '/subcontractors', 'malformed-principal'), unauthenticated)
    assert.deepEqual(await call('GET', '/subcontractors', 'error-middleware'), { status: 503, body: { error: 'Service unavailable' } })
    for (const token of ['token-sub', 'token-admin', 'token-stale', 'token-unknown']) {
      assert.deepEqual(await call('GET', '/subcontractors', token), notFound)
      assert.deepEqual(await call('POST', '/subcontractors', token, sub), notFound)
    }
    assert.deepEqual(await call('GET', '/subcontractors?owner_user_id=gc2', 'token-one'), { status: 200, body: [] })
    const s1 = await call('POST', '/subcontractors', 'token-one', sub, { 'x-user-id': 'gc2' })
    const s2 = await call('POST', '/subcontractors', 'token-two', sub)
    assert.equal(s1.status, 201); assert.equal(s2.status, 201)
    assert.deepEqual(Object.keys(s1.body), ['id']); assert.notEqual(s1.body.id, s2.body.id)
    const a = s1.body.id as string, b = s2.body.id as string
    assert.deepEqual((await call('GET', '/subcontractors', 'token-one')).body.map((x: any) => x.id), [a])
    assert.deepEqual(Object.keys((await call('GET', `/subcontractors/${a}`, 'token-one')).body).sort(),
      ['id', 'company_name', 'trade', 'contact_person', 'phone', 'email', 'status'].sort())
    assert.deepEqual((await call('GET', '/subcontractors', 'token-two')).body.map((x: any) => x.id), [b])
    for (const id of [b, 'legacy', 'missing']) {
      assert.deepEqual(await call('GET', `/subcontractors/${id}`, 'token-one'), notFound)
      assert.deepEqual(await call('PATCH', `/subcontractors/${id}`, 'token-one', { trade: 'hijack' }), notFound)
      assert.deepEqual(await call('GET', `/subcontractors/${id}/cois`, 'token-one'), notFound)
      assert.deepEqual(await call('POST', `/subcontractors/${id}/cois`, 'token-one', coi), notFound)
      assert.deepEqual(await call('PATCH', `/subcontractors/${id}`, 'token-one', { status: 'invalid' }), notFound)
      assert.deepEqual(await call('POST', `/subcontractors/${id}/cois`, 'token-one', {}), notFound)
    }
    assert.deepEqual(await call('PATCH', `/subcontractors/${a}`, 'token-one', { trade: 'New' }), { status: 200, body: { id: a } })
    assert.equal((await call('GET', `/subcontractors/${a}`, 'token-one')).body.trade, 'New')
    const c1 = await call('POST', `/subcontractors/${a}/cois`, 'token-one', coi)
    const c2 = await call('POST', `/subcontractors/${b}/cois`, 'token-two', coi)
    assert.equal(c1.status, 201); assert.equal(c2.status, 201)
    assert.deepEqual(Object.keys(c1.body), ['id'])
    const x = c1.body.id as string, y = c2.body.id as string
    await pool.query(`INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
      VALUES ('unmapped', $1, 'Legacy', '2020-01-01', '2030-01-01', 'pending_review', 'now', 'now')`, [a])
    await pool.query('UPDATE cois SET certificate_key = $1, certificate_url = $2, certificate_name = $3, policy_number = $4 WHERE id = $5', ['secret-storage-key', 'https://private.invalid/token', 'private-name', 'private-policy', x])
    assert.deepEqual((await call('GET', `/subcontractors/${a}/cois`, 'token-one')).body.map((r: any) => r.id), [x])
    assert.deepEqual((await call('GET', `/subcontractors/${b}/cois`, 'token-two')).body.map((r: any) => r.id), [y])
    for (const id of [y, 'unmapped', 'missing']) {
      assert.deepEqual(await call('GET', `/cois/${id}`, 'token-one'), notFound)
      assert.deepEqual(await call('PATCH', `/cois/${id}`, 'token-one', { carrier: 'hijack' }), notFound)
      assert.deepEqual(await call('PATCH', `/cois/${id}`, 'token-one', { certificate_key: 'invalid' }), notFound)
    }
    assert.deepEqual(await call('PATCH', `/cois/${x}`, 'token-one', { carrier: 'New carrier' }), { status: 200, body: { id: x } })
    const read = await call('GET', `/cois/${x}`, 'token-one')
    assert.deepEqual(Object.keys(read.body).sort(), ['id', 'subcontractor_id', 'carrier', 'effective_date', 'expiration_date', 'status'].sort())
    assert.equal(read.body.carrier, 'New carrier')
    assert.doesNotMatch(JSON.stringify(read), /secret-storage-key|private\.invalid|private-name|private-policy|token-one/)
    for (const [method, path, body] of [
      ['POST', '/subcontractors', { ...sub, owner_user_id: 'gc2' }],
      ['POST', '/subcontractors', { ...sub, user_id: 'gc2' }],
      ['PATCH', `/subcontractors/${a}`, { status: 'compliant' }],
      ['POST', `/subcontractors/${a}/cois`, { ...coi, subcontractor_id: b }],
      ['POST', `/subcontractors/${a}/cois`, { ...coi, certificate_key: 'secret' }],
      ['PATCH', `/cois/${x}`, { subcontractor_id: b }],
      ['PATCH', `/cois/${x}`, { certificate_url: 'https://attacker.invalid' }],
      ['PATCH', `/cois/${x}`, {}],
      ['PATCH', `/cois/${x}`, { effective_date: '2030-01-01' }],
      ['POST', `/subcontractors/${a}/cois`, { ...coi, expiration_date: '2025-02-30' }],
    ] as const) assert.deepEqual(await call(method, path, 'token-one', body), invalid)
    const malformed = await fetch(`${base}/subcontractors`, { method: 'POST', headers: { authorization: 'Bearer token-one', 'content-type': 'application/json' }, body: '{' })
    assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), invalid.body)
    const oversized = await call('POST', '/subcontractors', 'token-one', { ...sub, notes: 'x'.repeat(70000) })
    assert.deepEqual(oversized, { status: 413, body: { error: 'Invalid input' } })
    for (const path of [`/subcontractors/${a}`, `/cois/${x}`, '/subcontractors']) assert.deepEqual(await call('DELETE', path, 'token-one'), notFound)
    assert.equal((await call('GET', `/cois/${x}`, 'token-one')).status, 200)
    await pool.query("UPDATE users SET role = 'sub' WHERE id = 'gc1'")
    assert.deepEqual(await call('GET', '/subcontractors', 'token-one'), notFound)
    assert.deepEqual(await call('GET', `/cois/${x}`, 'token-one'), notFound)
    assert.deepEqual(await call('PATCH', `/cois/${x}`, 'token-one', { carrier: 'forbidden' }), notFound)
    await pool.query("UPDATE users SET role = 'gc' WHERE id = 'gc1'")
    // Exercise overlapping independent transactions over a small real pool.
    const creates = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/subcontractors', 'token-one', { company_name: `Concurrent ${i}`, trade: 'X' })))
    assert.ok(creates.every(r => r.status === 201))
    assert.equal(new Set(creates.map(r => r.body.id)).size, 12)
    const count = await pool.query('SELECT count(*)::int AS n FROM owner_subcontractor_connections WHERE owner_user_id = $1', ['gc1'])
    assert.equal(count.rows[0].n, 13)
    const removed = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('failed connection was not removed')), 3000)
      pool!.once('remove', () => { clearTimeout(timer); resolve() })
    })
    await pool.query('ALTER TABLE cois RENAME TO cois_temporarily_missing')
    const readRemoval = removed()
    const failed = await call('GET', `/cois/${x}`, 'token-one')
    assert.deepEqual(failed, { status: 503, body: { error: 'Service unavailable' } })
    await readRemoval
    await pool.query('ALTER TABLE cois_temporarily_missing RENAME TO cois')
    assert.equal((await call('GET', `/cois/${x}`, 'token-one')).status, 200)
    const before = await pool.query('SELECT count(*)::int AS n FROM subcontractors')
    await pool.query('ALTER TABLE owner_subcontractor_connections RENAME TO owner_subcontractor_connections_missing')
    const writeRemoval = removed()
    assert.deepEqual(await call('POST', '/subcontractors', 'token-one', sub), { status: 503, body: { error: 'Service unavailable' } })
    await writeRemoval
    await pool.query('ALTER TABLE owner_subcontractor_connections_missing RENAME TO owner_subcontractor_connections')
    const after = await pool.query('SELECT count(*)::int AS n FROM subcontractors')
    assert.deepEqual(after.rows, before.rows)
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()))
    if (pool) await pool.end()
    if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
