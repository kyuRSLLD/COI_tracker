import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-private-test-'))
const files = fs.mkdtempSync(path.join(tmp, 'coi-synthetic-certificates-'))
process.env.SQLITE_PATH = path.join(tmp, 'synthetic.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.JWT_SECRET = 'synthetic-test-only-secret-1234567890123456789'
process.env.NODE_ENV = 'test'
process.env.RELATIONSHIP_PROTOTYPE_ENABLED = 'true'
process.env.PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED = 'true'
process.env.PRIVATE_CERTIFICATE_TEST_DIR = files
const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

const ids = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
const pdf = Buffer.from('%PDF-1.4\nsynthetic only\n%%EOF')
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic PNG')])
const jpg = Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from('synthetic JPEG')])
const webp = Buffer.from('RIFF1234WEBPsynthetic')

test('separate consent, authenticated ownership, revocation, safe file access, and gates', async () => {
  const app = await createApp()
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string')
  const base = `http://127.0.0.1:${addr.port}/api/relationship-prototype`
  const call = async (method: string, route: string, token?: string, body?: any) => {
    const r = await fetch(base + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const bytes = Buffer.from(await r.arrayBuffer())
    assert.equal(r.headers.get('cache-control'), 'no-store', `${method} ${route}`)
    return { status: r.status, headers: r.headers, bytes, json: () => JSON.parse(bytes.toString()) }
  }
  try {
    const t = new Date().toISOString()
    const user = async (id: string, role: string) => {
      await dbRun('INSERT INTO users (id,email,password_hash,name,company_name,role,created_at,subcontractor_id) VALUES (?,?,?,?,?,?,?,?)', [id, `${id}@example.test`, 'fake', id, `${id} company`, role, t, role === 'sub' ? `${id}-profile` : null])
      if (role === 'gc') await dbRun('INSERT INTO gc_settings (id,user_id,updated_at) VALUES (?,?,?)', [`${id}-settings`, id, t])
      if (role === 'sub') await dbRun('INSERT INTO subcontractors (id,user_id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?,?)', [`${id}-profile`, id, `${id} company`, 'test', t, t])
      return signToken({ id, role, name: id, email: `${id}@example.test` })
    }
    const gc1 = await user('gc1', 'gc'), gc2 = await user('gc2', 'gc')
    const sub1 = await user('sub1', 'sub'), sub2 = await user('sub2', 'sub'), admin = await user('admin', 'admin')
    const addCoi = async (id: string, sub: string, mime: string) => dbRun(`INSERT INTO cois (id,subcontractor_id,carrier,effective_date,expiration_date,certificate_url,certificate_key,certificate_mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, `${sub}-profile`, 'synthetic carrier', '2020', '2030', 'https://secret.invalid/object', '../../secret-object-key', mime, t, t])
    const fixtures = [[ids[0], 'application/pdf', pdf], [ids[1], 'image/png', png], [ids[2], 'image/jpeg', jpg], [ids[3], 'image/webp', webp]] as const
    for (const [id, mime, bytes] of fixtures) { await addCoi(id, 'sub1', mime); fs.writeFileSync(path.join(files, id), bytes) }
    await addCoi(ids[4], 'sub2', 'application/pdf'); fs.writeFileSync(path.join(files, ids[4]), pdf)
    await addCoi(ids[5], 'sub1', 'application/pdf') // missing
    await addCoi(ids[6], 'sub1', 'text/html'); fs.writeFileSync(path.join(files, ids[6]), Buffer.from('<html>not allowed</html>'))
    await addCoi(ids[7], 'sub1', 'image/png'); fs.writeFileSync(path.join(files, ids[7]), pdf) // spoofed type
    await addCoi(ids[8], 'sub1', 'application/pdf')
    const gcPath = (id: string) => `/gc/certificates/${id}`
    const subPath = (id: string) => `/sub/certificates/${id}`
    assert.equal((await call('GET', gcPath(ids[0]))).status, 401)
    assert.equal((await call('GET', gcPath(ids[0]), sub1)).status, 403)
    assert.equal((await call('GET', subPath(ids[0]), admin)).status, 403)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', subPath(ids[0]), sub2)).status, 404)
    assert.deepEqual((await call('GET', subPath(ids[0]), sub1)).bytes, pdf)

    const disclosure = (await call('GET', '/disclosure', sub1)).json()
    const qr = (await call('POST', '/sub-qr', sub1, { consent: true, consent_version: disclosure.version })).json()
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: qr.token })).status, 200)
    // Original consent explicitly did not include files.
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', '/sub/connections/gc1/certificate-disclosure', sub2)).status, 404)
    const fd = (await call('GET', '/sub/connections/gc1/certificate-disclosure', sub1)).json()
    assert.equal(fd.gc_user_id, 'gc1'); assert.match(fd.scope, /download all/)
    const permission = { consent: true, consent_version: fd.version, gc_user_id: fd.gc_user_id, gc_company_name: fd.gc_company_name, connection_id: fd.connection_id }
    const grantPath = '/sub/connections/gc1/certificate-access'
    for (const bad of [{ ...permission, consent: false }, { ...permission, consent_version: disclosure.version }, { ...permission, gc_company_name: 'different' }, { ...permission, connection_id: 'stale' }]) {
      assert.notEqual((await call('POST', grantPath, sub1, bad)).status, 200)
    }
    assert.equal((await call('POST', grantPath, sub2, permission)).status, 404)
    assert.equal((await call('POST', grantPath, sub1, permission)).status, 200)
    await dbRun('UPDATE prototype_relationships SET revoked_at = ? WHERE gc_user_id = ?', [t, 'gc1'])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    await dbRun('UPDATE prototype_relationships SET revoked_at = NULL WHERE gc_user_id = ?', ['gc1'])
    await dbRun('UPDATE prototype_certificate_grants SET revoked_at = ? WHERE gc_user_id = ?', [t, 'gc1'])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    await dbRun('UPDATE prototype_certificate_grants SET revoked_at = NULL WHERE gc_user_id = ?', ['gc1'])
    for (const [id, mime, bytes] of fixtures) {
      const r = await call('GET', gcPath(id), gc1)
      assert.equal(r.status, 200); assert.deepEqual(r.bytes, bytes); assert.equal(r.headers.get('content-type'), mime)
      assert.match(r.headers.get('content-disposition')!, /^attachment; filename="certificate\./)
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
      assert.ok(!JSON.stringify([...r.headers]).includes('secret.invalid'))
      assert.ok(!JSON.stringify([...r.headers]).includes('secret-object-key'))
    }
    assert.equal((await call('GET', gcPath(ids[4]), gc1)).status, 404)
    assert.equal((await call('GET', gcPath(ids[0]), gc2)).status, 404)
    for (const id of [ids[5], ids[6], ids[7], 'not-a-uuid', '%2e%2e%2fsecret']) assert.equal((await call('GET', gcPath(id), gc1)).status, 404)
    // Symlinks, hardlinks, non-regular files, and invalid MIME cannot expose files.
    const outside = path.join(tmp, 'outside'); fs.writeFileSync(outside, pdf)
    fs.symlinkSync(outside, path.join(files, ids[8]))
    assert.equal((await call('GET', gcPath(ids[8]), gc1)).status, 404)
    fs.unlinkSync(path.join(files, ids[8])); fs.linkSync(outside, path.join(files, ids[8]))
    assert.equal((await call('GET', gcPath(ids[8]), gc1)).status, 404)
    fs.unlinkSync(path.join(files, ids[8])); fs.mkdirSync(path.join(files, ids[8]))
    assert.equal((await call('GET', gcPath(ids[8]), gc1)).status, 404)
    const forged = signToken({ id: 'sub1', role: 'gc', name: 'fake', email: 'fake' })
    assert.equal((await call('GET', gcPath(ids[0]), forged)).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['admin', 'gc1'])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', 'gc1'])
    await dbRun('INSERT INTO gc_settings (id,user_id,updated_at) VALUES (?,?,?)', ['duplicate-settings', 'gc1', t])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    await dbRun('DELETE FROM gc_settings WHERE id = ?', ['duplicate-settings'])
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['admin', 'sub1'])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', subPath(ids[0]), sub1)).status, 403)
    await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', 'sub1'])
    await dbRun('INSERT INTO subcontractors (id,user_id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?,?)', ['duplicate', 'sub1', 'duplicate', 'test', t, t])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', subPath(ids[0]), sub1)).status, 404)
    await dbRun('DELETE FROM subcontractors WHERE id = ?', ['duplicate'])
    await dbRun('UPDATE cois SET subcontractor_id = ? WHERE id = ?', ['sub2-profile', ids[0]])
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', subPath(ids[0]), sub1)).status, 404)
    await dbRun('UPDATE cois SET subcontractor_id = ? WHERE id = ?', ['sub1-profile', ids[0]])
    assert.equal((await call('DELETE', grantPath, sub1)).status, 200)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('GET', subPath(ids[0]), sub1)).status, 200)
    assert.equal((await call('POST', grantPath, sub1, permission)).status, 200)
    assert.equal((await call('DELETE', '/sub/connections/gc1', sub1)).status, 200)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    const qr2 = (await call('POST', '/sub-qr', sub1, { consent: true, consent_version: disclosure.version })).json()
    assert.equal((await call('POST', '/sub-qr/accept', gc1, { token: qr2.token })).status, 200)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404) // old grant cannot revive
    assert.equal((await call('POST', grantPath, sub1, permission)).status, 404) // stale disclosure
    const fd2 = (await call('GET', '/sub/connections/gc1/certificate-disclosure', sub1)).json()
    const newPermission = { consent: true, consent_version: fd2.version, gc_user_id: fd2.gc_user_id, gc_company_name: fd2.gc_company_name, connection_id: fd2.connection_id }
    assert.equal((await call('POST', grantPath, sub1, newPermission)).status, 200)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 200)
    const future = '00000000-0000-4000-8000-000000000010'
    await addCoi(future, 'sub1', 'application/pdf'); fs.writeFileSync(path.join(files, future), pdf)
    assert.equal((await call('GET', gcPath(future), gc1)).status, 200)
    const race = await Promise.all([call('DELETE', grantPath, sub1), call('GET', gcPath(ids[0]), gc1)])
    assert.equal(race[0].status, 200); assert.ok([200, 404].includes(race[1].status))
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 404)
    assert.equal((await call('POST', grantPath, sub1, newPermission)).status, 200)
    for (const [key, value] of [['NODE_ENV', 'production'], ['RELATIONSHIP_PROTOTYPE_ENABLED', 'false'], ['PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED', 'false'], ['PRIVATE_CERTIFICATE_TEST_DIR', tmp], ['DATABASE_URL', 'postgres://example.invalid/db'], ['JWT_SECRET', 'changed']]) {
      const previous = process.env[key]; process.env[key] = value
      assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 503, key)
      process.env[key] = previous
    }
    fs.chmodSync(files, 0o755)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 503)
    fs.chmodSync(files, 0o700)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 200)
    const moved = files + '-moved'; fs.renameSync(files, moved); fs.symlinkSync(moved, files)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 503)
    fs.unlinkSync(files); fs.renameSync(moved, files)
    assert.equal((await call('GET', gcPath(ids[0]), gc1)).status, 200)
    // No write to source certificate keys or implicit client access.
    assert.equal((await dbGet<any>('SELECT certificate_key FROM cois WHERE id = ?', [ids[0]])).certificate_key, '../../secret-object-key')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('private gate is off by default and rejects production, unsafe roots and post-boot changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-gate-test-'))
  const good = fs.mkdtempSync(path.join(root, 'coi-synthetic-certificates-'))
  const linked = path.join(root, 'coi-synthetic-certificates-linked'); fs.symlinkSync(good, linked)
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const code = `const {createApp}=await import('./src/app.ts'); const {dbGet}=await import('./src/db/db.ts'); const {signToken}=await import('./src/middleware/auth.ts'); const app=await createApp(); const row=await dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='prototype_certificate_grants'"); if(row) process.exit(2); process.env.PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED='true'; process.env.PRIVATE_CERTIFICATE_TEST_DIR=${JSON.stringify(good)}; const token=signToken({id:'synthetic',role:'gc',name:'fake',email:'fake'}); const s=app.listen(0,'127.0.0.1',async()=>{const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/relationship-prototype/gc/certificates/00000000-0000-4000-8000-000000000001',{headers:{authorization:'Bearer '+token}}); if(r.status!==503) process.exitCode=3; s.close()})`
    const cases = [
      { flag: '', mode: 'test', dir: good }, { flag: 'false', mode: 'test', dir: good },
      { flag: 'true', mode: 'production', dir: good }, { flag: 'true', mode: 'test', dir: linked },
      { flag: 'true', mode: 'test', dir: root }, { flag: 'true', mode: 'test', dir: '/home/ubuntu' },
    ]
    for (const [i, c] of cases.entries()) {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { cwd, env: { ...process.env, SQLITE_PATH: path.join(root, `gate-${i}.sqlite`), NODE_ENV: c.mode, RELATIONSHIP_PROTOTYPE_ENABLED: 'true', PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED: c.flag, PRIVATE_CERTIFICATE_TEST_DIR: c.dir, DATABASE_URL: '' }, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr + result.stdout)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
