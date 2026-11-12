import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import express from 'express'
import { createPilot } from '../../src/pilot-bootstrap.ts'
import { createConnectionShell } from '../../src/connection-shell-wrapper.ts'

const output = fileURLToPath(new URL('../../../client/connection-pilot/dist', import.meta.url))
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const env = {
  SECURE_V2_CONFIG_VERSION: '1', SECURE_V2_DB_HOST: 'localhost', SECURE_V2_DB_PORT: '1', SECURE_V2_DB_NAME: 'pilot', SECURE_V2_DB_USER: 'pilot', SECURE_V2_DB_PASSWORD: 'synthetic',
  SECURE_V2_JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), SECURE_V2_JWT_PUBLIC_KEY_PEM: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), SECURE_V2_JWT_ISSUER: 'pilot', SECURE_V2_JWT_AUDIENCE: 'pilot',
  SECURE_V2_SES_REGION: 'us-east-1', SECURE_V2_SES_FROM: 'sender@example.test', SECURE_V2_SES_TIMEOUT_MS: '1000', SECURE_V2_METADATA: 'disabled', SECURE_V2_FILES: 'disabled',
  PILOT_LIMITER_HMAC_KEY: randomBytes(32).toString('base64url'), PILOT_REGISTRATION_MAILBOXES: 'one@example.test',
}

test('built shell is isolated and actual createPilot fails closed when local DB is unavailable', async () => {
  const pilot = createPilot(env)
  const server = createConnectionShell(pilot.app, output).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const page = await fetch(base + '/')
    assert.equal(page.status, 200)
    assert.equal(page.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()')
    const csp = page.headers.get('content-security-policy')!
    for (const term of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'"]) assert.ok(csp.includes(term))
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'))
    assert.equal(page.headers.get('cache-control'), 'no-store')
    const html = await page.text()
    assert.ok(!html.includes('http://') && !html.includes('https://'))
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m => m[1])
    assert.equal(assetPaths.length, 2)
    for (const path of assetPaths) { const r = await fetch(base + path); assert.equal(r.status, 200); assert.equal(r.headers.get('x-content-type-options'), 'nosniff') }
    assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200)
    assert.equal((await fetch(base + '/healthz')).status, 200) // liveness despite unavailable DB
    for (const path of ['/index.html', '/favicon.ico', '/assets/no-such.js', '/assets/../index.html', '/%2e%2e/package.json', '/uploads/a', '/api/v2/self-reported-coi-metadata/own', '/api/v2/self-reported-private-files/own', '/api/v2/auth/login?x=secret', '/api/v2/%61uth/login', '/api/users', '/?x=secret']) assert.equal((await fetch(base + path)).status, 404, path)
    for (const path of ['/assets/../index.html', '/assets/%2e%2e/index.html', '/assets/%2findex.html', '//', '/%2f']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: address.port, path }, res => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
      })
      assert.equal(status, 404, path)
    }
    const blocked = await fetch(base + '/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.test', password: 'synthetic-password' }) })
    assert.equal(blocked.status, 503); assert.ok(!(await blocked.text()).includes('synthetic-password'))
    const huge = await fetch(base + '/api/v2/auth/login', { method: 'POST', body: 'x'.repeat(8193) }); assert.equal(huge.status, 413)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await pilot.pool.end(); pilot.ses.destroy(); pilot.httpsAgent.destroy() }
})

test('cookies are stripped in both directions, including writeHead and static responses', async () => {
  const api = express()
  api.get('/api/v2/auth/me', (req, res) => { assert.equal(req.headers.cookie, undefined); res.writeHead(200, { 'Set-Cookie': 'unsafe=1', 'Content-Type': 'application/json' }); res.end('{}') })
  const server = createConnectionShell(api, output).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  try { const response = await fetch(`http://127.0.0.1:${address.port}/api/v2/auth/me`, { headers: { cookie: 'old=secret' } }); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null) }
  finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('unexpected build assets, symlinks, and unavailable outputs fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'connection-build-'))
  try {
    mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'index.html'), 'ok')
    writeFileSync(join(root, 'assets', 'index-abcdef12.js'), 'ok')
    assert.doesNotThrow(() => createConnectionShell(express(), root))
    symlinkSync('/etc/passwd', join(root, 'assets', 'other-abcdef12.js'))
    assert.throws(() => createConnectionShell(express(), root))
    rmSync(join(root, 'assets', 'other-abcdef12.js')); writeFileSync(join(root, 'assets', 'legacy.js'), '')
    assert.throws(() => createConnectionShell(express(), root))
    assert.throws(() => createConnectionShell(express(), join(root, 'missing')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
