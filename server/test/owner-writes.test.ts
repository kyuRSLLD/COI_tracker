import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sqlite3 from 'sqlite3'
import pg from 'pg'
import { sqliteOwnerConnection, postgresOwnerConnection } from '../src/db/ownerConnection.ts'
import type { OwnerConnection, Row, SqlValue } from '../src/db/ownerConnection.ts'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { ownerReads } from '../src/services/ownerReads.ts'
import { ownerWrites, OwnerWriteError } from '../src/services/ownerWrites.ts'

type Fixture = { db: OwnerConnection; second: OwnerConnection; close: () => Promise<void> }
async function sqliteFixture(): Promise<Fixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'owner-writes-test-'))
  async function open() {
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
      const n = new sqlite3.Database(path.join(dir, 'synthetic.sqlite'), e => e ? reject(e) : resolve(n))
    })
    db.configure('busyTimeout', 5000)
    const conn = sqliteOwnerConnection(db)
    await conn.query('PRAGMA foreign_keys = ON')
    return { db, conn }
  }
  const a = await open(), b = await open()
  return { db: a.conn, second: b.conn, close: async () => {
    await Promise.all([a, b].map(x => new Promise<void>((resolve, reject) => x.db.close(e => e ? reject(e) : resolve()))))
    await rm(dir, { recursive: true, force: true })
  } }
}
async function postgresFixture(url: string): Promise<Fixture> {
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !/^\/owner_foundation_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('Tests require an explicit disposable loopback owner_foundation_test_* database without URL options')
  }
  const a = new pg.Client({ connectionString: url }), b = new pg.Client({ connectionString: url })
  await a.connect(); await b.connect()
  const schema = `owner_write_${randomUUID().replace(/-/g, '')}`
  try {
    await a.query(`CREATE SCHEMA ${schema}`)
    await a.query(`SET search_path TO ${schema}`); await b.query(`SET search_path TO ${schema}`)
  } catch (e) { await a.end(); await b.end(); throw e }
  return { db: postgresOwnerConnection(a), second: postgresOwnerConnection(b), close: async () => {
    try { await a.query(`DROP SCHEMA ${schema} CASCADE`) } finally { await a.end(); await b.end() }
  } }
}
async function seed(db: OwnerConnection) {
  for (const sql of [
    `CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT)`,
    `CREATE TABLE subcontractors (id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT NOT NULL, trade TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT, status TEXT DEFAULT 'pending_review', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE cois (id TEXT PRIMARY KEY, subcontractor_id TEXT NOT NULL, carrier TEXT NOT NULL, am_best_rating TEXT, policy_number TEXT, effective_date TEXT NOT NULL, expiration_date TEXT NOT NULL, status TEXT DEFAULT 'pending_review', reviewer_notes TEXT, review_date TEXT, certificate_url TEXT, certificate_key TEXT, certificate_name TEXT, certificate_size INTEGER, certificate_mime TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]) await db.query(sql)
  for (const [id, role] of [['gc1', 'gc'], ['gc2', 'gc'], ['admin', 'admin'], ['subuser', 'sub']])
    await db.query('INSERT INTO users (id, role) VALUES (?, ?)', [id, role])
  await db.query("INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES ('legacy', 'Same', 'Trade', 'now', 'now')")
  await migrateOwnerFoundationV1(db)
}
const backends: [string, () => Promise<Fixture>][] = [['sqlite', sqliteFixture]]
if (process.env.OWNER_WRITES_TEST_PG_URL) backends.push(['postgres', () => postgresFixture(process.env.OWNER_WRITES_TEST_PG_URL!)])
else console.log('PostgreSQL tests not requested; OWNER_WRITES_TEST_PG_URL is unset')
const coi = { carrier: 'Carrier', effective_date: '2025-01-01', expiration_date: '2026-01-01' }
function invalid(error: unknown) { return error instanceof OwnerWriteError && error.code === 'INVALID_INPUT' && error.message === 'Invalid input' }
function failed(error: unknown) { return error instanceof OwnerWriteError && error.code === 'STORAGE_FAILURE' && error.message === 'Owner write unavailable' && !('cause' in error) }

for (const [name, open] of backends) {
  test(`${name}: isolated creates, scoped patches, validation and no legacy inference`, async () => {
    const f = await open(); const { db } = f
    try {
      await seed(db)
      const one = ownerWrites(db, 'gc1'), two = ownerWrites(db, 'gc2')
      const s1 = (await one.createSubcontractor({ company_name: 'Same', trade: 'Trade', email: 'same@example.test' }))!.id
      const s2 = (await two.createSubcontractor({ company_name: 'Same', trade: 'Trade', email: 'same@example.test' }))!.id
      assert.equal(await one.createCoi({ ...coi, subcontractor_id: 'legacy' }), undefined)
      assert.equal(await one.createCoi({ ...coi, subcontractor_id: s2 }), undefined)
      const c1 = (await one.createCoi({ ...coi, subcontractor_id: s1 }))!.id
      const c2 = (await two.createCoi({ ...coi, subcontractor_id: s2 }))!.id
      await db.query(`INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, created_at, updated_at)
        VALUES ('old', ?, 'old', '2020-01-01', '2030-01-01', 'now', 'now')`, [s1])
      assert.deepEqual((await ownerReads(db, 'gc1').listSubcontractors()).map(x => x.id), [s1])
      assert.deepEqual((await ownerReads(db, 'gc1').listCois(s1)).map(x => x.id), [c1])
      assert.equal(await one.updateSubcontractor(s2, { trade: 'hijack' }), undefined)
      assert.equal(await one.updateSubcontractor('legacy', { trade: 'hijack' }), undefined)
      assert.equal(await one.updateSubcontractor('missing', { trade: 'hijack' }), undefined)
      assert.equal(await one.updateCoi(c2, { carrier: 'hijack' }), undefined)
      assert.equal(await one.updateCoi('old', { carrier: 'hijack' }), undefined)
      assert.equal(await one.updateCoi('missing', { carrier: 'hijack' }), undefined)
      assert.deepEqual(await one.updateSubcontractor(s1, { trade: "x', status = 'compliant' --", email: null }), { id: s1 })
      assert.deepEqual(await one.updateCoi(c1, { carrier: 'Updated', expiration_date: '2027-01-01' }), { id: c1 })
      const row = (await db.query<{ trade: string; status: string; email: string | null }>('SELECT trade, status, email FROM subcontractors WHERE id = ?', [s1]))[0]
      assert.deepEqual(row, { trade: "x', status = 'compliant' --", status: 'pending_review', email: null })
      assert.equal((await ownerReads(db, 'gc1').getCoi(c1))?.carrier, 'Updated')
      for (const subject of ['admin', 'subuser', 'missing']) {
        const denied = ownerWrites(db, subject)
        assert.equal(await denied.createSubcontractor({ company_name: 'x', trade: 'x' }), undefined)
        assert.equal(await denied.createCoi({ ...coi, subcontractor_id: s1 }), undefined)
        assert.equal(await denied.updateSubcontractor(s1, { trade: 'x' }), undefined)
        assert.equal(await denied.updateCoi(c1, { carrier: 'x' }), undefined)
      }
      await db.query('UPDATE users SET role = ? WHERE id = ?', ['sub', 'gc1'])
      assert.equal(await one.updateCoi(c1, { carrier: 'forbidden' }), undefined)
      assert.equal(await one.createSubcontractor({ company_name: 'x', trade: 'x' }), undefined)
      await db.query('UPDATE users SET role = ? WHERE id = ?', ['gc', 'gc1'])
      assert.throws(() => ownerWrites(db, ''), invalid)
      await assert.rejects(one.createSubcontractor({ company_name: 'x', trade: 'x', owner_user_id: 'gc2' } as any), invalid)
      await assert.rejects(one.createSubcontractor({ company_name: 'x', trade: 'x', user_id: 'gc2' } as any), invalid)
      await assert.rejects(one.createCoi({ ...coi, subcontractor_id: s1, owner_user_id: 'gc2' } as any), invalid)
      await assert.rejects(one.updateCoi(c1, { subcontractor_id: s2 } as any), invalid)
      await assert.rejects(one.updateCoi(c1, { certificate_key: 'secret' } as any), invalid)
      await assert.rejects(one.updateSubcontractor(s1, { status: 'compliant' } as any), invalid)
      await assert.rejects(one.updateCoi(c1, {}), invalid)
      await assert.rejects(one.createCoi({ ...coi, subcontractor_id: s1, effective_date: '2025-02-30' }), invalid)
      await assert.rejects(one.createCoi({ ...coi, subcontractor_id: s1, effective_date: '2027-01-01' }), invalid)
      await assert.rejects(one.updateCoi(c1, { effective_date: '2028-01-01' }), invalid)
      assert.equal((await ownerReads(db, 'gc1').getCoi(c1))?.effective_date, '2025-01-01')
      await assert.rejects(db.query('DELETE FROM cois WHERE id = ?', [c1]))
      await assert.rejects(db.query('DELETE FROM subcontractors WHERE id = ?', [s1]))
      assert.equal((await db.query<{ n: number | string }>('SELECT count(*) AS n FROM subcontractors'))[0].n.toString(), '3')
    } finally { await f.close() }
  })

  test(`${name}: source and mapping rollback together and errors are sanitized`, async () => {
    const f = await open(); const { db } = f
    try {
      await seed(db)
      const one = ownerWrites(db, 'gc1')
      const sub = (await one.createSubcontractor({ company_name: 'test', trade: 'test' }))!.id
      for (const table of ['owner_subcontractor_connections', 'owner_coi_records']) {
        const beforeSubs = await db.query('SELECT * FROM subcontractors ORDER BY id')
        const beforeCois = await db.query('SELECT * FROM cois ORDER BY id')
        const beforeMappings = await db.query(`SELECT * FROM ${table}`)
        const broken: OwnerConnection = { dialect: db.dialect, async query(sql, values) {
          if (sql.startsWith(`INSERT INTO ${table} `)) {
            // A genuine constraint failure, not just a mocked exception.
            if (table === 'owner_subcontractor_connections')
              return db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['missing-private-id', 'gc1', 'now'])
            return db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['missing-private-id', sub, 'gc1', 'now'])
          }
          return db.query(sql, values)
        } }
        const writes = ownerWrites(broken, 'gc1')
        if (table === 'owner_coi_records') await assert.rejects(writes.createCoi({ ...coi, subcontractor_id: sub }), failed)
        else await assert.rejects(writes.createSubcontractor({ company_name: 'private-value', trade: 'x' }), failed)
        assert.deepEqual(await db.query('SELECT * FROM subcontractors ORDER BY id'), beforeSubs)
        assert.deepEqual(await db.query('SELECT * FROM cois ORDER BY id'), beforeCois)
        assert.deepEqual(await db.query(`SELECT * FROM ${table}`), beforeMappings)
      }
      const id = (await one.createCoi({ ...coi, subcontractor_id: sub }))!.id
      const brokenRollback: OwnerConnection = { dialect: db.dialect, async query(sql, values) {
        if (sql === 'ROLLBACK') {
          await db.query(sql) // Simulate loss of acknowledgement after the server rolled back.
          throw new Error('sensitive rollback failure')
        }
        return db.query(sql, values)
      } }
      await assert.rejects(ownerWrites(brokenRollback, 'gc1').updateCoi(id, { effective_date: '2030-01-01' }), failed)
      const brokenCommit: OwnerConnection = { dialect: db.dialect, async query(sql, values) {
        if (sql === 'COMMIT') throw new Error('sensitive commit failure')
        return db.query(sql, values)
      } }
      await assert.rejects(ownerWrites(brokenCommit, 'gc1').updateCoi(id, { carrier: 'should roll back' }), failed)
      assert.equal((await ownerReads(db, 'gc1').getCoi(id))?.carrier, 'Carrier')
    } finally { await f.close() }
  })

  test(`${name}: concurrent role revocation waits for active write; later writes fail`, async () => {
    const f = await open(); const { db, second } = f
    try {
      await seed(db)
      let release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const locked = new Promise<void>(resolve => { entered = resolve })
      const delayed: OwnerConnection = { dialect: db.dialect, async query<T extends Row>(sql: string, values?: SqlValue[]): Promise<T[]> {
        const result = await db.query<T>(sql, values)
        if (sql.startsWith('SELECT id FROM users WHERE')) { entered(); await gate }
        return result
      } }
      const writing = ownerWrites(delayed, 'gc1').createSubcontractor({ company_name: 'before revocation', trade: 'x' })
      await locked
      let revoked = false
      const revocation = second.query("UPDATE users SET role = 'sub' WHERE id = ?", ['gc1']).then(() => { revoked = true })
      await new Promise(resolve => setTimeout(resolve, 150))
      const wasBlocked = !revoked
      release()
      const created = await writing
      await revocation
      assert.equal(wasBlocked, true)
      assert.ok(created?.id)
      assert.equal(await ownerWrites(db, 'gc1').updateSubcontractor(created!.id, { trade: 'after' }), undefined)
      assert.equal(await ownerWrites(db, 'gc1').createSubcontractor({ company_name: 'after', trade: 'x' }), undefined)
      assert.equal((await db.query<{ trade: string }>('SELECT trade FROM subcontractors WHERE id = ?', [created!.id]))[0].trade, 'x')
    } finally { await f.close() }
  })

  test(`${name}: concurrent partial updates preserve both changes`, async () => {
    const f = await open()
    try {
      await seed(f.db)
      const one = ownerWrites(f.db, 'gc1'), two = ownerWrites(f.second, 'gc1')
      const id = (await one.createCoi({ ...coi, subcontractor_id: (await one.createSubcontractor({ company_name: 'x', trade: 'x' }))!.id }))!.id
      await Promise.all([one.updateCoi(id, { carrier: 'new carrier' }), two.updateCoi(id, { policy_number: 'new policy' })])
      assert.deepEqual((await f.db.query('SELECT carrier, policy_number FROM cois WHERE id = ?', [id]))[0], { carrier: 'new carrier', policy_number: 'new policy' })
    } finally { await f.close() }
  })

  test(`${name}: role revocation committed first denies an in-flight writer`, async () => {
    const f = await open()
    try {
      await seed(f.db)
      await f.second.query(name === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      await f.second.query("UPDATE users SET role = 'sub' WHERE id = ?", ['gc1'])
      let finished = false
      const writing = ownerWrites(f.db, 'gc1').createSubcontractor({ company_name: 'not created', trade: 'x' }).then(x => { finished = true; return x })
      await new Promise(resolve => setTimeout(resolve, 150))
      const wasBlocked = !finished
      await f.second.query('COMMIT')
      assert.equal(await writing, undefined)
      assert.equal(wasBlocked, true)
      assert.equal((await f.db.query<{ n: number | string }>('SELECT count(*) AS n FROM subcontractors'))[0].n.toString(), '1')
    } finally { await f.close() }
  })

  test(`${name}: ownership mapping cannot be removed during COI creation`, async () => {
    const f = await open(); let release!: () => void
    try {
      await seed(f.db)
      const sub = (await ownerWrites(f.db, 'gc1').createSubcontractor({ company_name: 'x', trade: 'x' }))!.id
      let entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const locked = new Promise<void>(resolve => { entered = resolve })
      const delayed: OwnerConnection = { dialect: f.db.dialect, async query<T extends Row>(sql: string, values?: SqlValue[]): Promise<T[]> {
        const result = await f.db.query<T>(sql, values)
        if (sql.startsWith('SELECT subcontractor_id FROM owner_subcontractor_connections')) { entered(); await gate }
        return result
      } }
      const writing = ownerWrites(delayed, 'gc1').createCoi({ ...coi, subcontractor_id: sub })
      await locked
      let finished = false
      const deletion = f.second.query('DELETE FROM owner_subcontractor_connections WHERE subcontractor_id = ?', [sub])
        .then(() => { finished = true; return 'deleted' }, () => { finished = true; return 'rejected' })
      await new Promise(resolve => setTimeout(resolve, 150))
      const wasBlocked = !finished
      release()
      assert.ok((await writing)?.id)
      assert.equal(await deletion, 'rejected')
      assert.equal(wasBlocked, true)
      assert.equal((await f.db.query('SELECT * FROM owner_subcontractor_connections WHERE subcontractor_id = ?', [sub])).length, 1)
      assert.equal((await f.db.query('SELECT * FROM owner_coi_records WHERE subcontractor_id = ?', [sub])).length, 1)
    } finally { if (release) release(); await f.close() }
  })
}

test('sqlite: missing foreign key enforcement fails closed without writes', async () => {
  const f = await sqliteFixture()
  try {
    await seed(f.db); await f.db.query('PRAGMA foreign_keys = OFF')
    await assert.rejects(ownerWrites(f.db, 'gc1').createSubcontractor({ company_name: 'x', trade: 'x' }), failed)
    assert.equal((await f.db.query<{ n: number }>('SELECT count(*) AS n FROM subcontractors'))[0].n, 1)
  } finally { await f.close() }
})
