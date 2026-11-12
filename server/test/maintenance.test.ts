import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// These must be set before any app imports: tests must never contact a real DB or S3.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-maintenance-test-'))
const dbPath = path.join(tempDir, 'test.sqlite')
process.env.SQLITE_PATH = dbPath
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'maintenance-test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp, MAINTENANCE_MODE } = await import('../src/app.ts')
const { dbAll, dbRun, initDatabase } = await import('../src/db/db.ts')
const { LOCAL_UPLOADS } = await import('../src/services/storage.ts')
const { signToken } = await import('../src/middleware/auth.ts')

async function start(app: Awaited<ReturnType<typeof createApp>>) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

async function stop(server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']>) {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
}

test('maintenance protects APIs and uploads without database startup writes; disabling retains private file protections', async () => {
  const app = await createApp({ maintenanceMode: true })
  const defaultApp = MAINTENANCE_MODE ? await createApp() : undefined
  assert.equal(fs.existsSync(dbPath), false, 'maintenance startup must not initialize or migrate the database')
  const maintenance = await start(app)
  const markerName = `maintenance-test-${process.pid}-${Date.now()}.txt`
  const markerPath = path.join(LOCAL_UPLOADS, markerName)
  let markerCreated = false
  let normal: Awaited<ReturnType<typeof start>> | undefined
  let deployedDefault: Awaited<ReturnType<typeof start>> | undefined
  try {
    // Populate a disposable SQLite DB with data that real routes can expose or mutate.
    await initDatabase()
    const now = new Date().toISOString()
    await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['test-admin', 'admin@example.test', 'unused', 'Test Admin', 'admin', now])
    await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['test-sub', 'private@example.test', 'unused', 'Test Sub', 'sub', now])
    await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['private-sub', 'test-sub', 'SENSITIVE TEST COMPANY', 'Test Trade', 'private@example.test', now, now])
    await dbRun('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', ['private-project', 'SENSITIVE TEST PROJECT', now])
    await dbRun('INSERT INTO client_share_links (id, project_id, token, created_at) VALUES (?, ?, ?, ?)', ['share', 'private-project', 'share-token', now])
    await dbRun('INSERT INTO upload_requests (id, subcontractor_id, token, created_at) VALUES (?, ?, ?, ?)', ['upload', 'private-sub', 'upload-token', now])
    await dbRun('INSERT INTO cois (id, subcontractor_id, owner_sub_user_id, carrier, policy_number, effective_date, expiration_date, status, certificate_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['coi', 'private-sub', 'test-sub', 'TEST CARRIER', 'PRIVATE-POLICY', '2020-01-01', '2099-01-01', 'compliant', markerName, now, now])
    fs.mkdirSync(LOCAL_UPLOADS, { recursive: true })
    fs.writeFileSync(markerPath, 'PRIVATE TEST UPLOAD', { flag: 'wx' })
    markerCreated = true
    const tables = ['users', 'companies', 'subcontractors', 'projects', 'client_share_links', 'upload_requests', 'cois', 'coi_coverages', 'email_logs']
    const snapshot = async () => Promise.all(tables.map((table) => dbAll(`SELECT * FROM ${table} ORDER BY id`)))
    const before = await snapshot()
    const token = signToken({ id: 'test-admin', email: 'admin@example.test', role: 'admin', name: 'Test Admin' })
    const subToken = signToken({ id: 'test-sub', email: 'private@example.test', role: 'sub', name: 'Test Sub' })

    const health = await fetch(`${maintenance.base}/api/health`)
    assert.equal(health.status, 200)
    assert.deepEqual({ status: (await health.json() as any).status }, { status: 'ok' })
    assert.equal((await fetch(`${maintenance.base}/api/health`, { method: 'HEAD' })).status, 200)
    assert.equal((await fetch(`${maintenance.base}/api/health`, { method: 'OPTIONS', headers: { origin: 'https://example.test', 'access-control-request-method': 'GET' } })).status, 204)
    const index = await fetch(`${maintenance.base}/`)
    assert.equal(index.status, 200, 'build client before running this test')
    assert.match(index.headers.get('content-type') || '', /text\/html/)
    assert.match(await index.text(), /<div id="root"><\/div>/)

    const requests: Array<{ method: string; url: string; body?: string; auth?: boolean | 'sub' }> = [
      { method: 'GET', url: '/api' },
      { method: 'GET', url: '/api/unknown?x=1' },
      { method: 'GET', url: '/API/COIS' },
      { method: 'GET', url: '/api/health/extra' },
      { method: 'POST', url: '/api/health' },
      { method: 'OPTIONS', url: '/api/sub/public/private-sub' },
      { method: 'GET', url: '/api/sub/public/private-sub' },
      { method: 'GET', url: '/api/client/share/share-token' },
      { method: 'GET', url: '/api/upload/validate/upload-token' },
      { method: 'GET', url: '/api/upload/my/upload-token' },
      { method: 'POST', url: '/api/upload/submit/upload-token', body: JSON.stringify({ carrier: 'Injected', effective_date: '2024-01-01', expiration_date: '2030-01-01', email: 'attacker@example.test' }) },
      { method: 'GET', url: '/api/subcontractors', auth: true },
      { method: 'GET', url: '/api/cois', auth: true },
      { method: 'GET', url: '/api/projects', auth: true },
      { method: 'GET', url: '/api/admin/overview', auth: true },
      { method: 'GET', url: '/api/staff/overview', auth: true },
      { method: 'POST', url: '/api/auth/register', body: JSON.stringify({ email: 'attacker@example.test', password: 'password123', name: 'Attacker' }) },
      { method: 'POST', url: '/api/auth/login', body: '{not valid json' },
      { method: 'POST', url: '/api/sub/carrier-connect', auth: true, body: '{}' },
      { method: 'GET', url: '/uploads' },
      { method: 'GET', url: `/uploads/${markerName}` },
      { method: 'GET', url: `/uploads/${markerName}`, auth: true },
      { method: 'GET', url: `/uploads/${markerName}`, auth: 'sub' },
      { method: 'GET', url: `/UPLOADS/${markerName}` },
      { method: 'HEAD', url: `/uploads/${markerName}` },
      { method: 'POST', url: '/uploads/no-file' },
    ]
    for (const { method, url, body, auth } of requests) {
      const response = await fetch(`${maintenance.base}${url}`, {
        method,
        headers: { origin: 'https://example.test', ...(auth ? { authorization: `Bearer ${auth === 'sub' ? subToken : token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
      })
      assert.equal(response.status, 503, `${method} ${url}`)
      assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${url}`)
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://example.test', `${method} ${url}`)
      if (method !== 'HEAD') assert.deepEqual(await response.json(), { error: 'Service temporarily unavailable for maintenance.' }, `${method} ${url}`)
    }
    assert.deepEqual(await snapshot(), before, 'blocked requests must not change application data')
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'PRIVATE TEST UPLOAD')

    // The test-only constructor override exercises what changing the source switch
    // to false would do. It is not exposed through HTTP or environment configuration.
    normal = await start(await createApp({ maintenanceMode: false }))
    const publicSub = await fetch(`${normal.base}/api/sub/public/private-sub`)
    assert.equal(publicSub.status, 410)
    assert.doesNotMatch(await publicSub.text(), /SENSITIVE TEST COMPANY/)
    const upload = await fetch(`${normal.base}/uploads/${markerName}`)
    assert.equal(upload.status, 401)
    assert.doesNotMatch(await upload.text(), /PRIVATE TEST UPLOAD/)
    const otherUser = await fetch(`${normal.base}/uploads/${markerName}`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(otherUser.status, 404)
    assert.doesNotMatch(await otherUser.text(), /PRIVATE TEST UPLOAD/)
    const ownerUpload = await fetch(`${normal.base}/uploads/${markerName}`, { headers: { authorization: `Bearer ${subToken}` } })
    assert.equal(ownerUpload.status, 200)
    assert.equal(ownerUpload.headers.get('cache-control'), 'no-store')
    assert.equal(await ownerUpload.text(), 'PRIVATE TEST UPLOAD')
    // The route checks NODE_ENV per request; exercise the production guard locally
    // without starting a production app or contacting production services.
    process.env.NODE_ENV = 'production'
    try {
      for (const authorization of [undefined, `Bearer ${subToken}`]) {
        const blocked = await fetch(`${normal.base}/uploads/${markerName}`, { headers: authorization ? { authorization } : {} })
        assert.equal(blocked.status, 404)
        assert.equal(blocked.headers.get('cache-control'), 'no-store')
        assert.doesNotMatch(await blocked.text(), /PRIVATE TEST UPLOAD/)
      }
    } finally {
      process.env.NODE_ENV = 'test'
    }
    const login = await fetch(`${normal.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.notEqual(login.status, 503)

    // Production calls createApp() without an override. Verify it follows the
    // source switch whether the switch is enabled now or disabled in a rollback.
    deployedDefault = await start(defaultApp ?? await createApp())
    const defaultPublicSub = await fetch(`${deployedDefault.base}/api/sub/public/private-sub`)
    assert.equal(defaultPublicSub.status, MAINTENANCE_MODE ? 503 : 410)
  } finally {
    if (deployedDefault) await stop(deployedDefault.server)
    if (normal) await stop(normal.server)
    await stop(maintenance.server)
    if (markerCreated) fs.rmSync(markerPath, { force: true })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
