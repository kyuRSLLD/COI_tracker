import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-consent-test-'))
process.env.SQLITE_PATH = path.join(tmp, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.JWT_SECRET = 'test-only-long-random-secret-1234567890123456'
process.env.NODE_ENV = 'test'
process.env.RELATIONSHIP_PROTOTYPE_ENABLED = 'true'
process.env.STAGED_INVITES_ENABLED = 'false'
const { createApp } = await import('../src/app.ts')
const { dbGet, dbAll, dbRun, dbExec } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

test('consented prototype relationships isolate data and revoke access', async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const addr = server.address()
  assert.ok(addr && typeof addr !== 'string')
  const base = `http://127.0.0.1:${addr.port}/api/relationship-prototype`
  const call = async (method: string, route: string, token?: string, body?: any) => {
    const response = await fetch(base + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() as any, headers: response.headers }
  }
  try {
    const created = new Date().toISOString()
    const user = async (id: string, role: string) => {
      await dbRun('INSERT INTO users (id,email,password_hash,name,company_name,role,created_at,subcontractor_id) VALUES (?,?,?,?,?,?,?,?)', [id, `${id}@example.test`, 'fake', id, `${id} company`, role, created, role === 'sub' ? `${id}-profile` : null])
      if (role === 'gc') await dbRun('INSERT INTO gc_settings (id,user_id,updated_at) VALUES (?,?,?)', [`${id}-settings`, id, created])
      if (role === 'sub') await dbRun('INSERT INTO subcontractors (id,user_id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?,?)', [`${id}-profile`, id, `${id} company`, 'Electrical', created, created])
      return signToken({ id, role, name: id, email: `${id}@example.test` })
    }
    const gc1 = await user('gc1', 'gc'), gc2 = await user('gc2', 'gc'), gc3 = await user('gc3', 'gc')
    const sub1 = await user('sub1', 'sub'), sub2 = await user('sub2', 'sub'), admin = await user('admin', 'admin')
    const addCoi = async (id: string, sub: string) => {
      await dbRun('INSERT INTO cois (id,subcontractor_id,carrier,policy_number,effective_date,expiration_date,reviewer_notes,certificate_url,certificate_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, `${sub}-profile`, `${id}-carrier`, `${id}-policy`, '2026-01-01', '2027-01-01', `${id}-notes`, `https://secret.invalid/${id}.pdf`, `secret-key-${id}`, created, created])
      await dbRun('INSERT INTO coi_coverages (id,coi_id,type,per_occurrence_limit,notes) VALUES (?,?,?,?,?)', [`${id}-coverage`, id, 'General Liability', '1000000', `${id}-coverage-notes`])
    }
    await addCoi('sub1-old', 'sub1'); await addCoi('sub2-only', 'sub2')
    const initial = await dbAll('SELECT * FROM cois ORDER BY id')
    const initialCoverage = await dbAll('SELECT * FROM coi_coverages ORDER BY id')
    assert.equal((await call('GET', '/gc/connections')).status, 401)
    assert.equal((await call('GET', '/gc/connections', sub1)).status, 403)
    assert.equal((await call('GET', '/gc/connections', admin)).status, 403)
    const disclosure = await call('GET', '/disclosure', sub1)
    assert.equal(disclosure.status, 200)
    assert.match(disclosure.body.scope, /ALL.*current and future/)
    assert.match(disclosure.body.qr, /any qualifying signed-in general contractor/)
    assert.match(disclosure.body.scope, /clients/)
    const consent = { consent: true, consent_version: disclosure.body.version }
    const invite = await call('POST', '/gc-invitations', gc1, {})
    assert.equal(invite.status, 201)
    assert.equal(invite.headers.get('cache-control'), 'no-store')
    assert.equal(Buffer.from(invite.body.token, 'base64url').length, 32)
    const cap = await dbGet<any>('SELECT * FROM prototype_relationship_capabilities WHERE id = ?', [invite.body.id])
    assert.equal(cap.token_hash, createHash('sha256').update(invite.body.token).digest('hex'))
    assert.ok(!JSON.stringify(cap).includes(invite.body.token))
    assert.equal((await call('POST', '/gc-invitations/preview', gc2, { token: invite.body.token })).status, 403)
    const preview = await call('POST', '/gc-invitations/preview', sub1, { token: invite.body.token })
    assert.equal(preview.status, 200); assert.equal(preview.body.gc_user_id, 'gc1')
    assert.equal(preview.body.disclosure.version, consent.consent_version)
    for (const wrong of [{}, { consent: false, consent_version: consent.consent_version }, { consent: true, consent_version: 'old' }]) {
      assert.equal((await call('POST', '/gc-invitations/accept', sub1, { token: invite.body.token, gc_user_id: 'gc1', gc_company_name: 'gc1 company', ...wrong })).status, 400)
      assert.equal((await call('POST', '/sub-qr', sub1, wrong)).status, 400)
    }
    assert.equal((await call('POST', '/gc-invitations/accept', sub1, { ...consent, token: invite.body.token, gc_user_id: 'gc2', gc_company_name: 'gc1 company' })).status, 404)
    assert.equal((await call('POST', '/gc-invitations/accept', sub1, { ...consent, token: invite.body.token, gc_user_id: 'gc1', gc_company_name: 'different company' })).status, 404)
    assert.deepEqual((await call('GET', '/gc/connections', gc1)).body.connections, [])
    assert.equal((await call('POST', '/gc-invitations/accept', sub1, { ...consent, token: invite.body.token, gc_user_id: 'gc1', gc_company_name: 'gc1 company' })).status, 200)
    assert.equal((await call('POST', '/gc-invitations/accept', sub2, { ...consent, token: invite.body.token, gc_user_id: 'gc1', gc_company_name: 'gc1 company' })).status, 404)
    let list = await call('GET', '/gc/connections', gc1)
    assert.equal(list.status, 200); assert.equal(list.body.connections.length, 1)
    assert.equal(list.body.connections[0].sub_user_id, 'sub1')
    assert.equal(list.body.connections[0].cois[0].policy_number, 'sub1-old-policy')
    assert.equal(list.body.connections[0].cois[0].coverages[0].notes, 'sub1-old-coverage-notes')
    assert.ok(!JSON.stringify(list.body).includes('secret.invalid'))
    assert.ok(!JSON.stringify(list.body).includes('secret-key'))
    assert.ok(!JSON.stringify(list.body).includes('certificate_url'))
    assert.ok(!JSON.stringify(list.body).includes('certificate_key'))
    assert.deepEqual((await call('GET', '/gc/connections', gc2)).body.connections, [])
    assert.deepEqual((await call('GET', '/gc/connections', gc3)).body.connections, [])
    await addCoi('sub1-future', 'sub1')
    await dbRun('UPDATE cois SET reviewer_notes = ? WHERE id = ?', ['secret https://secret.invalid/certificate.pdf', 'sub1-future'])
    list = await call('GET', '/gc/connections', gc1)
    assert.deepEqual(list.body.connections[0].cois.map((c: any) => c.id).sort(), ['sub1-future', 'sub1-old'])
    assert.ok(!JSON.stringify(list.body).includes('secret.invalid'))
    assert.deepEqual(await dbAll('SELECT * FROM cois WHERE id IN (?, ?) ORDER BY id', ['sub1-old', 'sub2-only']), initial)
    assert.deepEqual(await dbAll('SELECT * FROM coi_coverages WHERE coi_id IN (?, ?) ORDER BY id', ['sub1-old', 'sub2-only']), initialCoverage)
    assert.deepEqual(await dbAll('SELECT * FROM client_share_links'), [])
    assert.deepEqual(await dbAll('SELECT * FROM project_subcontractors'), [])
    const pendingQr = await call('POST', '/sub-qr', sub1, consent)
    assert.equal(pendingQr.status, 201)
    assert.equal((await call('GET', '/sub/connections', sub1)).body.connections[0].gc_user_id, 'gc1')
    assert.equal((await call('DELETE', '/sub/connections/gc1', sub2)).status, 404)
    assert.equal((await call('DELETE', '/sub/connections/gc1', gc1)).status, 403)
    assert.equal((await call('DELETE', '/sub/connections/gc1', sub1)).status, 200)
    assert.deepEqual((await call('GET', '/gc/connections', gc1)).body.connections, [])
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: pendingQr.body.token })).status, 404)
    const qr = await call('POST', '/sub-qr', sub1, consent)
    assert.equal(qr.status, 201)
    assert.equal((await call('POST', '/sub-qr/preview', gc2, { token: qr.body.token })).body.company_name, 'sub1 company')
    assert.equal((await call('POST', '/sub-qr/accept', sub2, { token: qr.body.token })).status, 403)
    const race = await Promise.all([gc2, gc3].map(gc => call('POST', '/sub-qr/accept', gc, { token: qr.body.token })))
    assert.deepEqual(race.map(r => r.status).sort(), [200, 404])
    const winner = race[0].status === 200 ? gc2 : gc3
    const loser = race[0].status === 200 ? gc3 : gc2
    assert.equal((await call('GET', '/gc/connections', winner)).body.connections[0].cois.length, 2)
    assert.deepEqual((await call('GET', '/gc/connections', loser)).body.connections, [])
    assert.equal((await dbAll('SELECT * FROM prototype_consent_events')).length, 2)
    const otherQr = await call('POST', '/sub-qr', sub2, consent)
    assert.equal((await call('POST', '/sub-qr/accept', loser, { token: otherQr.body.token })).status, 200)
    const otherList = (await call('GET', '/gc/connections', loser)).body.connections
    assert.equal(otherList.length, 1)
    assert.deepEqual(otherList[0].cois.map((c: any) => c.id), ['sub2-only'])
    assert.ok(!JSON.stringify(otherList).includes('sub1-old-policy'))
    const raceQr = await call('POST', '/sub-qr', sub2, consent)
    const revokeRace = await Promise.all([
      call('DELETE', `/sub/connections/${loser === gc2 ? 'gc2' : 'gc3'}`, sub2),
      call('POST', '/sub-qr/accept', loser, { token: raceQr.body.token }),
    ])
    assert.equal(revokeRace[0].status, 200)
    assert.ok([200, 404].includes(revokeRace[1].status))
    assert.deepEqual((await call('GET', '/gc/connections', loser)).body.connections, [])
    const qr2 = await call('POST', '/sub-qr', sub2, consent)
    assert.equal((await call('DELETE', `/capabilities/${qr2.body.id}`, sub1)).status, 404)
    assert.equal((await call('DELETE', `/capabilities/${qr2.body.id}`, sub2)).status, 200)
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: qr2.body.token })).status, 404)
    const qr3 = await call('POST', '/sub-qr', sub2, consent)
    await dbRun('UPDATE prototype_relationship_capabilities SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', qr3.body.id])
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: qr3.body.token })).status, 404)
    const forged = signToken({ id: 'sub1', role: 'gc', name: 'fake', email: 'fake' })
    assert.equal((await call('GET', '/gc/connections', forged)).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['admin', 'sub1'])
    assert.deepEqual((await call('GET', '/gc/connections', winner)).body.connections, [])
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', 'sub1'])
    await dbRun('INSERT INTO subcontractors (id,user_id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['duplicate', 'sub1', 'duplicate', 'x', created, created])
    assert.deepEqual((await call('GET', '/gc/connections', winner)).body.connections, [])
    assert.equal((await call('POST', '/sub-qr', sub1, consent)).status, 409)
    await dbRun('DELETE FROM subcontractors WHERE id = ?', ['duplicate'])
    await dbExec("CREATE TRIGGER prototype_fail BEFORE INSERT ON prototype_consent_events BEGIN SELECT RAISE(ABORT, 'test'); END")
    const rollbackQr = await call('POST', '/sub-qr', sub2, consent)
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: rollbackQr.body.token })).status, 503)
    assert.equal((await dbGet<any>('SELECT consumed_at FROM prototype_relationship_capabilities WHERE id = ?', [rollbackQr.body.id])).consumed_at, null)
    assert.equal(await dbGet('SELECT * FROM prototype_relationships WHERE gc_user_id = ? AND sub_user_id = ?', ['gc1', 'sub2']), undefined)
    await dbExec('DROP TRIGGER prototype_fail')
    for (const [key, value] of [['NODE_ENV', 'production'], ['RELATIONSHIP_PROTOTYPE_ENABLED', 'false'], ['DATABASE_URL', 'postgres://example.invalid/db']]) {
      const previous = process.env[key]; process.env[key] = value
      assert.equal((await call('GET', '/gc/connections', winner)).status, 503)
      process.env[key] = previous
    }
    process.env.JWT_SECRET = 'changed-after-module-load'
    assert.equal((await call('GET', '/gc/connections', winner)).status, 503)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('startup does not create prototype tables by default, when disabled, or in production', () => {
  for (const [envName, flag] of [['test', ''], ['test', 'false'], ['production', 'true']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-gates-'))
    try {
      const code = `const {createApp}=await import('./src/app.ts'); const {dbGet}=await import('./src/db/db.ts'); const app=await createApp(); const row=await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='prototype_relationships'"); if(row) process.exit(2); const s=app.listen(0,'127.0.0.1',async()=>{const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/relationship-prototype/gc/connections'); if(r.status!==503) process.exitCode=3; s.close()})`
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, JWT_SECRET: 'test-only-long-random-secret-1234567890123456', SQLITE_PATH: path.join(dir, 'test.sqlite'), NODE_ENV: envName, RELATIONSHIP_PROTOTYPE_ENABLED: flag, DATABASE_URL: '' }, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr + result.stdout)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
})

test('unsafe SQLite locations fail closed without opening them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-location-'))
  try {
    const dangling = path.join(dir, 'dangling.sqlite')
    fs.symlinkSync('/home/ubuntu/nonexistent-prototype-db.sqlite', dangling)
    const existing = path.join(dir, 'existing.sqlite')
    fs.writeFileSync(existing, '')
    const link = path.join(dir, 'linked.sqlite')
    fs.symlinkSync(existing, link)
    for (const sqlitePath of ['/home/ubuntu/nonexistent-prototype-db.sqlite', dangling, link]) {
      const code = `const {relationshipPrototypeEnvironmentSafe}=await import('./src/db/db.ts'); if(relationshipPrototypeEnvironmentSafe()) process.exit(2)`
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env: { ...process.env, SQLITE_PATH: sqlitePath, NODE_ENV: 'test', RELATIONSHIP_PROTOTYPE_ENABLED: 'true', DATABASE_URL: '' }, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr + result.stdout)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
