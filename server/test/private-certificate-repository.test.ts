import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import express from 'express'
import pg from 'pg'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migratePrivateCertificateMetadataV1 } from '../src/db/migrations/003_private_certificate_metadata.ts'
import { privateCertificateRepository } from '../src/services/privateCertificateRepository.ts'
import { privateCertificatesRouter } from '../src/routes/privateCertificates.ts'
import { PrivateCertificateStorage } from '../src/services/privateCertificateStorage.ts'

const url = process.env.CERTIFICATE_TEST_PG_URL
if (!url) throw new Error('CERTIFICATE_TEST_PG_URL must name a disposable local PostgreSQL 16 database')
const parsed = new URL(url)
if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/certificate_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search) throw new Error('Disposable loopback certificate_test_* database without URL options required')
const record = { key: `private-certificates/${'a'.repeat(64)}`, mime: 'application/pdf' as const, size: 25 }

test('synthetic PostgreSQL: explicit ownership only, immutable metadata, no document grant inference', async () => {
  const schema = `cert_test_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS n")
    assert.ok(version.rows[0].n >= 160000 && version.rows[0].n < 170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` })
    await pool.query(`CREATE TABLE users(id text PRIMARY KEY, role text NOT NULL);
      CREATE TABLE subcontractors(id text PRIMARY KEY);
      CREATE TABLE cois(id text PRIMARY KEY, subcontractor_id text NOT NULL);
      INSERT INTO users VALUES ('sub1','sub'),('sub2','sub'),('gc1','gc');
      INSERT INTO subcontractors VALUES ('s1'),('s2');
      INSERT INTO cois VALUES ('c1','s1'),('unmapped','s1'),('c2','s2');`)
    const client = await pool.connect()
    try {
      await migrateGcSubConsentV1(client)
      await client.query('CREATE TABLE private_certificate_metadata(dummy int)')
      await assert.rejects(migratePrivateCertificateMetadataV1(client))
      const failed = await client.query("SELECT to_regclass('private_certificate_schema_migrations') AS ledger")
      assert.equal(failed.rows[0].ledger, null)
      await client.query('DROP TABLE private_certificate_metadata')
      assert.equal(await migratePrivateCertificateMetadataV1(client), 'applied')
      assert.equal(await migratePrivateCertificateMetadataV1(client), 'already-applied')
    } finally { client.release() }
    const p1 = randomUUID(), p2 = randomUUID()
    await pool.query(`INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference)
      VALUES($1,'s1','sub1',now(),'evidence'),($2,'s2','sub2',now(),'evidence')`, [p1,p2])
    await pool.query(`INSERT INTO gc_sub_coi_ownership VALUES('c1',$1,'s1',now(),'evidence'),('c2',$2,'s2',now(),'evidence')`, [p1,p2])
    await pool.query(`INSERT INTO gc_sub_grants VALUES($1,'gc1','share-current-and-future-coi-v1',now(),now(),NULL)`, [p1])
    const owner = privateCertificateRepository(pool, 'sub1')
    const other = privateCertificateRepository(pool, 'sub2')
    const gc = privateCertificateRepository(pool, 'gc1')
    assert.equal(await owner.authorized('c1'), true)
    for (const [repo, id] of [[owner,'unmapped'],[owner,'c2'],[other,'c1'],[gc,'c1']] as const) {
      assert.equal(await repo.authorized(id), false)
      assert.equal(await repo.records.get(id), null)
      await assert.rejects(repo.records.create(id, record))
    }
    await owner.records.create('c1', record)
    assert.deepEqual(await owner.records.get('c1'), record)
    assert.equal(await gc.records.get('c1'), null)
    assert.equal(await owner.authorized("c1' OR true --"), false)
    await assert.rejects(other.records.create('c2', record)) // object keys cannot be reused across certificates
    await assert.rejects(other.records.create('c2', { ...record, key: '../attacker-key' }))
    await assert.rejects(other.records.create('c2', { ...record, key: `private-certificates/${'b'.repeat(64)}`, size: 10485761 }))
    await assert.rejects(owner.records.create('c1', { ...record, key: `private-certificates/${'b'.repeat(64)}` }))
    // Full wiring: real synthetic PostgreSQL queries and only an in-memory S3 mock.
    await pool.query(`INSERT INTO gc_sub_grants VALUES($1,'gc1','share-current-and-future-coi-v1',now(),now(),NULL)`, [p2])
    const objects = new Map<string, { body: Buffer; mime: string }>()
    const s3 = {
      async put(command: any) { objects.set(command.input.Key, { body: Buffer.from(command.input.Body), mime: command.input.ContentType }) },
      async get(command: any) { const obj = objects.get(command.input.Key)!; return { Body: Readable.from([obj.body]), ContentLength: obj.body.length, ContentType: obj.mime } },
    }
    const app = express()
    app.use('/private', privateCertificatesRouter({ enabled: true, pool, verifiedMiddleware: (req: any, _res, next) => {
      if (req.headers.authorization === 'sub2') req.securePrincipal = { subject:'sub2', role:'sub', credential:'verified-test' }
      if (req.headers.authorization === 'gc1') req.securePrincipal = { subject:'gc1', role:'gc', credential:'verified-test' }
      next()
    }, makeStorage: ({ records, authorize }) => new PrivateCertificateStorage({ enabled:true, bucket:'test-private-certificates', records, authorize, s3 }) }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as any).port}/private/c2`
      const payload = Buffer.from('%PDF-1.7\nsynthetic')
      const up = await fetch(base, { method:'PUT', headers:{ authorization:'sub2', 'content-type':'application/pdf' }, body:payload })
      assert.equal(up.status,201); assert.deepEqual(await up.json(), { mime:'application/pdf', size:payload.length })
      assert.equal((await fetch(base, { headers:{ authorization:'gc1' } })).status,503)
      const down = await fetch(base, { headers:{ authorization:'sub2' } })
      assert.equal(down.status,200); assert.deepEqual(Buffer.from(await down.arrayBuffer()),payload)
      await pool.query('UPDATE gc_sub_profiles SET revoked_at=now() WHERE id=$1', [p2])
      assert.equal((await fetch(base, { headers:{ authorization:'sub2' } })).status,404)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await assert.rejects(pool.query("UPDATE private_certificate_metadata SET byte_size=2 WHERE coi_id='c1'"), /immutable/)
    await assert.rejects(pool.query("DELETE FROM private_certificate_metadata WHERE coi_id='c1'"), /immutable/)
    await pool.query("UPDATE users SET role='admin' WHERE id='sub1'")
    assert.equal(await owner.authorized('c1'), false)
    assert.equal(await owner.records.get('c1'), null)
    await pool.query("UPDATE users SET role='sub' WHERE id='sub1'")
    assert.equal(await owner.authorized('c1'), true)
    await pool.query('UPDATE gc_sub_profiles SET revoked_at=now() WHERE id=$1', [p1])
    assert.equal(await owner.authorized('c1'), false)
    await assert.rejects(owner.records.create('c1', record))
    await pool.query("UPDATE private_certificate_schema_migrations SET checksum='changed'")
    const c = await pool.connect()
    try { await assert.rejects(migratePrivateCertificateMetadataV1(c), /history/) } finally { c.release() }
  } finally {
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
