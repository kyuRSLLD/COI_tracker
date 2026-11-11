import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Isolated disposable database and local, synthetic accounts only.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-staged-invite-'))
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

test('staged invitation isolation and security', async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  async function request(method: string, url: string, body?: any, bearer?: string) {
    const response = await fetch(`${base}${url}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, json: await response.json() as any, headers: response.headers }
  }
  const api = '/api/invitations'
  try {
    delete process.env.STAGED_INVITES_ENABLED
    assert.equal((await request('POST', `${api}/info`, { token: 'x' })).status, 503)
    process.env.STAGED_INVITES_ENABLED = 'true'
    process.env.NODE_ENV = 'production'
    assert.equal((await request('POST', `${api}/info`, { token: 'x' })).status, 503)
    process.env.NODE_ENV = 'test'
    const secret = process.env.JWT_SECRET!
    process.env.JWT_SECRET = 'dev-secret-change-in-production'
    assert.equal((await request('POST', `${api}/info`, { token: 'x' })).status, 503)
    process.env.JWT_SECRET = secret

    async function register(role: string, n: number) {
      const email = `${role}${n}@example.test`
      const pass = `test-only-password-${n}`
      const r = await request('POST', '/api/auth/register', { email, password: pass, name: `${role}${n}`, company_name: `${role.toUpperCase()} Company ${n}`, role })
      assert.equal(r.status, 200)
      assert.equal(r.json.user.password_hash, undefined)
      const login = await request('POST', '/api/auth/login', { email, password: pass })
      assert.equal(login.status, 200)
      assert.equal(login.json.user.password_hash, undefined)
      return { id: login.json.user.id as string, subId: login.json.user.subcontractor_id as string | null, token: login.json.token as string }
    }
    const gc1 = await register('gc', 1)
    const gc2 = await register('gc', 2)
    const sub1 = await register('sub', 1)
    const sub2 = await register('sub', 2)
    assert.equal((await request('POST', api, {}, gc1.token)).status, 409)
    const now = new Date().toISOString()
    await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['synthetic-coi', sub1.subId, 'PRIVATE-SYNTHETIC-COI', '2020-01-01', '2030-01-01', 'pending_review', now, now])
    for (const [id, gc] of [['profile1', gc1], ['profile2', gc2]] as const) {
      await dbRun('INSERT INTO gc_settings (id, user_id, company_name, updated_at) VALUES (?, ?, ?, ?)', [id, gc.id, 'Potentially globally mutable setting', now])
    }
    await dbRun('INSERT INTO gc_settings (id, user_id, company_name, updated_at) VALUES (?, ?, ?, ?)', ['duplicate', gc1.id, 'Duplicate', now])
    assert.equal((await request('POST', api, {}, gc1.token)).status, 409)
    await dbRun('DELETE FROM gc_settings WHERE id = ?', ['duplicate'])
    assert.equal((await request('POST', api, {})).status, 401)
    assert.equal((await request('POST', api, {}, sub1.token)).status, 403)
    assert.equal((await request('GET', api, undefined, sub1.token)).status, 403)
    assert.equal((await request('GET', `${api}/relationships`, undefined, sub1.token)).status, 403)
    for (const max_uses of [0, 11, -1, 1.5, '1', true]) assert.equal((await request('POST', api, { max_uses }, gc1.token)).status, 400)
    // Signed token with a forged role is still checked against the persisted user.
    const forgedRole = signToken({ id: sub1.id, email: 'ignored@example.test', name: 'ignored', role: 'gc' })
    assert.equal((await request('POST', api, {}, forgedRole)).status, 403)
    const phantom = signToken({ id: 'nonexistent', email: 'ignored@example.test', name: 'ignored', role: 'gc' })
    assert.equal((await request('GET', api, undefined, phantom)).status, 403)

    async function create(token: string, maxUses = 1) {
      const r = await request('POST', api, { max_uses: maxUses }, token)
      assert.equal(r.status, 201)
      assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/)
      assert.equal(Buffer.from(r.json.token, 'base64url').length, 32)
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.ok(Date.parse(r.json.expires_at) - Date.now() <= 86400000)
      assert.ok(Date.parse(r.json.expires_at) - Date.now() > 23 * 3600000)
      const dbRow = await dbGet<any>('SELECT * FROM staged_gc_invitations WHERE id = ?', [r.json.id])
      assert.equal(dbRow.token_hash, createHash('sha256').update(r.json.token).digest('hex'))
      assert.ok(!JSON.stringify(dbRow).includes(r.json.token))
      return r.json as { id: string, token: string, expires_at: string, max_uses: number }
    }
    const a = await create(gc1.token)
    const b = await create(gc2.token, 2)
    assert.notEqual(a.token, b.token)
    let info = await request('POST', `${api}/info`, { token: a.token })
    assert.deepEqual(info.json, { gc_company_name: 'GC Company 1', expires_at: a.expires_at })
    assert.equal(info.headers.get('referrer-policy'), 'no-referrer')
    info = await request('POST', `${api}/info`, { token: b.token })
    assert.equal(info.json.gc_company_name, 'GC Company 2')
    assert.equal(info.json.email, undefined)
    assert.ok(!JSON.stringify(info.json).includes('PRIVATE-SYNTHETIC-COI'))
    const invalidBody = await fetch(`${base}${api}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"secret"' })
    assert.equal(invalidBody.status, 400)
    assert.ok(!(await invalidBody.text()).includes('secret'))
    const tooLarge = await fetch(`${base}${api}/info`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(5000) }) })
    assert.equal(tooLarge.status, 413)
    assert.equal((await request('POST', `${api}/info`, { token: "' OR 1=1 --" })).status, 404)
    assert.equal((await request('POST', `${api}/accept`, { token: a.token })).status, 401)
    assert.equal((await request('POST', `${api}/accept`, { token: a.token }, gc1.token)).status, 403)
    assert.equal((await request('DELETE', `${api}/${a.id}`, undefined, gc2.token)).status, 404)
    const list1 = await request('GET', api, undefined, gc1.token)
    const list2 = await request('GET', api, undefined, gc2.token)
    assert.deepEqual(list1.json.invitations.map((i: any) => i.id), [a.id])
    assert.deepEqual(list2.json.invitations.map((i: any) => i.id), [b.id])
    assert.ok(!JSON.stringify(list1.json).includes(a.token))
    assert.ok(!JSON.stringify(list1.json).includes('token_hash'))

    const legacyBefore = await dbGet<any>('SELECT (SELECT COUNT(*) FROM cois) AS c, (SELECT COUNT(*) FROM subcontractors) AS s, (SELECT COUNT(*) FROM upload_requests) AS u, (SELECT COUNT(*) FROM project_subcontractors) AS p')
    // A foreign profile ID or matching email is not enough for ownership.
    await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', [sub2.subId, sub1.id])
    assert.equal((await request('POST', `${api}/accept`, { token: a.token }, sub1.token)).status, 409)
    await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', [sub1.subId, sub1.id])

    // One-use invitation: racing two real logged-in subcontractors yields one winner.
    const race = await Promise.all([sub1, sub2].map(s => request('POST', `${api}/accept`, { token: a.token }, s.token)))
    assert.deepEqual(race.map(r => r.status).sort(), [200, 404])
    assert.equal(race.find(r => r.status === 200)?.json.status, 'staged')
    assert.equal(race.find(r => r.status === 200)?.json.created, true)
    assert.equal((await request('POST', `${api}/info`, { token: a.token })).status, 404)
    const winner = race[0].status === 200 ? sub1 : sub2
    const loser = race[0].status === 200 ? sub2 : sub1
    assert.equal((await dbGet<any>('SELECT uses FROM staged_gc_invitations WHERE id = ?', [a.id])).uses, 1)
    const ag = await request('GET', `${api}/relationships`, undefined, gc1.token)
    assert.deepEqual(ag.json.relationships.map((r: any) => r.sub_user_id), [winner.id])
    assert.deepEqual((await request('GET', `${api}/relationships`, undefined, gc2.token)).json.relationships, [])
    assert.equal(ag.json.relationships[0].source, 'gc_invite')
    assert.ok(!JSON.stringify(ag.json).includes('password_hash'))
    assert.ok(!JSON.stringify(ag.json).includes('PRIVATE-SYNTHETIC-COI'))

    const duplicate = await create(gc1.token, 2)
    const duplicateResult = await request('POST', `${api}/accept`, { token: duplicate.token }, winner.token)
    assert.deepEqual(duplicateResult.json, { status: 'staged', created: false })
    assert.equal((await dbGet<any>('SELECT uses FROM staged_gc_invitations WHERE id = ?', [duplicate.id])).uses, 0)
    assert.equal((await request('POST', `${api}/accept`, { token: duplicate.token }, loser.token)).json.created, true)
    assert.equal((await request('POST', `${api}/accept`, { token: b.token }, sub2.token)).json.created, true)
    assert.equal((await request('POST', `${api}/accept`, { token: b.token }, sub1.token)).json.created, true)
    assert.equal((await request('POST', `${api}/accept`, { token: b.token }, sub1.token)).status, 404)
    const relationships = await dbAll<any>('SELECT gc_user_id, sub_user_id, source, source_id FROM staged_gc_sub_relationships ORDER BY gc_user_id, sub_user_id')
    assert.equal(relationships.length, 4)
    assert.ok(relationships.some(r => r.gc_user_id === gc1.id && r.sub_user_id === sub1.id))
    assert.ok(relationships.some(r => r.gc_user_id === gc1.id && r.sub_user_id === sub2.id))
    assert.ok(relationships.some(r => r.gc_user_id === gc2.id && r.sub_user_id === sub1.id))
    assert.ok(relationships.some(r => r.gc_user_id === gc2.id && r.sub_user_id === sub2.id))
    assert.deepEqual(await dbGet('SELECT (SELECT COUNT(*) FROM cois) AS c, (SELECT COUNT(*) FROM subcontractors) AS s, (SELECT COUNT(*) FROM upload_requests) AS u, (SELECT COUNT(*) FROM project_subcontractors) AS p'), legacyBefore)

    const revoked = await create(gc1.token)
    assert.equal((await request('DELETE', `${api}/${revoked.id}`, undefined, gc1.token)).status, 200)
    assert.equal((await request('POST', `${api}/info`, { token: revoked.token })).status, 404)
    assert.equal((await request('POST', `${api}/accept`, { token: revoked.token }, sub1.token)).status, 404)
    const expired = await create(gc1.token)
    await dbRun('UPDATE staged_gc_invitations SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', expired.id])
    assert.equal((await request('POST', `${api}/info`, { token: expired.token })).status, 404)
    assert.equal((await request('POST', `${api}/accept`, { token: expired.token }, sub1.token)).status, 404)
    const lostOwner = await create(gc1.token)
    await dbRun('UPDATE gc_settings SET user_id = ? WHERE id = ?', [gc2.id, 'profile1'])
    assert.equal((await request('POST', `${api}/info`, { token: lostOwner.token })).status, 404)
    assert.equal((await request('POST', `${api}/accept`, { token: lostOwner.token }, sub1.token)).status, 404)
    await dbRun('UPDATE gc_settings SET user_id = ? WHERE id = ?', [gc1.id, 'profile1'])

    // Force a transaction failure after finding the invite; use and link must roll back.
    const rollback = await create(gc1.token)
    await dbExec(`CREATE TRIGGER staged_fail_test BEFORE INSERT ON staged_gc_sub_relationships BEGIN SELECT RAISE(ABORT, 'test'); END;`)
    assert.equal((await request('POST', `${api}/accept`, { token: rollback.token }, sub1.token)).status, 503)
    assert.equal((await dbGet<any>('SELECT uses FROM staged_gc_invitations WHERE id = ?', [rollback.id])).uses, 0)
    await dbExec('DROP TRIGGER staged_fail_test')

    // Global DB rate budget is shared across requests and fails closed on DB failure.
    await dbRun('UPDATE staged_invite_rate_limit SET window_start = ?, hits = ? WHERE id = ?', [Math.floor(Date.now() / 60000), 120, 'public'])
    assert.equal((await request('POST', `${api}/info`, { token: rollback.token })).status, 429)
    assert.equal((await request('POST', `${api}/accept`, { token: rollback.token }, sub1.token)).status, 429)
    await dbExec('DROP TABLE staged_invite_rate_limit')
    assert.equal((await request('POST', `${api}/info`, { token: rollback.token })).status, 503)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('staged schema is absent when disabled and in production', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-staged-gate-'))
  const appUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/app.ts')).href
  const dbUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/db/db.ts')).href
  const program = `import { createApp } from ${JSON.stringify(appUrl)}; import { dbGet } from ${JSON.stringify(dbUrl)};
    await createApp(); const row = await dbGet("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)", ['staged_gc_invitations', 'staged_sub_qr_capabilities']);
    if (row) process.exitCode = 1;`
  try {
    for (const [nodeEnv, enabled] of [['test', 'false'], ['production', 'true']]) {
      const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {
        env: { ...process.env, SQLITE_PATH: path.join(dir, `${nodeEnv}.sqlite`), DATABASE_URL: '', NODE_ENV: nodeEnv, STAGED_INVITES_ENABLED: enabled },
        encoding: 'utf8', timeout: 20000,
      })
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
