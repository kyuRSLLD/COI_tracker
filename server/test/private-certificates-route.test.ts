import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Readable } from 'node:stream'
import express from 'express'
import { privateCertificatesRouter } from '../src/routes/privateCertificates.ts'
import { PrivateCertificateStorage, MAX_CERTIFICATE_BYTES } from '../src/services/privateCertificateStorage.ts'

const pdf = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF')
async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as any
  return { server, base: `http://127.0.0.1:${address.port}` }
}
function fixture() {
  let currentRole = 'sub', active = true, owned = true, writes = 0, reads = 0
  const records = new Map<string, any>(), objects = new Map<string, any>()
  let sourceOverride: (() => Readable) | undefined
  let getOverride: ((signal?: AbortSignal) => Promise<any>) | undefined
  let putOverride: ((signal?: AbortSignal) => Promise<any>) | undefined
  const pool = { async query(sql: string, args: any[]) {
    const allowed = args[0] === 'c1' && args[1] === 'sub1' && currentRole === 'sub' && active && owned
    if (sql.startsWith('SELECT EXISTS')) return { rows: [{ allowed }], rowCount: 1 }
    if (sql.startsWith('INSERT')) {
      if (!allowed) return { rows: [], rowCount: 0 }
      if (records.has(args[0])) throw Error('sensitive duplicate')
      records.set(args[0], { object_key: args[2], mime: args[3], byte_size: args[4] }); return { rows: [{}], rowCount: 1 }
    }
    if (sql.startsWith('SELECT object_key')) { const row = allowed && records.get(args[0]); return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } }
    throw Error('unexpected')
  } } as any
  const s3 = {
    async put(command: any, signal?: AbortSignal) { writes++; if (putOverride) return putOverride(signal); objects.set(command.input.Key, { data: Buffer.from(command.input.Body), mime: command.input.ContentType }) },
    async get(command: any, signal?: AbortSignal) { reads++; if (getOverride) return getOverride(signal); const object = objects.get(command.input.Key); if (!object) throw Error('secret key'); return { Body: sourceOverride ? sourceOverride() : Readable.from([object.data]), ContentLength: object.data.length, ContentType: object.mime } },
  }
  const auth = (req: any, _res: any, next: any) => {
    const token = req.headers.authorization
    if (token === 'sub') req.securePrincipal = { subject: 'sub1', role: 'sub', credential: 'verified-by-test-middleware' }
    if (token === 'gc') req.securePrincipal = { subject: 'gc1', role: 'gc', credential: 'verified-by-test-middleware' }
    if (token === 'client') req.securePrincipal = { subject: 'client1', role: 'client', credential: 'verified-by-test-middleware' }
    next()
  }
  const app = express()
  // A previous middleware's injected value must not bypass authentication.
  app.use((req: any, _res, next) => { req.securePrincipal = { subject: 'sub1', role: 'sub', credential: 'forged' }; next() })
  app.use('/certs', privateCertificatesRouter({ enabled: true, pool, verifiedMiddleware: auth,
    makeStorage: ({ authorize, records }) => new PrivateCertificateStorage({ enabled: true, bucket: 'test-private-certificates', records, authorize, s3 }) }))
  return { app, records, objects, get writes() { return writes }, get reads() { return reads }, setRole: (v: string) => { currentRole = v }, setActive: (v: boolean) => { active = v }, setOwned: (v: boolean) => { owned = v }, setSource: (v: () => Readable) => { sourceOverride = v }, setGet: (v: (signal?: AbortSignal) => Promise<any>) => { getOverride = v }, setPut: (v: (signal?: AbortSignal) => Promise<any>) => { putOverride = v } }
}

test('default off and mandatory verifier; no trusted request property bypass', async () => {
  const app = express(); app.use('/certs', privateCertificatesRouter())
  const { server, base } = await listen(app)
  try { const r = await fetch(`${base}/certs/c1`); assert.equal(r.status, 503); assert.equal(r.headers.get('cache-control'), 'private, no-store') }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  assert.throws(() => privateCertificatesRouter({ enabled: true }), /required/)
  const f = fixture(), site = await listen(f.app)
  try {
    for (const method of ['GET','PUT']) {
      const r = await fetch(`${site.base}/certs/c1`, { method }); assert.equal(r.status, 401)
    }
    assert.equal(f.writes, 0); assert.equal(f.reads, 0)
  } finally { site.server.closeAllConnections(); await new Promise<void>(resolve => site.server.close(() => resolve())) }
})

