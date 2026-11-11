import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-staged-sub-qr-'))
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.JWT_SECRET = 'test-only-high-entropy-secret-00000000000000'
process.env.NODE_ENV = 'test'
process.env.STAGED_INVITES_ENABLED = 'true'
const { createApp } = await import('../src/app.ts')
const { dbGet, dbAll, dbRun, dbExec } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

// Deliberately synthetic users and a disposable DB; no real accounts or mail.
test('staged sub QR is isolated, owned, short-lived and atomically single-use', async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const api = '/api/invitations'
  async function request(method: string, url: string, body?: any, bearer?: string) {
    const response = await fetch(`${base}${url}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, json: await response.json() as any, headers: response.headers }
  }
  try {
    const now = new Date().toISOString()
    const makeUser = async (id: string, role: 'gc' | 'sub') => {
      await dbRun('INSERT INTO users (id, email, password_hash, name, company_name, role, created_at, subcontractor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, `${id}@example.test`, 'never-return-this', id, `${id} Company`, role, now, role === 'sub' ? `${id}-profile` : null])
      if (role === 'gc') await dbRun('INSERT INTO gc_settings (id, user_id, company_name, updated_at) VALUES (?, ?, ?, ?)', [`${id}-settings`, id, 'not the account company', now])
      if (role === 'sub') await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`${id}-profile`, id, 'PRIVATE LEGACY NAME', 'PRIVATE LEGACY TRADE', now, now])
      return { id, token: signToken({ id, role, name: id, email: `${id}@example.test` }) }
    }
    const gc1 = await makeUser('gc1', 'gc'); const gc2 = await makeUser('gc2', 'gc'); const gc3 = await makeUser('gc3', 'gc')
    const sub1 = await makeUser('sub1', 'sub'); const sub2 = await makeUser('sub2', 'sub')

    // Build a pair through the existing GC invitation implementation first.
    const invite = await request('POST', api, {}, gc1.token)
    assert.equal(invite.status, 201)
    assert.equal((await request('POST', `${api}/accept`, { token: invite.json.token }, sub1.token)).json.created, true)
    // If any QR route even reads the global sub table, it now fails.
    const before = await dbAll('SELECT * FROM subcontractors ORDER BY id')
    await dbExec('ALTER TABLE subcontractors RENAME TO hidden_legacy_subs')

    const create = async (sub = sub1) => {
      const r = await request('POST', `${api}/sub-qr`, { trade: 'Electrical' }, sub.token)
      assert.equal(r.status, 201)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(Buffer.from(r.json.token, 'base64url').length, 32)
      assert.ok(Date.parse(r.json.expires_at) - Date.now() <= 600000)
      assert.ok(Date.parse(r.json.expires_at) - Date.now() > 9 * 60000)
      const row = await dbGet<any>('SELECT * FROM staged_sub_qr_capabilities WHERE id = ?', [r.json.id])
      assert.equal(row.token_hash, createHash('sha256').update(r.json.token).digest('hex'))
      assert.ok(!JSON.stringify(row).includes(r.json.token))
      return r.json as { id: string, token: string, expires_at: string }
    }
    assert.equal((await request('POST', `${api}/sub-qr`, { trade: 'Electrical' })).status, 401)
    assert.equal((await request('POST', `${api}/sub-qr`, { trade: 'Electrical' }, gc1.token)).status, 403)
    const forgedSub = signToken({ id: gc1.id, role: 'sub', name: 'x', email: 'x' })
    const forgedGc = signToken({ id: sub1.id, role: 'gc', name: 'x', email: 'x' })
    assert.equal((await request('POST', `${api}/sub-qr`, { trade: 'x' }, forgedSub)).status, 403)
    for (const trade of [undefined, '', ' ', 'x'.repeat(121), 'x\ny', 12]) assert.equal((await request('POST', `${api}/sub-qr`, { trade }, sub1.token)).status, 400)
    const q = await create()
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: q.token })).status, 401)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: q.token }, sub1.token)).status, 403)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: q.token }, forgedGc)).status, 403)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: q.token }, forgedGc)).status, 403)
    const info = await request('POST', `${api}/sub-qr/info`, { token: q.token }, gc1.token)
    assert.equal(info.status, 200)
    assert.deepEqual(info.json, { company_name: 'sub1 Company', trade: 'Electrical' })
    assert.equal(info.headers.get('cache-control'), 'no-store')
    assert.equal((await dbGet<any>('SELECT consumed_at FROM staged_sub_qr_capabilities WHERE id = ?', [q.id])).consumed_at, null)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: "' OR 1=1 --" }, gc1.token)).status, 404)
    assert.deepEqual((await request('POST', `${api}/sub-qr/accept`, { token: q.token }, gc1.token)).json, { status: 'staged', created: false })
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: q.token }, gc2.token)).status, 404)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: q.token }, gc1.token)).status, 404)
    assert.equal((await dbGet<any>('SELECT source FROM staged_gc_sub_relationships WHERE gc_user_id = ? AND sub_user_id = ?', [gc1.id, sub1.id])).source, 'gc_invite')

    const revoked = await create()
    assert.equal((await request('DELETE', `${api}/sub-qr/${revoked.id}`, undefined, sub2.token)).status, 404)
    assert.equal((await request('DELETE', `${api}/sub-qr/${revoked.id}`, undefined, gc1.token)).status, 403)
    assert.equal((await request('DELETE', `${api}/sub-qr/${revoked.id}`, undefined, sub1.token)).status, 200)
    assert.equal((await request('DELETE', `${api}/sub-qr/${revoked.id}`, undefined, sub1.token)).status, 200)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: revoked.token }, gc1.token)).status, 404)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: revoked.token }, gc1.token)).status, 404)
    const expired = await create()
    await dbRun('UPDATE staged_sub_qr_capabilities SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', expired.id])
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: expired.token }, gc1.token)).status, 404)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: expired.token }, gc1.token)).status, 404)

    const owner = await create()
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', sub1.id])
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 404)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc1.token)).status, 404)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', sub1.id])
    await dbRun('UPDATE users SET company_name = ? WHERE id = ?', ['changed', sub1.id])
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 404)
    await dbRun('UPDATE users SET company_name = ? WHERE id = ?', ['sub1 Company', sub1.id])
    await dbRun('UPDATE gc_settings SET user_id = ? WHERE id = ?', [gc2.id, 'gc1-settings'])
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 409)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc1.token)).status, 409)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc2.token)).status, 409)
    await dbRun('UPDATE gc_settings SET user_id = ? WHERE id = ?', [gc1.id, 'gc1-settings'])
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', gc1.id])
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc1.token)).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', gc1.id])

    const raceQr = await create()
    const race = await Promise.all([gc2, gc3].map(gc => request('POST', `${api}/sub-qr/accept`, { token: raceQr.token }, gc.token)))
    assert.deepEqual(race.map(r => r.status).sort(), [200, 404])
    assert.deepEqual(race.find(r => r.status === 200)?.json, { status: 'staged', created: true })
    const pairs = await dbAll<any>('SELECT * FROM staged_gc_sub_relationships WHERE source = ? AND source_id = ?', ['sub_qr', raceQr.id])
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].sub_user_id, sub1.id)
    assert.ok([gc2.id, gc3.id].includes(pairs[0].gc_user_id))
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: raceQr.token }, gc2.token)).status, 404)

    const rollback = await create(sub2)
    await dbExec(`CREATE TRIGGER staged_qr_fail_test BEFORE INSERT ON staged_gc_sub_relationships BEGIN SELECT RAISE(ABORT, 'test'); END;`)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: rollback.token }, gc1.token)).status, 503)
    assert.equal((await dbGet<any>('SELECT consumed_at FROM staged_sub_qr_capabilities WHERE id = ?', [rollback.id])).consumed_at, null)
    assert.equal(await dbGet('SELECT * FROM staged_gc_sub_relationships WHERE gc_user_id = ? AND sub_user_id = ?', [gc1.id, sub2.id]), undefined)
    await dbExec('DROP TRIGGER staged_qr_fail_test')
    const revokeRace = await create(sub2)
    const [accepted, deleted] = await Promise.all([
      request('POST', `${api}/sub-qr/accept`, { token: revokeRace.token }, gc1.token),
      request('DELETE', `${api}/sub-qr/${revokeRace.id}`, undefined, sub2.token),
    ])
    assert.equal(deleted.status, 200)
    assert.ok([200, 404].includes(accepted.status))
    assert.equal(Boolean(await dbGet('SELECT * FROM staged_gc_sub_relationships WHERE source = ? AND source_id = ?', ['sub_qr', revokeRace.id])), accepted.status === 200)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: revokeRace.token }, gc2.token)).status, 404)
    assert.deepEqual(await dbAll('SELECT * FROM hidden_legacy_subs ORDER BY id'), before)

    for (const [env, enabled] of [['production', 'true'], ['test', 'false']]) {
      process.env.NODE_ENV = env; process.env.STAGED_INVITES_ENABLED = enabled
      assert.equal((await request('POST', `${api}/sub-qr`, { trade: 'x' }, sub1.token)).status, 503)
      assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 503)
      assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc1.token)).status, 503)
      assert.equal((await request('DELETE', `${api}/sub-qr/${owner.id}`, undefined, sub1.token)).status, 503)
    }
    process.env.NODE_ENV = 'test'; process.env.STAGED_INVITES_ENABLED = 'true'
    await dbRun('UPDATE staged_invite_rate_limit SET window_start = ?, hits = ? WHERE id = ?', [Math.floor(Date.now() / 60000), 120, 'public'])
    assert.equal((await request('POST', `${api}/sub-qr`, { trade: 'x' }, sub1.token)).status, 429)
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 429)
    assert.equal((await request('POST', `${api}/sub-qr/accept`, { token: owner.token }, gc1.token)).status, 429)
    assert.equal((await request('DELETE', `${api}/sub-qr/${owner.id}`, undefined, sub1.token)).status, 200)
    await dbExec('DROP TABLE staged_invite_rate_limit')
    assert.equal((await request('POST', `${api}/sub-qr/info`, { token: owner.token }, gc1.token)).status, 503)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
