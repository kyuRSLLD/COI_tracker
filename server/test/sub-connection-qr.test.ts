import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// PostgreSQL is opt-in and restricted to an explicitly named disposable local DB.
const pgUrl = process.env.QR_TEST_POSTGRES_URL || ''
if (pgUrl) {
  const url = new URL(pgUrl)
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname))
  assert.match(url.pathname, /^\/coi_qr_test_[a-z0-9_]+$/)
}
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-qr-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = pgUrl
process.env.NODE_ENV = 'test'
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.JWT_SECRET = 'test-only-secret'

const { createApp } = await import('../src/app.ts')
const { dbGet, dbAll, dbRun, dbExec, isPostgres } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

test(`subcontractor connection QR security and transactions (${pgUrl ? 'PostgreSQL' : 'SQLite'})`, async () => {
  const app = await createApp()
  // Rerunning initialization must not damage the new table or existing data.
  await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const now = new Date().toISOString()
  const session = (id: string, role = 'gc') => signToken({ id, role, email: `${id}@example.test`, name: id })
  async function post(endpoint: string, id: string | null, body: any, role = 'gc') {
    const response = await fetch(`${base}/api/connection-qr${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(id ? { authorization: `Bearer ${session(id, role)}` } : {}) }, body: JSON.stringify(body),
    })
    assert.match(response.headers.get('cache-control') || '', /no-store/)
    return { status: response.status, body: await response.json() as any }
  }
  async function issue(id = 'sub1') {
    const result = await post('', id, { consent: true })
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.body).sort(), ['expiresAt', 'token'])
    assert.match(result.body.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(result.body.token, 'base64url').length, 32)
    const remaining = Date.parse(result.body.expiresAt) - Date.now()
    assert.ok(remaining > 14 * 60 * 1000 && remaining <= 15 * 60 * 1000)
    return result.body.token as string
  }
  async function linkCount(gc: string, sub = 'profile1') {
    const row = await dbGet<any>('SELECT COUNT(*) AS n FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc, sub])
    return Number(row.n)
  }
  try {
    for (const [id, role] of [['sub1','sub'], ['sub2','sub'], ['noowner','sub'], ['gc1','gc'], ['gc2','gc'], ['gc3','gc'], ['admin','admin']]) {
      await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, 'unused', id, role, now])
    }
    for (const [id, owner] of [['profile1','sub1'], ['profile2','sub2'], ['legacy',null]] as const) {
      await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, owner, id, 'Trade', now, now])
    }
    // Pointer, email, and body-supplied ID do not prove ownership.
    await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', ['profile1', 'noowner'])
    assert.equal((await post('', null, { consent: true })).status, 401)
    assert.equal((await post('', 'gc1', { consent: true }, 'sub')).status, 403)
    assert.equal((await post('', 'admin', { consent: true }, 'sub')).status, 403)
    assert.equal((await post('', 'noowner', { consent: true })).status, 404)
    for (const consent of [undefined, false, 'true', 1, null]) assert.equal((await post('', 'sub1', { consent })).status, 400)
    assert.equal((await post('', 'sub2', { consent: true, subcontractor_id: 'profile1' })).status, 400)
    const sub2Token = await issue('sub2')
    const sub2Claim = await post('/redeem', 'gc3', { token: sub2Token })
    assert.deepEqual(sub2Claim.body.subcontractor, { id: 'profile2', company_name: 'profile2' })
    assert.equal(await linkCount('gc3'), 0)

    const token = await issue()
    const stored = await dbGet<any>('SELECT * FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(token)])
    assert.equal(stored.issuer_user_id, 'sub1')
    assert.equal(JSON.stringify(stored).includes(token), false)
    await Promise.all([createApp(), createApp()])
    assert.equal((await dbGet<any>('SELECT issuer_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(token)])).issuer_user_id, 'sub1')
    assert.equal((await post('/redeem', null, { token })).status, 401)
    assert.equal((await post('/redeem', 'sub2', { token }, 'gc')).status, 403)
    assert.equal((await post('/redeem', 'gc1', { token: 'invalid' })).status, 400)
    const anonymousGet = await fetch(`${base}/api/connection-qr/${token}`)
    assert.equal(anonymousGet.status, 401)
    assert.match(anonymousGet.headers.get('cache-control') || '', /no-store/)
    assert.equal((await anonymousGet.text()).includes('profile1'), false)
    const signedInGet = await fetch(`${base}/api/connection-qr/${token}`, { headers: { authorization: `Bearer ${session('gc1')}` } })
    assert.equal(signedInGet.status, 404)
    assert.equal((await signedInGet.text()).includes(token), false)

    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, effective_date, expiration_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['coi1', 'profile1', 'sub1', 'Carrier', '2025-01-01', '2030-01-01', now, now])
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, effective_date, expiration_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['other-coi', 'profile1', 'sub2', 'Carrier', '2025-01-01', '2030-01-01', now, now])
    assert.equal((await fetch(`${base}/api/subcontractors/profile1`, { headers: { authorization: `Bearer ${session('gc1')}` } })).status, 404)
    const claim = await post('/redeem', 'gc1', { token })
    assert.deepEqual(claim.body, { success: true, subcontractor: { id: 'profile1', company_name: 'profile1' } })
    assert.equal(claim.status, 200)
    const details = await (await fetch(`${base}/api/subcontractors/profile1`, { headers: { authorization: `Bearer ${session('gc1')}` } })).json() as any
    assert.deepEqual(details.subcontractor.cois.map((c: any) => c.id), ['coi1'])
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, effective_date, expiration_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['future-coi', 'profile1', 'sub1', 'Carrier', '2025-01-01', '2030-01-01', now, now])
    const again = await (await fetch(`${base}/api/subcontractors/profile1`, { headers: { authorization: `Bearer ${session('gc1')}` } })).json() as any
    assert.deepEqual(again.subcontractor.cois.map((c: any) => c.id).sort(), ['coi1', 'future-coi'])
    assert.equal((await post('/redeem', 'gc1', { token })).status, 200)
    assert.equal((await post('/redeem', 'gc2', { token })).status, 404)
    assert.equal((await post('/revoke', 'sub1', { token })).status, 404)
    assert.equal(await linkCount('gc2'), 0)
    // Removing a connection cannot be undone by replay of a used code.
    await dbRun('DELETE FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc1', 'profile1'])
    assert.equal((await post('/redeem', 'gc1', { token })).status, 404)
    assert.equal(await linkCount('gc1'), 0)

    const revoke = await issue()
    assert.equal((await post('/revoke', 'sub2', { token: revoke })).status, 404)
    assert.equal((await post('/revoke', 'sub1', { token: revoke })).status, 200)
    assert.equal((await post('/revoke', 'sub1', { token: revoke })).status, 200)
    assert.equal((await post('/redeem', 'gc1', { token: revoke })).status, 404)
    const expired = await issue()
    await dbRun('UPDATE sub_connection_qr_tokens SET expires_at = ? WHERE token_hash = ?', ['2000-01-01T00:00:00.000Z', digest(expired)])
    assert.equal((await post('/redeem', 'gc1', { token: expired })).status, 404)

    const changedOwner = await issue()
    await dbRun('UPDATE subcontractors SET user_id = ? WHERE id = ?', ['sub2', 'profile1'])
    assert.equal((await post('/redeem', 'gc1', { token: changedOwner })).status, 404)
    await dbRun('UPDATE subcontractors SET user_id = ? WHERE id = ?', ['sub1', 'profile1'])
    const changedIssuerRole = await issue()
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', 'sub1'])
    assert.equal((await post('/redeem', 'gc1', { token: changedIssuerRole })).status, 404)
    assert.equal((await post('', 'sub1', { consent: true }, 'sub')).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', 'sub1'])
    const changedGcRole = await issue()
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', 'gc1'])
    assert.equal((await post('/redeem', 'gc1', { token: changedGcRole }, 'gc')).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', 'gc1'])

    // A pre-existing link to somebody else must not count as a link to this GC.
    await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['gc3', 'profile1', now])
    const concurrent = await issue()
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => post('/redeem', i % 2 ? 'gc1' : 'gc2', { token: concurrent })))
    const winner = await dbGet<any>('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(concurrent)])
    assert.ok(['gc1', 'gc2'].includes(winner.redeemed_by_gc_user_id))
    claims.forEach((r, i) => assert.equal(r.status, (i % 2 ? 'gc1' : 'gc2') === winner.redeemed_by_gc_user_id ? 200 : 404))
    assert.equal(await linkCount(winner.redeemed_by_gc_user_id), 1)
    assert.equal(await linkCount(winner.redeemed_by_gc_user_id === 'gc1' ? 'gc2' : 'gc1'), 0)
    assert.equal(await linkCount('gc3'), 1)
    // New code against the same pre-existing exact pair can be consumed.
    const existing = await issue()
    assert.equal((await post('/redeem', 'gc3', { token: existing })).status, 200)
    assert.equal((await post('/redeem', 'gc2', { token: existing })).status, 404)

    // Force a database failure after insertion, proving that it rolls back.
    const rollback = await issue('sub2')
    if (isPostgres) {
      await dbExec(`CREATE FUNCTION qr_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
        CREATE TRIGGER qr_test_fail BEFORE UPDATE OF redeemed_by_gc_user_id ON sub_connection_qr_tokens FOR EACH ROW EXECUTE FUNCTION qr_test_fail();`)
    } else {
      await dbExec(`CREATE TRIGGER qr_test_fail BEFORE UPDATE OF redeemed_by_gc_user_id ON sub_connection_qr_tokens BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
    }
    assert.deepEqual(await post('/redeem', 'gc2', { token: rollback }), { status: 500, body: { error: 'Unable to redeem connection code' } })
    assert.equal(await linkCount('gc2', 'profile2'), 0)
    assert.equal((await dbGet<any>('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(rollback)])).redeemed_by_gc_user_id, null)
    await dbExec(isPostgres ? 'DROP TRIGGER qr_test_fail ON sub_connection_qr_tokens; DROP FUNCTION qr_test_fail();' : 'DROP TRIGGER qr_test_fail;')
    assert.equal((await post('/redeem', 'gc2', { token: rollback })).status, 200)

    const race = await issue()
    const [r1, r2] = await Promise.all([post('/revoke', 'sub1', { token: race }), post('/redeem', 'gc2', { token: race })])
    assert.deepEqual([r1.status, r2.status].sort(), [200, 404])
    const row = await dbGet<any>('SELECT revoked_at, redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(race)])
    assert.notEqual(Boolean(row.revoked_at), Boolean(row.redeemed_by_gc_user_id))

    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      for (const endpoint of ['/api/connection-qr/redeem', '/API/CONNECTION-QR/REDEEM']) {
        const malformed = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"token":"${race}"` })
        assert.equal(malformed.status, 400)
        assert.match(malformed.headers.get('cache-control') || '', /no-store/)
        assert.equal((await malformed.text()).includes(race), false)
      }
      assert.equal(errors.join(' ').includes(race), false)
    } finally { console.error = original }
    const rows = await dbAll<any>('SELECT token_hash FROM sub_connection_qr_tokens')
    assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.token_hash)))
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
