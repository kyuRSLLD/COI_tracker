import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import express from 'express'
import type { RequestHandler } from 'express'
import { createSecureV2App } from '../src/secure-v2-app.ts'

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
async function listen(app: ReturnType<typeof createSecureV2App>) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { server, port: address.port }
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
}
async function call(port: number, path: string, options: {
  method?: string; headers?: Record<string, string> | string[]; body?: string | Buffer
} = {}): Promise<Reply> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body)
  })
}
function assertSecurity(reply: Reply) {
  assert.equal(reply.headers['cache-control'], 'no-store')
  assert.equal(reply.headers.pragma, 'no-cache')
  assert.equal(reply.headers['x-content-type-options'], 'nosniff')
  assert.equal(reply.headers['x-frame-options'], 'DENY')
  assert.match(String(reply.headers['content-security-policy']), /default-src 'none'/)
  assert.match(String(reply.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.equal(reply.headers['referrer-policy'], 'no-referrer')
  assert.equal(reply.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()')
  assert.equal(reply.headers['x-powered-by'], undefined)
  assert.equal(reply.headers['access-control-allow-origin'], undefined)
}
const good = { authorization: 'Bearer synthetic-valid' }
function fixtures() {
  const hits: string[] = []
  const authRouter = express.Router()
  // Deliberately broad to prove it cannot serve unrelated/ambiguous paths.
  authRouter.use((_req, res) => { hits.push('auth-router'); res.json({ area: 'auth' }) })
  function privateRouter(name: string) {
    const router = express.Router()
    router.all('/item', (_req, res) => { hits.push(name); res.json({ area: name }) })
    router.post('/echo', (req, res) => { hits.push(name); res.json({ body: req.body }) })
    router.get('/throw', () => { throw new Error('SYNTHETIC_SECRET_STACK') })
    router.get('/next-error', (_req, _res, next) => next(new Error('SYNTHETIC_SECRET_NEXT')))
    return router
  }
  const authenticate: RequestHandler = (req, res, next) => {
    hits.push('verify')
    if (req.headers.authorization === good.authorization) return next()
    res.status(401).json({ error: 'Authentication required' })
  }
  const app = createSecureV2App({ authRouter, authenticate, gcRouter: privateRouter('gc'),
    connectionsRouter: privateRouter('connections'), certificatesRouter: privateRouter('certificates'),
    selfReportedCoiMetadataRouter: privateRouter('self-reported-coi-metadata') })
  return { app, hits }
}

test('legacy, static, noncanonical and non-allowlisted paths are rejected before any injected handler', async () => {
  const { app, hits } = fixtures()
  const { server, port } = await listen(app)
  try {
    const paths = [
      '/', '/api', '/api/health', '/api/auth/login', '/api/cois', '/api/projects',
      '/api/sub/public/test', '/api/client/share/test', '/api/upload/submit/test',
      '/api/staff', '/api/admin', '/uploads', '/uploads/file.pdf', '/UPLOADS/file.pdf',
      '/api/v1/gc', '/api/v2', '/api/v2/gcc/item', '/api/v2/authentication',
      '/api/v2/GC/item', '/API/v2/auth/login', '/api/v2/auth/../gc/item',
      '/api/v2/auth/%2e%2e/gc/item', '/api/v2/auth%2fgc', '/api/v2/gc/../../uploads/file',
      '/api/v2/auth//login', '/api/v2/auth/./login', '/api/v2/auth\\..\\gc',
    ]
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'OPTIONS', 'HEAD']) {
        const reply = await call(port, path, { method, headers: good })
        assert.equal(reply.status, 404, `${method} ${path}`)
        assertSecurity(reply)
        if (method !== 'HEAD') assert.deepEqual(JSON.parse(reply.body), { error: 'Not found' })
      }
    }
    assert.deepEqual(hits, [])
  } finally { await close(server) }
})

