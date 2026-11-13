// Opt in: PG_COI_FIELDS_TEST=1 node --experimental-strip-types --test test/coi-fields-postgres.test.ts
// Starts its own loopback-only PostgreSQL cluster; never uses an inherited database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const enabled = process.env.PG_COI_FIELDS_TEST === '1'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve()))
  return address.port
}

test('review writes serialize with document replacement (disposable PostgreSQL)', { skip: !enabled, timeout: 60_000 }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'coi-fields-pg-'))
  const bin = process.env.PG_COI_FIELDS_TEST_BIN || '/usr/lib/postgresql/16/bin'
  const command = (name: string, args: string[]) => execFileSync(path.join(bin, name), args, { stdio: 'pipe' })
  const port = await freePort()
  let started = false
  let server: import('node:http').Server | undefined
  let writer: pg.Client | undefined
  let monitor: pg.Client | undefined
  const pools: pg.Pool[] = []
  const OriginalPool = pg.Pool
  const originalQuery = pg.Client.prototype.query
  let hook: { reached: () => void; release: Promise<void> } | undefined
  let getHook: { reached: () => void; release: Promise<void> } | undefined
  let writeHook: { reached: () => void; release: Promise<void> } | undefined
  ;(pg.Client.prototype as any).query = function (...args: any[]) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    const result = (originalQuery as any).apply(this, args)
    const current = hook
    if (current && /^SELECT id FROM cois WHERE id = \$1 FOR UPDATE$/i.test(sql.trim()) && result && typeof result.then === 'function') {
      hook = undefined
      return result.then(async (value: unknown) => { current.reached(); await current.release; return value })
    }
    const currentWrite = writeHook
    if (currentWrite && sql.includes('INSERT INTO coi_field_reviews (coi_id, source_tag, details_json)') && result && typeof result.then === 'function') {
      writeHook = undefined
      return result.then(async (value: unknown) => { currentWrite.reached(); await currentWrite.release; return value })
    }
    return result
  }
  pg.Pool = class TestPool extends OriginalPool {
    constructor(config: pg.PoolConfig) { super(config); pools.push(this) }
  }
  ;(pg.Pool.prototype as any).query = function (...args: any[]) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    const result = (OriginalPool.prototype.query as any).apply(this, args)
    const current = getHook
    if (current && sql.includes('LEFT JOIN coi_field_reviews r') && result && typeof result.then === 'function') {
      getHook = undefined
      return result.then(async (value: unknown) => { current.reached(); await current.release; return value })
    }
    return result
  }
  try {
    command('initdb', ['-D', path.join(temp, 'data'), '-A', 'trust', '-U', userInfo().username, '--no-locale', '--encoding=UTF8'])
    command('pg_ctl', ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -k ${temp} -p ${port}`, '-w', 'start'])
    started = true
    command('createdb', ['-h', '127.0.0.1', '-p', String(port), 'coi_fields_disposable'])
    process.env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/coi_fields_disposable`
    process.env.NODE_ENV = 'test'
    process.env.JWT_SECRET = 'coi-fields-pg-test-only'
    // Presigning uses isolated fake credentials and does not contact AWS.
    process.env.AWS_S3_BUCKET = 'coi-fields-test-bucket'
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'TESTONLYACCESSKEY'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-only-not-a-real-secret-key'
    process.env.AWS_S3_ENDPOINT = ''
    const { createApp } = await import('../src/app.ts')
    const { dbRun, isPostgres } = await import('../src/db/db.ts')
    const { signToken } = await import('../src/middleware/auth.ts')
    assert.equal(isPostgres, true)
    const app = await createApp()
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    writer = new pg.Client({ connectionString: process.env.DATABASE_URL })
    monitor = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await writer.connect()
    await monitor.connect()
    const now = '2026-01-01T00:00:00.000Z'
    await dbRun('INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES (?,?,?,?,?,?)', ['gc','gc@example.test','unused','GC','gc',now])
    await dbRun('INSERT INTO subcontractors (id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?)', ['profile','Profile','Trade',now,now])
    await dbRun('INSERT INTO gc_sub_connections (gc_user_id,subcontractor_id,created_at) VALUES (?,?,?)', ['gc','profile',now])
    await dbRun(`INSERT INTO cois (id,subcontractor_id,owner_gc_user_id,carrier,effective_date,expiration_date,certificate_key,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, ['coi','profile','gc','Carrier','','','cois/one',now,now])
    const token = signToken({ id: 'gc', role: 'gc', email: 'gc@example.test', name: 'GC' })
    async function get() {
      const response = await fetch(`${base}/api/coi-fields/coi`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { status: response.status, body: await response.json() as any }
    }
    async function put(tag: string, revision: string, name: string) {
      const response = await fetch(`${base}/api/coi-fields/coi`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sourceTag: tag, reviewRevision: revision, details: { insured: { name } } }), signal: AbortSignal.timeout(12_000) })
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return { status: response.status, body: await response.json() as any }
    }
    async function waitLock(fragment: string) {
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const found = await monitor!.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE $1 AND cardinality(pg_blocking_pids(pid)) > 0`, [`%${fragment}%`])
        if (found.rowCount) return
        await delay(20)
      }
      throw new Error(`Expected lock waiter: ${fragment}`)
    }
    // Preexisting review rows need no migration or version backfill.
    const empty = await get()
    assert.equal(empty.body.reviewRevision, 'no-review')
    await writer.query('INSERT INTO coi_field_reviews (coi_id,source_tag,details_json) VALUES ($1,$2,$3)',
      ['coi', empty.body.sourceTag, JSON.stringify({ insured: { name: 'legacy' } })])
    const [tab1, tab2] = await Promise.all([get(), get()])
    assert.deepEqual(tab1.body.details, { insured: { name: 'legacy' } })
    assert.equal(tab1.body.reviewRevision, 'no-review')
    assert.equal(tab1.body.reviewRevision, tab2.body.reviewRevision)
    assert.equal(new URL(tab1.body.certificateUrl).pathname, '/coi-fields-test-bucket/cois/one')
    assert.ok(new URL(tab1.body.certificateUrl).searchParams.has('X-Amz-Signature'))
    assert.equal(Object.hasOwn(tab1.body, 'certificate_key'), false)
    const saves = await Promise.all([put(tab1.body.sourceTag, tab1.body.reviewRevision, 'one'), put(tab2.body.sourceTag, tab2.body.reviewRevision, 'two')])
    assert.deepEqual(saves.map(v => v.status).sort(), [200, 409])
    const winner = saves.find(v => v.status === 200)!
    assert.notEqual(winner.body.reviewRevision, tab1.body.reviewRevision)
    assert.equal(new URL(winner.body.certificateUrl).pathname, '/coi-fields-test-bucket/cois/one')
    assert.equal((await get()).body.reviewRevision, winner.body.reviewRevision)
    // Hold a GET after its one authorized SELECT, replace the certificate, then
    // release signing. The tag and URL must both use the captured old row.
    let getReached!: () => void
    let getRelease!: () => void
    const getReady = new Promise<void>(resolve => { getReached = resolve })
    const getGate = new Promise<void>(resolve => { getRelease = resolve })
    getHook = { reached: getReached, release: getGate }
    const snapshotRequest = get()
    try {
      await Promise.race([getReady, delay(5000).then(() => { throw new Error('GET snapshot not reached') })])
      await writer.query('UPDATE cois SET certificate_key = $1 WHERE id = $2', ['cois/race','coi'])
    } finally { getRelease() }
    const snapshot = await snapshotRequest
    assert.equal(snapshot.body.sourceTag, winner.body.sourceTag)
    assert.equal(snapshot.body.reviewRevision, winner.body.reviewRevision)
    assert.deepEqual(snapshot.body.details, winner.body.details)
    assert.equal(new URL(snapshot.body.certificateUrl).pathname, '/coi-fields-test-bucket/cois/one')
    const raced = await get()
    assert.notEqual(raced.body.sourceTag, snapshot.body.sourceTag)
    assert.equal(raced.body.details, null)
    assert.equal(new URL(raced.body.certificateUrl).pathname, '/coi-fields-test-bucket/cois/race')
    await writer.query('UPDATE cois SET certificate_key = $1 WHERE id = $2', ['cois/one','coi'])
    // Revision tokens advance for every successful write, including X -> Y ->
    // X and a duplicate write with unchanged content.
    const abaStart = await get()
    const x1 = await put(abaStart.body.sourceTag, abaStart.body.reviewRevision, 'X')
    const y = await put(x1.body.sourceTag, x1.body.reviewRevision, 'Y')
    const x2 = await put(y.body.sourceTag, y.body.reviewRevision, 'X')
    assert.deepEqual([x1.status, y.status, x2.status], [200, 200, 200])
    assert.equal(new Set([x1.body.reviewRevision, y.body.reviewRevision, x2.body.reviewRevision]).size, 3)
    assert.equal((await put(x1.body.sourceTag, x1.body.reviewRevision, 'stale')).status, 409)
    const duplicate = await put(x2.body.sourceTag, x2.body.reviewRevision, 'X')
    assert.equal(duplicate.status, 200)
    assert.notEqual(duplicate.body.reviewRevision, x2.body.reviewRevision)
    assert.equal((await put(x2.body.sourceTag, x2.body.reviewRevision, 'X')).status, 409)
    // Pause after the review upsert but before its version upsert. A concurrent
    // GET must see the old details and old revision from one database snapshot.
    let writeReached!: () => void
    let writeRelease!: () => void
    const writeReady = new Promise<void>(resolve => { writeReached = resolve })
    const writeGate = new Promise<void>(resolve => { writeRelease = resolve })
    writeHook = { reached: writeReached, release: writeGate }
    const atomicSave = put(duplicate.body.sourceTag, duplicate.body.reviewRevision, 'atomic-new')
    let atomicResult: Awaited<ReturnType<typeof put>>
    try {
      await Promise.race([writeReady, delay(5000).then(() => { throw new Error('Review write was not reached') })])
      const during = await get()
      assert.deepEqual(during.body.details, duplicate.body.details)
      assert.equal(during.body.reviewRevision, duplicate.body.reviewRevision)
    } finally { writeRelease() }
    atomicResult = await atomicSave
    assert.equal(atomicResult.status, 200)
    const afterAtomic = await get()
    assert.deepEqual(afterAtomic.body.details, atomicResult.body.details)
    assert.equal(afterAtomic.body.reviewRevision, atomicResult.body.reviewRevision)
    // Force the second child write to fail and verify the first is rolled back.
    await writer.query(`CREATE FUNCTION fail_review_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test-only failure'; END $$`)
    await writer.query(`CREATE TRIGGER fail_review_version BEFORE INSERT OR UPDATE ON coi_field_review_versions
      FOR EACH ROW EXECUTE FUNCTION fail_review_version()`)
    try {
      const failed = await put(afterAtomic.body.sourceTag, afterAtomic.body.reviewRevision, 'must roll back')
      assert.equal(failed.status, 500)
      assert.deepEqual(failed.body, { error: 'Unable to save field review' })
      const afterFailure = await get()
      assert.deepEqual(afterFailure.body.details, afterAtomic.body.details)
      assert.equal(afterFailure.body.reviewRevision, afterAtomic.body.reviewRevision)
    } finally {
      await writer.query('DROP TRIGGER fail_review_version ON coi_field_review_versions')
      await writer.query('DROP FUNCTION fail_review_version()')
    }
    assert.equal((await put(afterAtomic.body.sourceTag, afterAtomic.body.reviewRevision, 'after rollback')).status, 200)
    const before = await get()
    assert.equal(before.status, 200)
    // Replacement locks first: PUT must wait, see the committed new key, and
    // reject the old tag instead of writing review fields for the wrong file.
    await writer.query('BEGIN')
    await writer.query('UPDATE cois SET certificate_key = $1 WHERE id = $2', ['cois/two','coi'])
    const pending = put(before.body.sourceTag, before.body.reviewRevision, 'old review')
    await waitLock('SELECT id FROM cois WHERE id')
    await writer.query('COMMIT')
    assert.equal((await pending).status, 409)
    const after = await get()
    assert.notEqual(after.body.sourceTag, before.body.sourceTag)
    assert.equal(after.body.details, null)
    // Review locks first: a concurrent replacement must wait until it commits;
    // once replacement commits the review is immediately stale on subsequent GET.
    let reached!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { reached = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    hook = { reached, release: gate }
    const first = put(after.body.sourceTag, after.body.reviewRevision, 'new review')
    try {
      await Promise.race([ready, delay(5000).then(() => { throw new Error('Review lock was not reached') })])
      const replacement = writer.query('UPDATE cois SET certificate_key = $1 WHERE id = $2', ['cois/three','coi'])
      await waitLock('UPDATE cois SET certificate_key')
      release()
      const saved = await first
      assert.equal(saved.status, 200)
      assert.equal(saved.body.sourceTag, after.body.sourceTag)
      assert.equal(new URL(saved.body.certificateUrl).pathname, '/coi-fields-test-bucket/cois/two')
      await replacement
    } finally { release() }
    const final = await get()
    assert.equal(final.body.details, null)
    assert.notEqual(final.body.sourceTag, after.body.sourceTag)
    assert.equal((await put(after.body.sourceTag, after.body.reviewRevision, 'too late')).status, 409)
    await writer.query('UPDATE cois SET certificate_key = NULL WHERE id = $1', ['coi'])
    const noDocument = await get()
    assert.equal(noDocument.body.details, null)
    assert.equal(noDocument.body.certificateUrl, null)
    const noDocumentSave = await put(noDocument.body.sourceTag, noDocument.body.reviewRevision, 'manual without file')
    assert.equal(noDocumentSave.status, 200)
    await writer.query('UPDATE cois SET certificate_key = $1, certificate_url = $2 WHERE id = $3', ['../secret-key','https://legacy.invalid/private','coi'])
    const invalidKey = await get()
    assert.equal(invalidKey.body.certificateUrl, null)
    assert.ok(!JSON.stringify(invalidKey.body).includes('secret-key'))
    assert.ok(!JSON.stringify(invalidKey.body).includes('legacy.invalid'))
    // A disconnect which obtains the connection lock first invalidates the
    // discovery read; the subsequent write must not go through after commit.
    await writer.query('BEGIN')
    await writer.query('DELETE FROM gc_sub_connections WHERE gc_user_id = $1 AND subcontractor_id = $2', ['gc', 'profile'])
    const disconnectedWrite = put(noDocument.body.sourceTag, noDocument.body.reviewRevision, 'must not persist')
    await waitLock('SELECT gc_user_id FROM gc_sub_connections')
    await writer.query('COMMIT')
    assert.equal((await disconnectedWrite).status, 404)
    assert.equal((await get()).status, 404)
    const persisted = await writer.query(`SELECT r.details_json, v.revision FROM coi_field_reviews r
      JOIN coi_field_review_versions v ON v.coi_id = r.coi_id WHERE r.coi_id = $1`, ['coi'])
    assert.equal(persisted.rows[0].revision, noDocumentSave.body.reviewRevision)
    assert.deepEqual(JSON.parse(persisted.rows[0].details_json), noDocumentSave.body.details)
    await writer.query('DELETE FROM cois WHERE id = $1', ['coi'])
    assert.equal((await writer.query('SELECT 1 FROM coi_field_reviews WHERE coi_id = $1', ['coi'])).rowCount, 0)
    assert.equal((await writer.query('SELECT 1 FROM coi_field_review_versions WHERE coi_id = $1', ['coi'])).rowCount, 0)
  } finally {
    hook = undefined
    getHook = undefined
    writeHook = undefined
    ;(pg.Client.prototype as any).query = originalQuery
    pg.Pool = OriginalPool
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    if (writer) await writer.end().catch(() => {})
    if (monitor) await monitor.end().catch(() => {})
    await Promise.all(pools.map(pool => pool.end().catch(() => {})))
    if (started) command('pg_ctl', ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
    await rm(temp, { recursive: true, force: true })
  }
})
