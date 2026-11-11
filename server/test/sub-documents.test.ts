import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { PDFDocument } from 'pdf-lib'
import sharp from 'sharp'

// The application currently derives its upload directories from import.meta.url. Copy
// its source to a disposable root so even its local storage cannot touch the checkout.
// This file never imports the app/db before replacing the environment and cwd.
const repoServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const originalCwd = process.cwd()
const oldEnv = { ...process.env }
const temp = await mkdtemp(path.join(tmpdir(), 'coi-sub-documents-'))
// node:test does not run after hooks when top-level initialization throws.
process.once('exit', () => { try { rmSync(temp, { recursive: true, force: true }) } catch {} })
let server: Server | undefined
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()))
  process.chdir(originalCwd)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, oldEnv)
  await rm(temp, { recursive: true, force: true })
})

const testServer = path.join(temp, 'server')
await mkdir(testServer)
await cp(path.join(repoServer, 'src'), path.join(testServer, 'src'), { recursive: true })
await cp(path.join(repoServer, 'package.json'), path.join(testServer, 'package.json'))
await symlink(path.join(repoServer, 'node_modules'), path.join(testServer, 'node_modules'), 'dir')
await symlink(path.join(repoServer, '..', 'node_modules'), path.join(temp, 'node_modules'), 'dir')
process.chdir(temp) // Prevent dotenv from loading a developer's .env.
const oldPath = process.env.PATH
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  PATH: oldPath || '/usr/bin:/bin', HOME: temp, TMPDIR: temp,
  NODE_ENV: 'test', SQLITE_PATH: path.join(temp, 'isolated.sqlite'),
  JWT_SECRET: randomBytes(32).toString('hex'),
  MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AWS_EC2_METADATA_DISABLED: 'true',
})
const imported = (relative: string) => pathToFileURL(path.join(testServer, 'src', relative)).href
const { createApp } = await import(imported('app.ts'))
const { dbGet, dbAll, dbRun, isPostgres } = await import(imported('db/db.ts'))
const { signToken, signAdminToken } = await import(imported('middleware/auth.ts'))
assert.equal(isPostgres, false, 'tests must never connect to PostgreSQL')
const app = await createApp()
const now = '2026-01-01T00:00:00.000Z'
for (const [id, role] of [['alice', 'sub'], ['bob', 'sub'], ['gc', 'gc'], ['admin', 'admin'], ['client', 'client']]) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, subcontractor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, `${id}@example.test`, 'unused', id, role, role === 'sub' ? `sub-${id}` : null, now])
  if (role === 'sub') await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [`sub-${id}`, id, `${id} company`, 'Test trade', now, now])
}
server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
const address = server.address()
assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const token = (id: string, role: string) => signToken({ id, role, email: `${id}@example.test`, name: id })
const alice = token('alice', 'sub'), bob = token('bob', 'sub')
let admin: string
if (signAdminToken) {
  const { initAdminMfa } = await import(imported('services/adminMfa.ts'))
  await initAdminMfa()
  await dbRun('INSERT INTO admin_mfa_credentials (user_id, credential_id, secret_ciphertext, last_counter) VALUES (?, ?, ?, ?)', ['admin', 'test-credential', 'not-used-for-session-validation', 0])
  await dbRun('INSERT INTO admin_mfa_sessions (id, user_id, credential_id, password_fingerprint, expires_at) VALUES (?, ?, ?, ?, ?)',
    ['test-session', 'admin', 'test-credential', createHash('sha256').update('unused').digest('hex'), Math.floor(Date.now() / 1000) + 3600])
  admin = signAdminToken({ id: 'admin', role: 'admin', email: 'admin@example.test', name: 'admin' }, 'test-session', 3600)
} else admin = token('admin', 'admin')
const nonSubs = [token('gc', 'gc'), admin, token('client', 'client')]
const invalidIdentities = [token('gc', 'sub'), token('missing', 'sub')]
async function request(route: string, options: { jwt?: string; method?: string; body?: BodyInit; json?: unknown } = {}) {
  const headers: Record<string, string> = {}
  if (options.jwt) headers.Authorization = `Bearer ${options.jwt}`
  let body = options.body
  if (options.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.json) }
  const response = await fetch(`${base}${route}`, { method: options.method || 'GET', headers, body })
  const type = response.headers.get('content-type') || ''
  const data: any = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  return { status: response.status, data, headers: response.headers }
}
function formFile(bytes: Uint8Array, filename: string, contentType: string, fields: Record<string, string> = {}, field = 'certificate') {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  form.append(field, new Blob([bytes], { type: contentType }), filename)
  return form
}
const upload = (jwt: string, body: FormData) => request('/api/sub/quick-upload', { jwt, method: 'POST', body })
const count = async (table: string) => Number((await dbGet(`SELECT COUNT(*) AS n FROM ${table}`)).n)
const files = async (dir: string) => readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e })
const privateDir = path.join(testServer, '.work/private-uploads')
const publicDir = path.join(testServer, 'uploads')
const pdf = await PDFDocument.create(); pdf.addPage([100, 100])
const pdfBytes = Buffer.from(await pdf.save())
const pngBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abc123' } }).png().toBuffer()
const jpegBytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123abc' } }).jpeg().toBuffer()
let aliceDrafts: any[] = []
let bobDraft: any