test('only the auth router is public; all private mounts require validated bearer authentication', async () => {
  const { app, hits } = fixtures()
  const { server, port } = await listen(app)
  try {
    const publicReply = await call(port, '/api/v2/auth/login')
    assert.equal(publicReply.status, 200)
    assertSecurity(publicReply)
    assert.deepEqual(JSON.parse(publicReply.body), { area: 'auth' })
    hits.length = 0
    for (const area of ['gc', 'connections', 'certificates', 'self-reported-coi-metadata']) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const denied = await call(port, `/api/v2/${area}/item`, { method })
        assert.equal(denied.status, 401, `${method} ${area}`)
        assertSecurity(denied)
      }
      assert.deepEqual(hits, [], 'no method may bypass the gate')
      for (const headers of [undefined, { authorization: '' }, { authorization: 'Basic YWJj' },
        { authorization: 'Bearer' }, { authorization: 'Bearer ' }, { authorization: 'Bearer bad token' },
        { authorization: `Bearer ${'x'.repeat(4100)}` }, ['Host', '127.0.0.1', 'Authorization', 'Bearer synthetic-valid', 'authorization', 'Bearer other']]) {
        const reply = await call(port, `/api/v2/${area}/item`, { headers })
        assert.equal(reply.status, 401, `${area}: ${JSON.stringify(headers)?.slice(0, 100)}`)
        assertSecurity(reply)
      }
      assert.deepEqual(hits, [], 'malformed auth must not reach verifier or private routers')
      const invalid = await call(port, `/api/v2/${area}/item`, { headers: { authorization: 'Bearer syntactically-valid-but-invalid' } })
      assert.equal(invalid.status, 401)
      assert.deepEqual(hits, ['verify'])
      hits.length = 0
      const valid = await call(port, `/api/v2/${area}/item`, { headers: good })
      assert.equal(valid.status, 200)
      assert.deepEqual(JSON.parse(valid.body), { area })
      assertSecurity(valid)
      assert.deepEqual(hits, ['verify', area])
      hits.length = 0
      const unknown = await call(port, `/api/v2/${area}/not-implemented`, { headers: good })
      assert.equal(unknown.status, 404)
      assert.deepEqual(JSON.parse(unknown.body), { error: 'Not found' })
      assert.deepEqual(hits, ['verify'])
      hits.length = 0
    }
  } finally { await close(server) }
})

test('missing dependencies fail closed and optional private routers are unavailable', async () => {
  const none = await listen(createSecureV2App())
  try {
    for (const path of ['/api/v2/auth/login', '/api/v2/gc/item', '/api/v2/connections/item', '/api/v2/certificates/item', '/api/v2/self-reported-coi-metadata/item']) {
      const reply = await call(none.port, path, { headers: good })
      assert.equal(reply.status, 503, path)
      assert.deepEqual(JSON.parse(reply.body), { error: 'Service unavailable' })
      assertSecurity(reply)
    }
  } finally { await close(none.server) }
  const validOnly: RequestHandler = (req, res, next) => req.headers.authorization === good.authorization
    ? next() : res.status(401).end()
  const missingRouters = await listen(createSecureV2App({ authenticate: validOnly }))
  try {
    for (const area of ['gc', 'connections', 'certificates', 'self-reported-coi-metadata']) {
      assert.equal((await call(missingRouters.port, `/api/v2/${area}/item`)).status, 401)
      assert.equal((await call(missingRouters.port, `/api/v2/${area}/item`, { headers: good })).status, 503)
    }
  } finally { await close(missingRouters.server) }
  const hits: string[] = []
  const router = express.Router().use((_req, res) => { hits.push('private'); res.end('bad') })
  const noVerifier = await listen(createSecureV2App({ gcRouter: router }))
  try {
    assert.equal((await call(noVerifier.port, '/api/v2/gc/item', { headers: good })).status, 503)
    assert.deepEqual(hits, [])
  } finally { await close(noVerifier.server) }
})

