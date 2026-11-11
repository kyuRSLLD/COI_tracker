import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import sqlite3 from 'sqlite3'
import pg from 'pg'
import { postgresOwnerConnection, sqliteOwnerConnection } from '../src/db/ownerConnection.ts'
import type { OwnerConnection } from '../src/db/ownerConnection.ts'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { ownerReads } from '../src/services/ownerReads.ts'

async function makeSqlite(): Promise<{ db: OwnerConnection; close: () => Promise<void> }> {
  const native = await new Promise<sqlite3.Database>((resolve, reject) => {
    const handle = new sqlite3.Database(':memory:', err => err ? reject(err) : resolve(handle))
  })
  const db = sqliteOwnerConnection(native)
  await db.query('PRAGMA foreign_keys = ON')
  return { db, close: () => new Promise((resolve, reject) => native.close(err => err ? reject(err) : resolve())) }
}

async function makePostgres(url: string): Promise<{ db: OwnerConnection; close: () => Promise<void> }> {
  const parsed = new URL(url)
  // Hard fail before connecting unless the operator deliberately supplied a disposable local test DB.
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !/^\/owner_foundation_test_[a-z0-9_]+$/.test(parsed.pathname)) {
    throw new Error('PostgreSQL tests require an explicit loopback owner_foundation_test_* database')
  }
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  const schema = `owner_test_${randomUUID().replace(/-/g, '')}`
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema}`)
  } catch (error) { await client.end(); throw error }
  const db = postgresOwnerConnection(client)
  return { db, close: async () => { try { await client.query(`DROP SCHEMA ${schema} CASCADE`) } finally { await client.end() } } }
}

async function baseline(db: OwnerConnection) {
  // Representative source tables, intentionally without ownership columns.
  for (const sql of [
    `CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT, name TEXT)`,
    `CREATE TABLE subcontractors (id TEXT PRIMARY KEY, company_name TEXT NOT NULL, trade TEXT NOT NULL, contact_person TEXT, phone TEXT, email TEXT, status TEXT)`,
    `CREATE TABLE cois (id TEXT PRIMARY KEY, subcontractor_id TEXT NOT NULL, carrier TEXT NOT NULL, effective_date TEXT NOT NULL, expiration_date TEXT NOT NULL, status TEXT, certificate_key TEXT, certificate_url TEXT)`,
  ]) await db.query(sql)
  for (const row of [
    ['gc1', 'gc', 'same@example.test', 'same'], ['gc2', 'gc', 'same@example.test', 'same'],
    ['subuser', 'sub', 'sub@example.test', 'same'], ['admin', 'admin', 'admin@example.test', 'same'],
  ]) await db.query('INSERT INTO users (id, role, email, name) VALUES (?, ?, ?, ?)', row)
  for (const id of ['s1', 's2', 'legacy']) {
    await db.query('INSERT INTO subcontractors (id, company_name, trade, email) VALUES (?, ?, ?, ?)', [id, 'same', 'trade', 'same@example.test'])
  }
  for (const [id, sub] of [['c1', 's1'], ['c2', 's2'], ['old-c1', 's1'], ['legacy-c', 'legacy']]) {
    await db.query(`INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, certificate_key, certificate_url)
      VALUES (?, ?, 'carrier', '2020-01-01', '2030-01-01', 'secret-key', 'https://secret.test/private')`, [id, sub])
  }
}

const backends: [string, () => Promise<{ db: OwnerConnection; close: () => Promise<void> }>][] = [['sqlite', makeSqlite]]
if (process.env.OWNER_FOUNDATION_TEST_PG_URL) backends.push(['postgres', () => makePostgres(process.env.OWNER_FOUNDATION_TEST_PG_URL!)])
else console.log('PostgreSQL owner-foundation tests not requested: OWNER_FOUNDATION_TEST_PG_URL is unset')

for (const [name, open] of backends) {
  test(`${name}: atomic migration, explicit mappings and scoped reads`, async () => {
    const fixture = await open(); const { db } = fixture
    try {
      await baseline(db)
      const beforeSubs = await db.query('SELECT * FROM subcontractors ORDER BY id')
      const beforeCois = await db.query('SELECT * FROM cois ORDER BY id')
      const broken: OwnerConnection = { dialect: db.dialect, async query(sql, values) {
        if (sql.startsWith('CREATE TABLE owner_coi_records')) throw new Error('injected migration failure')
        return db.query(sql, values)
      } }
      await assert.rejects(migrateOwnerFoundationV1(broken), /injected/)
      await assert.rejects(db.query('SELECT * FROM owner_subcontractor_connections'))
      await assert.rejects(db.query('SELECT * FROM owner_foundation_schema_migrations'))
      assert.equal(await migrateOwnerFoundationV1(db), 'applied')
      assert.equal(await migrateOwnerFoundationV1(db), 'already-applied')
      assert.deepEqual(await db.query('SELECT * FROM subcontractors ORDER BY id'), beforeSubs)
      assert.deepEqual(await db.query('SELECT * FROM cois ORDER BY id'), beforeCois)
      const one = ownerReads(db, 'gc1'); const two = ownerReads(db, 'gc2')
      assert.deepEqual(await one.listSubcontractors(), [])
      assert.deepEqual(await one.listCois('s1'), [])
      assert.equal(await one.getSubcontractor('legacy'), undefined)
      assert.equal(await one.getCoi('legacy-c'), undefined)
      await db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['s1', 'gc1', 'now'])
      await db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['s2', 'gc2', 'now'])
      // A sub assignment never automatically assigns its old COIs.
      assert.deepEqual(await one.listCois('s1'), [])
      await db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['c1', 's1', 'gc1', 'now'])
      await db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['c2', 's2', 'gc2', 'now'])
      assert.deepEqual((await one.listSubcontractors()).map(x => x.id), ['s1'])
      assert.deepEqual((await two.listSubcontractors()).map(x => x.id), ['s2'])
      assert.deepEqual((await one.listCois('s1')).map(x => x.id), ['c1'])
      assert.equal(await one.getSubcontractor('s2'), undefined)
      assert.equal(await one.getCoi('c2'), undefined)
      assert.equal(await two.getCoi('c1'), undefined)
      assert.equal(await one.getCoi('old-c1'), undefined)
      assert.deepEqual(await two.listCois('s1'), [])
      assert.deepEqual(await ownerReads(db, 'admin').listSubcontractors(), [])
      assert.deepEqual(await ownerReads(db, 'subuser').listSubcontractors(), [])
      assert.deepEqual(await ownerReads(db, 'missing').listSubcontractors(), [])
      assert.throws(() => ownerReads(db, ''), /subject/)
      const projection = await one.getCoi('c1')
      assert.equal(projection?.id, 'c1')
      assert.equal('certificate_key' in projection!, false)
      assert.equal('certificate_url' in projection!, false)
      // Duplicate, orphan, and cross-owner/cross-source assignments must fail.
      await assert.rejects(db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['s1', 'gc1', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['s1', 'gc2', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_subcontractor_connections VALUES (?, ?, ?)', ['missing', 'gc1', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['c1', 's1', 'gc1', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['old-c1', 's1', 'gc2', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['old-c1', 's2', 'gc2', 'now']))
      await assert.rejects(db.query('INSERT INTO owner_coi_records VALUES (?, ?, ?, ?)', ['missing', 's1', 'gc1', 'now']))
      await assert.rejects(db.query('DELETE FROM cois WHERE id = ?', ['c1']))
      await assert.rejects(db.query('DELETE FROM subcontractors WHERE id = ?', ['s1']))
      await db.query('UPDATE users SET role = ? WHERE id = ?', ['sub', 'gc1'])
      assert.deepEqual(await one.listSubcontractors(), [])
      assert.equal(await one.getCoi('c1'), undefined)
      await db.query('UPDATE users SET role = ? WHERE id = ?', ['gc', 'gc1'])
      assert.equal((await one.getCoi('c1'))?.id, 'c1')
      // New source rows are quarantined until explicitly assigned, even with same name/email.
      await db.query("INSERT INTO subcontractors (id, company_name, trade, email) VALUES ('new', 'same', 'trade', 'same@example.test')")
      assert.equal(await one.getSubcontractor('new'), undefined)
      assert.deepEqual(await db.query('SELECT * FROM cois ORDER BY id'), beforeCois)
      await db.query('UPDATE owner_foundation_schema_migrations SET checksum = ?', ['tampered'])
      await assert.rejects(migrateOwnerFoundationV1(db), /history/)
    } finally { await fixture.close() }
  })
}

test('sqlite migration rejects disabled foreign keys before starting', async () => {
  const fixture = await makeSqlite()
  try {
    await fixture.db.query('PRAGMA foreign_keys = OFF')
    await assert.rejects(migrateOwnerFoundationV1(fixture.db), /foreign_keys/)
  } finally { await fixture.close() }
})