test('upload authentication is checked before accepting a document', async () => {
  assert.equal((await request('/api/sub/quick-upload', { method: 'POST', body: formFile(pdfBytes, 'a.pdf', 'application/pdf') })).status, 401)
  for (const jwt of nonSubs) {
    assert.equal((await upload(jwt, formFile(pdfBytes, 'a.pdf', 'application/pdf'))).status, 403)
  }
  for (const jwt of invalidIdentities) {
    assert.ok([401, 403].includes((await upload(jwt, formFile(pdfBytes, 'a.pdf', 'application/pdf'))).status))
  }
  assert.equal(await count('cois'), 0)
})

test('missing, invalid, corrupted, unexpected and oversized uploads are rejected without persistence', async () => {
  // Initialize the draft table via the real dashboard route.
  assert.equal((await request('/api/sub/my', { jwt: alice })).status, 200)
  const beforeFiles = await files(privateDir)
  const before = await count('sub_coi_drafts')
  const cases: Array<[string, FormData, number]> = [
    ['missing', new FormData(), 400],
    ['wrong field', formFile(pdfBytes, 'a.pdf', 'application/pdf', {}, 'file'), 400],
    ['empty', formFile(Buffer.alloc(0), 'a.pdf', 'application/pdf'), 400],
    ['text disguised as PDF', formFile(Buffer.from('not a certificate'), 'a.pdf', 'application/pdf'), 400],
    ['corrupt PDF', formFile(Buffer.from('%PDF-1.7\nnot a real document'), 'a.pdf', 'application/pdf'), 400],
    ['corrupt PNG', formFile(Buffer.from([137,80,78,71,13,10,26,10,0,0]), 'a.png', 'image/png'), 400],
    ['corrupt JPEG', formFile(Buffer.from([255,216,255,0,255,217]), 'a.jpg', 'image/jpeg'), 400],
    ['too large', formFile(Buffer.alloc(25 * 1024 * 1024 + 1, 0x61), 'big.pdf', 'application/pdf'), 413],
  ]
  const multiple = formFile(pdfBytes, 'a.pdf', 'application/pdf')
  multiple.append('certificate', new Blob([pdfBytes], { type: 'application/pdf' }), 'b.pdf')
  cases.push(['multiple files', multiple, 400])
  for (const [label, body, status] of cases) assert.equal((await upload(alice, body)).status, status, label)
  assert.equal(await count('sub_coi_drafts'), before)
  assert.equal(await count('cois'), 0)
  assert.equal(await count('coi_coverages'), 0)
  assert.deepEqual(await files(privateDir), beforeFiles)
})