test('JSON parsing is bounded and generic; private parsing happens only after authentication', async () => {
  const { app, hits } = fixtures()
  const { server, port } = await listen(app)
  const json = { ...good, 'content-type': 'application/json' }
  try {
    const ok = await call(port, '/api/v2/gc/echo', { method: 'POST', headers: json, body: '{"sample":true}' })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { body: { sample: true } })
    assertSecurity(ok)
    hits.length = 0
    const unauth = await call(port, '/api/v2/gc/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed' })
    assert.equal(unauth.status, 401)
    assert.deepEqual(hits, [])
    const bad = await call(port, '/api/v2/gc/echo', { method: 'POST', headers: json, body: '{"secret":"SYNTHETIC_BAD_JSON"' })
    assert.equal(bad.status, 400)
    assert.deepEqual(JSON.parse(bad.body), { error: 'Bad request' })
    assertSecurity(bad)
    assert.doesNotMatch(bad.body, /SYNTHETIC_BAD_JSON|SyntaxError|stack/)
    assert.deepEqual(hits, ['verify'])
    hits.length = 0
    const largeBody = JSON.stringify({ sample: 'x'.repeat(70 * 1024) })
    for (const [headers, body] of [[json, largeBody], [{ ...json, 'content-encoding': 'gzip' }, gzipSync(largeBody)]] as const) {
      const large = await call(port, '/api/v2/gc/echo', { method: 'POST', headers, body })
      assert.equal(large.status, 413)
      assert.deepEqual(JSON.parse(large.body), { error: 'Request too large' })
      assertSecurity(large)
    }
    assert.deepEqual(hits, ['verify', 'verify'])
    hits.length = 0
    const publicBad = await call(port, '/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(publicBad.status, 400)
    assert.deepEqual(hits, [])
    const publicLarge = await call(port, '/api/v2/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: largeBody })
    assert.equal(publicLarge.status, 413)
    assert.deepEqual(hits, [])
    const encoding = await call(port, '/api/v2/gc/echo', { method: 'POST', headers: { ...json, 'content-encoding': 'unsupported' }, body: '{}' })
    assert.equal(encoding.status, 415)
    assert.deepEqual(JSON.parse(encoding.body), { error: 'Unsupported request' })
  } finally { await close(server) }
})

test('handler and authenticator errors are sanitized; Express skip sentinels cannot bypass the auth gate', async () => {
  const { app } = fixtures()
  const instance = await listen(app)
  try {
    for (const path of ['/api/v2/gc/throw', '/api/v2/gc/next-error']) {
      const reply = await call(instance.port, path, { headers: good })
      assert.equal(reply.status, 500)
      assert.deepEqual(JSON.parse(reply.body), { error: 'Internal server error' })
      assert.doesNotMatch(reply.body, /SYNTHETIC|stack|Error:/)
      assertSecurity(reply)
    }
  } finally { await close(instance.server) }
  for (const auth of [
    ((_req, _res, next) => next('route')) as RequestHandler,
    ((_req, _res, next) => next('router')) as RequestHandler,
    ((_req, res, next) => { res.status(401).json({ error: 'Authentication required' }); next() }) as RequestHandler,
    ((_req, res, next) => { res.status(403); next() }) as RequestHandler,
    ((_req, _res, next) => next(new Error('SYNTHETIC_VERIFY_ERROR'))) as RequestHandler,
    (async () => { throw new Error('SYNTHETIC_ASYNC_VERIFY_ERROR') }) as RequestHandler,
  ]) {
    let routed = false
    const router = express.Router().use((_req, res) => { routed = true; res.end('private') })
    const instance = await listen(createSecureV2App({ authenticate: auth, gcRouter: router }))
    try {
      const reply = await call(instance.port, '/api/v2/gc/item', { headers: good })
      assert.ok([401, 500].includes(reply.status))
      assert.doesNotMatch(reply.body, /SYNTHETIC|stack|private/)
      assertSecurity(reply)
      assert.equal(routed, false)
    } finally { await close(instance.server) }
  }
})