test('only current verified sub ownership can upload and download, all responses private and no keys exposed', async () => {
  const f = fixture(), { server, base } = await listen(f.app)
  const request = (path: string, method: string, token: string, body?: Buffer, type = 'application/pdf') => fetch(`${base}${path}`, { method, headers: { authorization: token, ...(body ? { 'content-type': type } : {}) }, body })
  try {
    for (const role of ['gc','client']) {
      assert.equal((await request('/certs/c1','GET',role)).status, role === 'gc' ? 503 : 404)
      assert.equal((await request('/certs/c1','PUT',role,pdf)).status, role === 'gc' ? 503 : 404)
    }
    assert.equal((await request('/certs/c1?key=attacker','PUT','sub',pdf)).status, 400)
    assert.equal((await request('/certs/c1','PUT','sub',pdf,'image/png')).status, 400)
    assert.equal((await request('/certs/c1','PUT','sub',Buffer.from('{}'),'application/json')).status, 400)
    assert.equal(f.writes, 0)
    const up = await request('/certs/c1','PUT','sub',pdf)
    assert.equal(up.status, 201); assert.equal(up.headers.get('cache-control'),'private, no-store')
    const json = await up.text(); assert.deepEqual(JSON.parse(json), { mime: 'application/pdf', size: pdf.length }); assert.doesNotMatch(json, /private-certificates|key/i)
    assert.equal(f.writes, 1)
    const down = await request('/certs/c1','GET','sub')
    assert.equal(down.status, 200); assert.equal(down.headers.get('cache-control'),'private, no-store'); assert.equal(down.headers.get('x-content-type-options'),'nosniff'); assert.equal(down.headers.get('content-disposition'),'attachment; filename="certificate.pdf"')
    assert.deepEqual(Buffer.from(await down.arrayBuffer()), pdf)
    assert.doesNotMatch(JSON.stringify([...down.headers]), /private-certificates/i)
    for (const setter of [() => f.setRole('gc'), () => { f.setRole('sub'); f.setActive(false) }, () => { f.setActive(true); f.setOwned(false) }]) {
      setter(); assert.equal((await request('/certs/c1','GET','sub')).status,404); assert.equal((await request('/certs/c1','PUT','sub',pdf)).status,404)
    }
    assert.equal(f.reads, 1)
    f.setOwned(true)
    const duplicate = await request('/certs/c1','PUT','sub',pdf); assert.equal(duplicate.status,503); assert.doesNotMatch(await duplicate.text(), /secret|key|duplicate/i)
    assert.equal((await request('/certs/other','GET','sub')).status,404)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('upload limits, bad streams and disconnected download fail safely', async () => {
  const f = fixture(), { server, base } = await listen(f.app)
  try {
    const tooBig = Buffer.alloc(MAX_CERTIFICATE_BYTES + 1); pdf.copy(tooBig)
    const big = await fetch(`${base}/certs/c1`, { method:'PUT', headers:{ authorization:'sub','content-type':'application/pdf' }, body:tooBig })
    assert.equal(big.status,400); assert.equal(f.writes,0)
    const up = await fetch(`${base}/certs/c1`, { method:'PUT', headers:{ authorization:'sub','content-type':'application/pdf' }, body:pdf }); assert.equal(up.status,201)
    let upstream: Readable | undefined
    f.setSource(() => { let sent = false; upstream = new Readable({ read() { if (!sent) { sent = true; this.push(pdf.subarray(0, 5)) } } }); return upstream })
    // The source cannot be fully consumed before the client closes; close propagates upstream.
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}/certs/c1`, { headers:{ authorization:'sub' } }, res => {
        res.once('data', () => { res.destroy(); resolve() })
      }); req.on('error', reject)
    })
    for (let i=0; i<100 && !upstream?.destroyed; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(upstream?.destroyed,true)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('disconnect aborts a pending mock S3 request', async () => {
  const f = fixture(), { server, base } = await listen(f.app)
  try {
    const up = await fetch(`${base}/certs/c1`, { method:'PUT', headers:{ authorization:'sub','content-type':'application/pdf' }, body:pdf }); assert.equal(up.status,201)
    let notifyStart!: () => void, notifyAbort!: () => void
    const started = new Promise<void>(resolve => { notifyStart = resolve })
    const aborted = new Promise<void>(resolve => { notifyAbort = resolve })
    f.setGet(async signal => { notifyStart(); return await new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { notifyAbort(); reject(new Error('secret')) }, { once:true })
    }) })
    const req = http.get(`${base}/certs/c1`, { headers:{ authorization:'sub' } })
    req.on('error', () => {})
    await started; req.destroy()
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('S3 cancellation timeout')), 1500))])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('chunked excess is rejected and a truncated object is never completed successfully', async () => {
  const f = fixture(), { server, base } = await listen(f.app)
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/certs/c1`, { method: 'PUT', headers: { authorization: 'sub', 'content-type': 'application/pdf', 'transfer-encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject)
      req.write(pdf)
      for (let i=0; i<11; i++) req.write(Buffer.alloc(1024*1024))
      req.end()
    })
    assert.equal(status,400); assert.equal(f.writes,0)
    const up = await fetch(`${base}/certs/c1`, { method:'PUT', headers:{ authorization:'sub','content-type':'application/pdf' }, body:pdf }); assert.equal(up.status,201)
    f.setSource(() => Readable.from([pdf.subarray(0, 5)]))
    await assert.rejects(async () => { const result = await fetch(`${base}/certs/c1`, { headers:{ authorization:'sub' } }); await result.arrayBuffer() })
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('disconnect aborts a pending upload and does not create metadata', async () => {
  const f = fixture(), { server, base } = await listen(f.app)
  try {
    let start!: () => void, abort!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const aborted = new Promise<void>(resolve => { abort = resolve })
    f.setPut(async signal => { start(); return await new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { abort(); reject(new Error('secret')) }, { once:true })
    }) })
    const req = http.request(`${base}/certs/c1`, { method:'PUT', headers:{ authorization:'sub','content-type':'application/pdf' } })
    req.on('error', () => {}); req.end(pdf)
    await started; req.destroy()
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('S3 cancellation timeout')), 1500))])
    assert.equal(f.records.size,0)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