test('PDF, PNG and JPEG upload as unverified owner-scoped drafts without fabricated insurance data', async () => {
  const falseClaims = { carrier: 'Fake Verified Carrier', policy_number: 'FAKE-123', effective_date: '2020-01-01', expiration_date: '2099-01-01', status: 'compliant', verified: 'true', coverages: JSON.stringify([{ type: 'General Liability', per_occurrence_limit: '$99999999' }]), subcontractor_id: 'sub-bob', ocr_status: 'completed' }
  const examples: Array<[Buffer, string, string]> = [[pdfBytes, 'cert.pdf', 'application/pdf'], [pngBytes, 'cert.png', 'image/png'], [jpegBytes, 'cert.jpg', 'image/jpeg']]
  for (const [bytes, filename, mime] of examples) {
    const result = await upload(alice, formFile(bytes, filename, mime, falseClaims))
    assert.equal(result.status, 201, filename)
    const draft = result.data
    assert.ok(draft.id)
    assert.equal(draft.subcontractor_id, 'sub-alice')
    assert.equal(draft.status, 'pending_review')
    assert.equal(draft.ocr_status, 'not_configured')
    assert.equal(draft.certificate_mime, mime)
    assert.equal(draft.certificate_size, bytes.length)
    for (const field of ['carrier', 'policy_number', 'effective_date', 'expiration_date']) assert.equal(draft[field], null, field)
    assert.deepEqual(draft.coverages, [])
    assert.notEqual(draft.verified, true)
    assert.match(draft.message, /human review/i)
    assert.ok(typeof draft.certificate_url === 'string')
    const retrieved = await request(draft.certificate_url)
    assert.equal(retrieved.status, 200)
    assert.equal(retrieved.headers.get('content-type'), mime)
    assert.deepEqual(retrieved.data, bytes)
    aliceDrafts.push(draft)
  }
  const second = await upload(bob, formFile(pdfBytes, 'bob.pdf', 'application/pdf'))
  assert.equal(second.status, 201)
  bobDraft = second.data
  assert.equal(bobDraft.subcontractor_id, 'sub-bob')
  assert.equal(bobDraft.status, 'pending_review')
  assert.equal(bobDraft.ocr_status, 'not_configured')
  assert.equal(await count('cois'), 0)
  assert.equal(await count('coi_coverages'), 0)
  assert.equal(await count('sub_coi_drafts'), 4)
  const rows = await dbAll('SELECT owner_user_id, subcontractor_id, status, ocr_status, ocr_result, storage_backend, storage_key FROM sub_coi_drafts')
  for (const row of rows) {
    assert.equal(row.subcontractor_id, `sub-${row.owner_user_id}`)
    assert.equal(row.status, 'pending_review')
    assert.equal(row.ocr_status, 'not_configured')
    assert.equal(row.ocr_result, null)
    assert.equal(row.storage_backend, 'local')
    assert.equal((await request(`/uploads/${encodeURIComponent(row.storage_key)}`)).status, 404)
  }
  assert.equal((await files(privateDir)).length, 4)
  assert.deepEqual(await files(publicDir), [])
})

