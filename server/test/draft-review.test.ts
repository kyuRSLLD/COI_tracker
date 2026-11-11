import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

// A disposable copy ensures even private local files and the database are never real data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const oldCwd = process.cwd(), oldEnv = { ...process.env }
const temp = await mkdtemp(path.join(tmpdir(), 'coi-draft-review-'))
process.once('exit', () => { try { rmSync(temp, { recursive: true, force: true }) } catch {} })
let server: Server | undefined
after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()))
  process.chdir(oldCwd); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, oldEnv)
  await rm(temp, { recursive: true, force: true })
})
const copy = path.join(temp, 'server')
await mkdir(copy)
await cp(path.join(root, 'src'), path.join(copy, 'src'), { recursive: true })
await cp(path.join(root, 'package.json'), path.join(copy, 'package.json'))
await symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir')
await symlink(path.join(root, '..', 'node_modules'), path.join(temp, 'node_modules'), 'dir')
process.chdir(temp)
const oldPath = process.env.PATH
for (const key of Object.keys(process.env)) delete process.env[key]
const secret = randomBytes(32).toString('hex')
Object.assign(process.env, { PATH: oldPath || '/usr/bin:/bin', HOME: temp, TMPDIR: temp, NODE_ENV: 'test', SQLITE_PATH: path.join(temp, 'test.sqlite'), JWT_SECRET: secret, AWS_EC2_METADATA_DISABLED: 'true' })
const modulePath = (s: string) => pathToFileURL(path.join(copy, 'src', s)).href
const { default: express } = await import('express')
const { default: jwtLib } = await import('jsonwebtoken')
const { dbRun, dbGet, dbAll, initDatabase, isPostgres } = await import(modulePath('db/db.ts'))
const { signToken } = await import(modulePath('middleware/auth.ts'))
const { draftReviewRouter } = await import(modulePath('routes/draftReview.ts'))
const { ensureDraftTable } = await import(modulePath('services/coiOcr.ts'))
const { saveRequirements } = await import(modulePath('services/verificationRules.ts'))
assert.equal(isPostgres, false)
await initDatabase(); await ensureDraftTable()
const stamp = new Date().toISOString()
for (const [user, role] of [['g1', 'gc'], ['g2', 'gc'], ['s1', 'sub'], ['s2', 'sub'], ['client', 'client']]) {
  await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [user, `${user}@example.test`, 'unused', `${user} name`, role, stamp])
}
for (const [project, owner] of [['p1', 'g1'], ['p2', 'g2']]) await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', [project, owner, `${project} project`, stamp])
const privateDir = path.join(copy, '.work/private-uploads')
await mkdir(privateDir, { recursive: true })
const bytes = Buffer.from('%PDF-1.4\nsynthetic-test-document\n%%EOF')
const keys: Record<string, string> = {}
for (const s of ['s1', 's2']) {
  const key = randomUUID(); keys[s] = key
  await writeFile(path.join(privateDir, key), bytes)
  await dbRun(`INSERT INTO sub_coi_drafts (id, owner_user_id, subcontractor_id, storage_backend, storage_key, certificate_name, certificate_size, certificate_mime, status, ocr_status, ocr_result, created_at, updated_at)
    VALUES (?, ?, ?, 'local', ?, ?, ?, 'application/pdf', 'pending_review', 'completed', ?, ?, ?)`, [`d${s}`, s, `profile-${s}`, key, `${s}-synthetic.pdf`, bytes.length, JSON.stringify({ proposal: { status: 'unverified', fields: { generalLiabilityEachOccurrence: { status: 'proposed', value: 2000000, evidence: [] } } } }), stamp, stamp])
}
await saveRequirements('p1', { gl_per_occurrence_min: 1000000, gl_aggregate_min: null, auto_limit_min: null, umbrella_limit_min: null, workers_comp_required: true, additional_insured_required: true }, 0)
const app = express(); app.use(express.json()); app.use('/api/draft-review', draftReviewRouter)
server = app.listen(0, '127.0.0.1')
await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
const address = server.address(); assert.ok(address && typeof address !== 'string')
const base = `http://127.0.0.1:${address.port}`
const auth: Record<string, string> = {}
for (const [name, role] of [['g1', 'gc'], ['g2', 'gc'], ['s1', 'sub'], ['s2', 'sub'], ['client', 'client']]) auth[name] = signToken({ id: name, role, email: `${name}@example.test`, name })
async function req(route: string, who?: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: { ...(who ? { Authorization: `Bearer ${auth[who]}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data: any = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
  return { status: response.status, data, headers: response.headers }
}
const api = '/api/draft-review'
const create = (gc = 'g1', project = 'p1') => req(`${api}/projects/${project}/invitations`, gc, 'POST', { expires_in_hours: 24 })
const consent = (sub: string, token: string, draft: string, project = 'p1') => req(`${api}/permissions`, sub, 'POST', { token, project_id: project, draft_id: draft, consent: true })
let invite: any, permission: any, link: any

test('roles, project ownership, strict input and no legacy association access', async () => {
  assert.equal((await req(`${api}/projects/p1/drafts`)).status, 401)
  assert.equal((await create('g2', 'p1')).status, 404)
  assert.equal((await create('s1', 'p1')).status, 403)
  await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', ['legacy-link', 'p1', 'profile-s2', stamp])
  assert.equal((await req(`${api}/my/permissions`, 'g1')).status, 403)
  assert.equal((await req(`${api}/my/permissions`, 'client')).status, 403)
  assert.equal((await req(`${api}/projects/p1/invitations`, 'g1', 'POST', { expires_in_hours: 169 })).status, 400)
  assert.equal((await req(`${api}/projects/p1/invitations`, 'g1', 'POST', { expires_in_hours: 1, target_email: 'x@example.test' })).status, 400)
  assert.equal((await req(`${api}/my/drafts?token=bad`, 's1')).status, 400)
  const result = await create(); assert.equal(result.status, 201); invite = result.data.invitation
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(Buffer.from(invite.token, 'base64url').length, 32)
  const stored = await dbGet('SELECT * FROM draft_review_permissions WHERE id = ?', [invite.id])
  assert.equal(stored.token_hash, createHash('sha256').update(invite.token).digest('hex'))
  assert.ok(!JSON.stringify(stored).includes(invite.token))
  assert.ok(!JSON.stringify((await req(`${api}/projects/p1/invitations`, 'g1')).data).includes(invite.token))
  assert.deepEqual((await req(`${api}/projects/p1/drafts`, 'g1')).data.drafts, [])
  assert.equal((await req(`${api}/projects/p1/drafts/${invite.id}`, 'g1')).status, 404)
})

test('preview identifies owner and project; opt-in requires own draft and exact project', async () => {
  const preview = await req(`${api}/invitations/preview`, 's1', 'POST', { token: invite.token })
  assert.equal(preview.status, 200); assert.equal(preview.data.invitation.project_id, 'p1'); assert.equal(preview.data.invitation.gc_name, 'g1 name')
  assert.equal(preview.data.invitation.gc_user_id, 'g1')
  assert.equal((await consent('s1', invite.token, 'ds2')).status, 404)
  assert.equal((await consent('s1', invite.token, 'ds1', 'p2')).status, 404)
  assert.equal((await req(`${api}/permissions`, 's1', 'POST', { token: invite.token, project_id: 'p1', draft_id: 'ds1', consent: false })).status, 400)
  const accepted = await consent('s1', invite.token, 'ds1'); assert.equal(accepted.status, 201); permission = accepted.data.permission
  assert.equal(permission.project_id, 'p1')
  assert.equal((await consent('s2', invite.token, 'ds2')).status, 404)
  assert.equal((await req(`${api}/invitations/preview`, 's2', 'POST', { token: invite.token })).status, 404)
  assert.equal((await req(`${api}/my/permissions`, 's1')).data.permissions[0].id, permission.id)
  assert.deepEqual((await req(`${api}/my/permissions`, 's2')).data.permissions, [])
})

test('only GC owner sees consented draft and unknown-only comparison; no underlying URL or key', async () => {
  assert.equal((await req(`${api}/projects/p1/drafts/${permission.id}`, 'g2')).status, 404)
  assert.equal((await req(`${api}/projects/p2/drafts/${permission.id}`, 'g2')).status, 404)
  const listing = await req(`${api}/projects/p1/drafts`, 'g1'); assert.equal(listing.data.drafts.length, 1)
  const result = await req(`${api}/projects/p1/drafts/${permission.id}`, 'g1'); assert.equal(result.status, 200)
  const review = result.data.review
  assert.equal(review.proposal.fields.generalLiabilityEachOccurrence.value, 2000000)
  assert.equal(review.requirements_version, 1); assert.equal(review.evaluation.status, 'needs_review')
  assert.ok(review.evaluation.criteria.every((c: any) => c.status === 'unknown'))
  assert.match(review.disclaimer, /not approval|not.*verification/i)
  for (const data of [listing.data, result.data]) {
    assert.ok(!JSON.stringify(data).includes(keys.s1)); assert.ok(!JSON.stringify(data).includes('storage_key')); assert.ok(!JSON.stringify(data).includes(invite.token))
  }
  assert.equal((await dbGet('SELECT COUNT(*) AS n FROM cois')).n, 0)
})

test('authenticated signed private document access is recipient-scoped, expiring, and rechecks consent', async () => {
  const url = `${api}/projects/p1/drafts/${permission.id}/document-link`
  assert.equal((await req(url, 'g2', 'POST', {})).status, 404)
  const issued = await req(url, 'g1', 'POST', {}); assert.equal(issued.status, 200); link = issued.data
  assert.equal(link.expires_in_seconds, 120); assert.ok(!JSON.stringify(link).includes(keys.s1)); assert.ok(!link.path.includes(link.capability))
  assert.equal((await req(link.path, 'g1')).status, 404)
  assert.equal((await req(link.path, 'g2', 'GET', undefined, { 'X-Draft-Document-Capability': link.capability })).status, 404)
  assert.equal((await req(link.path, undefined, 'GET', undefined, { 'X-Draft-Document-Capability': link.capability })).status, 401)
  const signedKey = createHmac('sha256', secret).update('coi-draft-gc-document-v1').digest()
  const expired = jwtLib.sign({ purpose: 'gc-draft-document', gc: 'g1', project: 'p1', permission: permission.id, draft: 'ds1', iat: Math.floor(Date.now() / 1000) - 300 }, signedKey, { algorithm: 'HS256', expiresIn: 120 })
  assert.equal((await req(link.path, 'g1', 'GET', undefined, { 'X-Draft-Document-Capability': expired })).status, 404)
  const file = await req(link.path, 'g1', 'GET', undefined, { 'X-Draft-Document-Capability': link.capability })
  assert.equal(file.status, 200); assert.deepEqual(file.data, bytes); assert.match(file.headers.get('cache-control') || '', /no-store/)
  assert.equal((await req(`${api}/permissions/${permission.id}/revoke`, 's2', 'POST', {})).status, 404)
  assert.equal((await req(`${api}/permissions/${permission.id}/revoke`, 's1', 'POST', {})).status, 200)
  assert.equal((await req(link.path, 'g1', 'GET', undefined, { 'X-Draft-Document-Capability': link.capability })).status, 404)
  assert.equal((await req(url, 'g1', 'POST', {})).status, 404)
  assert.deepEqual((await req(`${api}/projects/p1/drafts`, 'g1')).data.drafts, [])
})

test('expired, revoked and concurrently used invitations fail closed', async () => {
  const exp = (await create()).data.invitation
  await dbRun('UPDATE draft_review_permissions SET invitation_expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', exp.id])
  assert.equal((await consent('s1', exp.token, 'ds1')).status, 404)
  assert.equal((await req(`${api}/invitations/preview`, 's1', 'POST', { token: exp.token })).status, 404)
  const revoked = (await create()).data.invitation
  assert.equal((await req(`${api}/permissions/${revoked.id}/revoke`, 'g2', 'POST', {})).status, 404)
  assert.equal((await req(`${api}/permissions/${revoked.id}/revoke`, 'g1', 'POST', {})).status, 200)
  assert.equal((await consent('s1', revoked.token, 'ds1')).status, 404)
  const concurrent = (await create()).data.invitation
  const outcomes = await Promise.all([consent('s1', concurrent.token, 'ds1'), consent('s2', concurrent.token, 'ds2')])
  assert.deepEqual(outcomes.map(x => x.status).sort(), [201, 404])
  assert.equal((await dbAll('SELECT * FROM draft_review_permissions WHERE id = ? AND consented_at IS NOT NULL', [concurrent.id])).length, 1)
})

test('project transfer, role changes, and owner changes invalidate existing access', async () => {
  const invitation = (await create()).data.invitation
  const accepted = (await consent('s1', invitation.token, 'ds1')).data.permission
  const path = `${api}/projects/p1/drafts/${accepted.id}`
  assert.equal((await req(path, 'g1')).status, 200)
  await dbRun('UPDATE projects SET user_id = ? WHERE id = ?', ['g2', 'p1'])
  assert.equal((await req(path, 'g1')).status, 404); assert.equal((await req(path, 'g2')).status, 404)
  const transferred = (await req(`${api}/my/permissions`, 's1')).data.permissions.find((p: any) => p.id === accepted.id)
  assert.equal(transferred.project_name, null); assert.equal(transferred.active, 0)
  await dbRun('UPDATE projects SET user_id = ? WHERE id = ?', ['g1', 'p1'])
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['client', 's1'])
  assert.equal((await req(path, 'g1')).status, 404); assert.equal((await req(`${api}/my/permissions`, 's1')).status, 401)
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['sub', 's1'])
  await dbRun('UPDATE sub_coi_drafts SET owner_user_id = ? WHERE id = ?', ['s2', 'ds1'])
  assert.equal((await req(path, 'g1')).status, 404)
  await dbRun('UPDATE sub_coi_drafts SET owner_user_id = ? WHERE id = ?', ['s1', 'ds1'])
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['client', 'g1'])
  assert.equal((await req(path, 'g1')).status, 401)
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', 'g1'])
})

test('second GC and sub have independent consent; forged links and unsafe configuration fail closed', async () => {
  const invitation = (await create('g2', 'p2')).data.invitation
  const accepted = await consent('s2', invitation.token, 'ds2', 'p2')
  assert.equal(accepted.status, 201)
  const permission2 = accepted.data.permission.id
  const endpoint = `${api}/projects/p2/drafts/${permission2}`
  assert.equal((await req(endpoint, 'g2')).status, 200)
  assert.equal((await req(endpoint, 'g1')).status, 404)
  assert.equal((await req(`${api}/projects/p1/drafts/${permission2}`, 'g1')).status, 404)
  assert.equal((await req(`${api}/permissions/${permission2}/revoke`, 's1', 'POST', {})).status, 404)
  const issued = await req(`${endpoint}/document-link`, 'g2', 'POST', {})
  assert.equal(issued.status, 200)
  assert.equal((await req(issued.data.path, 'g2', 'GET', undefined, { 'X-Draft-Document-Capability': `${issued.data.capability}x` })).status, 404)
  assert.equal((await req(issued.data.path, 'g2', 'GET', undefined, { 'X-Draft-Document-Capability': link.capability })).status, 404)
  const originalAuth = auth.g2
  process.env.JWT_SECRET = ''
  auth.g2 = signToken({ id: 'g2', role: 'gc', email: 'g2@example.test', name: 'g2' })
  try { assert.equal((await req(`${endpoint}/document-link`, 'g2', 'POST', {})).status, 503) }
  finally { process.env.JWT_SECRET = secret; auth.g2 = originalAuth }
  process.env.NODE_ENV = 'production'
  try { assert.equal((await req(`${endpoint}/document-link`, 'g2', 'POST', {})).status, 503) }
  finally { process.env.NODE_ENV = 'test' }
  assert.equal((await req(`${api}/permissions/${permission2}/revoke`, 'g2', 'POST', {})).status, 200)
  assert.equal((await req(issued.data.path, 'g2', 'GET', undefined, { 'X-Draft-Document-Capability': issued.data.capability })).status, 404)
})
