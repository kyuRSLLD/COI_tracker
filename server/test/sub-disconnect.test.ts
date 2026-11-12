import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Never connect these tests to a production or arbitrary database.
const pgUrl = process.env.DISCONNECT_TEST_POSTGRES_URL || ''
if (pgUrl) {
  const url = new URL(pgUrl)
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname))
  assert.match(url.pathname, /^\/coi_disconnect_test_[a-z0-9_]+$/)
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-disconnect-'))
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = pgUrl
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'disconnect-test-secret'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
const { createApp } = await import('../src/app.ts')
const { dbGet, dbRun, dbExec, isPostgres, withTransaction } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

test(`subcontractor disconnect isolation and QR replay (${pgUrl ? 'PostgreSQL' : 'SQLite'})`, async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const now = new Date().toISOString()
  function token(id: string, role = 'sub') {
    return signToken({ id, role, email: `${id}@example.invalid`, name: id })
  }
  async function request(url: string, id: string | null, method = 'GET', body?: object, role = 'sub') {
    const res = await fetch(`${base}${url}`, { method, headers: { ...(id ? { authorization: `Bearer ${token(id, role)}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() as any, cache: res.headers.get('cache-control') }
  }
  async function issue(sub = 'sub1') {
    const result = await request('/api/connection-qr', sub, 'POST', { consent: true })
    assert.equal(result.status, 200)
    return result.body.token as string
  }
  const claim = (gc: string, code: string) => request('/api/connection-qr/redeem', gc, 'POST', { token: code }, 'gc')
  const remove = (sub: string | null, gc: string) => request(`/api/sub/connections/${gc}`, sub, 'DELETE')
  async function connected(gc: string, sub: string) {
    return Boolean(await dbGet('SELECT gc_user_id FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc, sub]))
  }
  try {
    for (const [id, role] of [['sub1','sub'], ['sub2','sub'], ['gc1','gc'], ['gc2','gc'], ['gc3','gc'], ['admin','admin']]) {
      await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.invalid`, 'unused', id, role, now])
    }
    for (const [id, owner] of [['profile1','sub1'], ['profile2','sub2']]) {
      await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, owner, id, 'trade', now, now])
    }
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, effective_date, expiration_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['coi1', 'profile1', 'sub1', 'Carrier', '2026-01-01', '2030-01-01', now, now])
    const old = await issue()
    assert.equal((await claim('gc1', old)).status, 200)
    const code2 = await issue()
    assert.equal((await claim('gc2', code2)).status, 200)
    const other = await issue('sub2')
    assert.equal((await claim('gc3', other)).status, 200)
    let dashboard = await request('/api/sub/my', 'sub1')
    assert.deepEqual(dashboard.body.connected_gcs.map((gc: any) => gc.gc_id).sort(), ['gc1', 'gc2'])
    assert.equal(dashboard.cache, 'no-store')
    assert.equal((await remove(null, 'gc1')).status, 401)
    assert.equal((await remove('gc1', 'gc1')).status, 403) // actual DB role wins over JWT role
    assert.equal((await remove('admin', 'gc1')).status, 403)
    assert.equal((await remove('sub2', 'gc1')).status, 404)
    assert.equal((await remove('sub1', 'gc3')).status, 404)
    assert.ok(await connected('gc1', 'profile1'))
    assert.equal((await request('/api/cois/coi1', 'gc1', 'GET', undefined, 'gc')).status, 200)
    const unused = await issue()
    const otherUnused = await issue('sub2')
    const deletion = await remove('sub1', 'gc1')
    assert.deepEqual(deletion.body, { success: true })
    assert.equal(deletion.cache, 'no-store')
    assert.equal((await remove('sub1', 'gc1')).status, 404)
    assert.equal((await request('/api/cois/coi1', 'gc1', 'GET', undefined, 'gc')).status, 404)
    assert.equal((await request('/api/subcontractors/profile1', 'gc1', 'GET', undefined, 'gc')).status, 404)
    assert.equal((await request('/api/cois/coi1', 'gc2', 'GET', undefined, 'gc')).status, 200)
    assert.ok(await dbGet('SELECT id FROM cois WHERE id = ?', ['coi1']))
    assert.ok(await connected('gc2', 'profile1'))
    assert.ok(await connected('gc3', 'profile2'))
    assert.equal((await claim('gc1', old)).status, 404)
    assert.equal((await claim('gc1', unused)).status, 404)
    assert.equal((await claim('gc1', otherUnused)).status, 200)
    assert.equal(await connected('gc1', 'profile1'), false)
    dashboard = await request('/api/sub/my', 'sub1')
    assert.deepEqual(dashboard.body.connected_gcs.map((gc: any) => gc.gc_id), ['gc2'])

    // Concurrent replays of an already-redeemed code and unlink must serialize:
    // a replay may finish first, but cannot recreate a link after deletion.
    for (let i = 0; i < 8; i++) {
      const fresh = await issue()
      assert.equal((await claim('gc1', fresh)).status, 200)
      const results = await Promise.all([remove('sub1', 'gc1'), ...Array.from({ length: 5 }, () => claim('gc1', fresh))])
      assert.equal(results[0].status, 200)
      for (const result of results.slice(1)) assert.ok([200, 404].includes(result.status))
      assert.equal(await connected('gc1', 'profile1'), false)
      assert.equal((await claim('gc1', fresh)).status, 404)
    }

    // A brand-new, still unused code cannot race deletion and restore access
    // after a successful removal, whichever transaction acquires locks first.
    for (let i = 0; i < 8; i++) {
      const linkedCode = await issue()
      assert.equal((await claim('gc1', linkedCode)).status, 200)
      const pending = await issue()
      const [deleted, racedClaim] = await Promise.all([remove('sub1', 'gc1'), claim('gc1', pending)])
      assert.ok([200, 409].includes(deleted.status))
      assert.ok([200, 404].includes(racedClaim.status))
      if (deleted.status === 409) assert.equal((await remove('sub1', 'gc1')).status, 200)
      assert.equal(await connected('gc1', 'profile1'), false)
      assert.equal((await claim('gc1', pending)).status, 404)
    }

    if (isPostgres) {
      // Force the token-first/user-second contention used by redemption. The
      // unlink must fail quickly without deleting the link or revoking code.
      const lockedCode = await issue()
      let release!: () => void
      let locked!: () => void
      const lockReady = new Promise<void>(resolve => { locked = resolve })
      const lockRelease = new Promise<void>(resolve => { release = resolve })
      const holding = withTransaction(async tx => {
        const hash = createHash('sha256').update(lockedCode).digest('hex')
        await tx.get('SELECT token_hash FROM sub_connection_qr_tokens WHERE token_hash = ? FOR UPDATE', [hash])
        locked()
        await lockRelease
      })
      await lockReady
      try {
        assert.equal((await remove('sub1', 'gc2')).status, 409)
        assert.ok(await connected('gc2', 'profile1'))
      } finally {
        release()
        await holding
      }
      assert.equal((await claim('gc1', lockedCode)).status, 200)
    }

    // A failure after deleting the link rolls the deletion back as well.
    const rollbackCode = await issue()
    if (isPostgres) {
      await dbExec(`CREATE FUNCTION disconnect_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$;
        CREATE TRIGGER disconnect_test_fail BEFORE UPDATE OF revoked_at ON sub_connection_qr_tokens FOR EACH ROW EXECUTE FUNCTION disconnect_test_fail();`)
    } else {
      await dbExec(`CREATE TRIGGER disconnect_test_fail BEFORE UPDATE OF revoked_at ON sub_connection_qr_tokens BEGIN SELECT RAISE(ABORT, 'test'); END;`)
    }
    assert.deepEqual((await remove('sub1', 'gc2')).body, { error: 'Unable to remove connection' })
    assert.ok(await connected('gc2', 'profile1'))
    await dbExec(isPostgres ? 'DROP TRIGGER disconnect_test_fail ON sub_connection_qr_tokens; DROP FUNCTION disconnect_test_fail();' : 'DROP TRIGGER disconnect_test_fail;')
    assert.equal((await claim('gc1', rollbackCode)).status, 200)
    assert.equal((await remove('sub1', 'gc2')).status, 200)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