test('OCR status and dashboard drafts are visible only to their actual owner', async () => {
  const route = (id: string) => `/api/sub/quick-upload/${encodeURIComponent(id)}/ocr`
  for (const [jwt, owned, other] of [[alice, aliceDrafts[0], bobDraft], [bob, bobDraft, aliceDrafts[0]]]) {
    const result = await request(route(owned.id), { jwt })
    assert.equal(result.status, 200)
    assert.equal(result.data.id, owned.id)
    assert.equal(result.data.status, 'pending_review')
    assert.equal(result.data.ocr_status, 'not_configured')
    assert.equal(result.data.ocr_draft, null)
    assert.match(result.data.message, /human review/i)
    assert.equal((await request(route(other.id), { jwt })).status, 404)
    assert.equal((await request(route('does-not-exist'), { jwt })).status, 404)
    const dash = await request('/api/sub/my', { jwt })
    assert.equal(dash.status, 200)
    const ids = dash.data.cois.map((c: any) => c.id)
    assert.ok(ids.includes(owned.id)); assert.ok(!ids.includes(other.id))
    assert.ok(dash.data.cois.every((c: any) => c.status === 'pending_review' && c.ocr_status === 'not_configured' && c.coverages.length === 0))
  }
  assert.equal((await request(route(aliceDrafts[0].id))).status, 401)
  for (const jwt of nonSubs) {
    assert.equal((await request(route(aliceDrafts[0].id), { jwt })).status, 403)
    assert.equal((await request('/api/sub/my', { jwt })).status, 403)
  }
  for (const jwt of invalidIdentities) {
    assert.ok([401, 403].includes((await request(route(aliceDrafts[0].id), { jwt })).status))
  }
  // Local download links are short-lived bearer capabilities, not user sessions.
  const aliceUrl = new URL(aliceDrafts[0].certificate_url, base)
  const bobUrl = new URL(bobDraft.certificate_url, base)
  const crossed = `/api/sub/quick-upload/${encodeURIComponent(bobDraft.id)}/document?token=${encodeURIComponent(aliceUrl.searchParams.get('token') || '')}`
  assert.equal((await request(crossed)).status, 404)
  assert.equal((await request(bobUrl.pathname)).status, 404)
})

test('carrier listing is disabled and connecting never invents a COI or leaks submitted credentials', async () => {
  assert.equal((await request('/api/sub/carriers')).status, 401)
  for (const jwt of nonSubs) assert.equal((await request('/api/sub/carriers', { jwt })).status, 403)
  for (const jwt of [alice, bob]) {
    const listed = await request('/api/sub/carriers', { jwt })
    assert.equal(listed.status, 200)
    assert.ok(Array.isArray(listed.data.carriers) && listed.data.carriers.length > 0)
    assert.ok(listed.data.carriers.every((carrier: any) => carrier.status === 'not_configured'))
    const connect = await request('/api/sub/carrier-connect', { jwt, method: 'POST', json: { carrier: 'Travelers', policy_number: 'invented', username: 'fake-user', password: 'never-echo-this' } })
    assert.equal(connect.status, 503)
    assert.match(connect.data.error, /not configured/i)
    assert.match(connect.data.error, /no policy.*verified/i)
    assert.ok(!JSON.stringify(connect.data).includes('never-echo-this'))
    assert.notEqual(connect.data.verified, true)
  }
  for (const jwt of nonSubs) assert.equal((await request('/api/sub/carrier-connect', { jwt, method: 'POST', json: { carrier: 'Travelers' } })).status, 403)
  assert.equal((await request('/api/sub/carrier-connect', { method: 'POST', json: { carrier: 'Travelers' } })).status, 401)
  assert.equal(await count('cois'), 0)
  assert.equal(await count('coi_coverages'), 0)
  assert.equal(await count('sub_coi_drafts'), 4)
})

test('production without configured S3 fails closed, never falls back to local files or returns local links', async () => {
  const beforeDrafts = await count('sub_coi_drafts')
  const beforePrivate = (await files(privateDir)).sort()
  const beforePublic = (await files(publicDir)).sort()
  process.env.NODE_ENV = 'production'
  try {
    const attempted = await upload(alice, formFile(pdfBytes, 'production.pdf', 'application/pdf'))
    assert.equal(attempted.status, 503)
    assert.equal(await count('sub_coi_drafts'), beforeDrafts)
    assert.equal(await count('cois'), 0)
    assert.deepEqual((await files(privateDir)).sort(), beforePrivate)
    assert.deepEqual((await files(publicDir)).sort(), beforePublic)
    assert.equal((await request(aliceDrafts[0].certificate_url)).status, 404)
    const dash = await request('/api/sub/my', { jwt: alice })
    assert.equal(dash.status, 200)
    assert.equal(dash.data.cois.find((c: any) => c.id === aliceDrafts[0].id).certificate_url, null)
  } finally { process.env.NODE_ENV = 'test' }
})
