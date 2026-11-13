import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// This suite never accesses a preconfigured database or storage service.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-fields-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
for (const name of ['AWS_S3_BUCKET', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_S3_ENDPOINT']) process.env[name] = ''
process.env.JWT_SECRET = 'coi-fields-isolated-test-only'
process.env.NODE_ENV = 'test'
const { createApp } = await import('../src/app.ts')
const { dbGet, dbRun, isPostgres } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

test('field reviews are scoped, validated, non-public and tied to the current certificate', async t => {
  let server: import('node:http').Server | undefined
  let uploadedPath: string | undefined
  t.after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    if (uploadedPath) fs.rmSync(uploadedPath, { force: true })
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  assert.equal(isPostgres, false)
  const app = await createApp()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const now = '2026-01-01T00:00:00.000Z'
  const users = [['gc-a', 'gc'], ['gc-b', 'gc'], ['gc-c', 'gc'], ['sub-a', 'sub'], ['sub-b', 'sub'], ['admin', 'admin']] as const
  for (const [id, role] of users) await dbRun('INSERT INTO users (id,email,password_hash,name,role,created_at) VALUES (?,?,?,?,?,?)', [id, `${id}@example.test`, 'unused', id, role, now])
  for (const [id, owner, date] of [['profile-a', 'sub-a', now], ['profile-b', 'sub-b', now], ['duplicate-a', 'sub-a', '2026-02-01T00:00:00.000Z'], ['unclaimed', null, now]] as const) {
    await dbRun('INSERT INTO subcontractors (id,user_id,company_name,trade,created_at,updated_at) VALUES (?,?,?,?,?,?)', [id, owner, id, 'Trade', date, date])
  }
  // Both GCs connected to the same sub still cannot read each other's GC-owned records.
  for (const [gc, profile] of [['gc-a','profile-a'], ['gc-b','profile-a'], ['gc-c','profile-b'], ['gc-a','duplicate-a'], ['gc-a','unclaimed']] as const) {
    await dbRun('INSERT INTO gc_sub_connections (gc_user_id,subcontractor_id,created_at) VALUES (?,?,?)', [gc, profile, now])
  }
  for (const [id, profile, gc, sub, key] of [
    ['gc-owned','profile-a','gc-a',null,'cois/SECRET_GC_KEY'],
    ['other-gc-owned','profile-a','gc-b',null,'cois/SECRET_OTHER_KEY'],
    ['sub-owned','profile-a',null,'sub-a','cois/SECRET_SUB_KEY'],
    ['cross-tenant','profile-b',null,'sub-b','cois/SECRET_CROSS_KEY'],
    ['dual','profile-a','gc-a','sub-a','cois/SECRET_DUAL_KEY'],
    ['ownerless','profile-a',null,null,'cois/SECRET_LEGACY_KEY'],
    ['wrong-sub','profile-a',null,'sub-b','cois/SECRET_BAD_KEY'],
    ['wrong-gc','profile-a','sub-b',null,'cois/SECRET_BAD_GC_KEY'],
    ['second-profile','duplicate-a','gc-a',null,'cois/SECRET_SECOND_KEY'],
    ['unclaimed-gc','unclaimed','gc-a',null,null],
    ['local-file','profile-a','gc-a',null,'local-file-one'],
    ['legacy','profile-a','gc-a',null,'legacy-file'],
    ['aba','profile-a','gc-a',null,'aba-file'],
    ['bad-key','profile-a','gc-a',null,'../SECRET_BAD_PATH'],
  ] as const) {
    await dbRun(`INSERT INTO cois (id,subcontractor_id,owner_gc_user_id,owner_sub_user_id,carrier,policy_number,effective_date,expiration_date,status,reviewer_notes,certificate_key,certificate_url,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, profile, gc, sub, 'Original carrier', 'Original policy', '2026-01-01', '2030-01-01', 'compliant', 'Original note', key, 'https://legacy.invalid/SECRET_URL', now, now])
  }
  const tokens: Record<string, string> = {}
  for (const [id, role] of users) tokens[id] = signToken({ id, role, email: `${id}@example.test`, name: id })
  // A forged role in a valid JWT cannot change the current DB role.
  tokens.spoof = signToken({ id: 'sub-a', role: 'gc', email: 'x@example.test', name: 'spoof' })
  async function request(id: string, coi: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api/coi-fields/${coi}`, {
      method, headers: { ...(id ? { authorization: `Bearer ${tokens[id]}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const text = await response.text()
    assert.ok(!text.includes('SECRET_') && !text.includes('legacy.invalid'), 'response never reveals certificate keys or legacy URLs')
    return { status: response.status, body: JSON.parse(text) as any }
  }
  const url = (id: string) => `/api/coi-fields/${id}`
  assert.equal((await request('', 'gc-owned')).status, 401)
  assert.equal((await request('admin', 'gc-owned')).status, 404)
  for (const [actor, id] of [['gc-b','gc-owned'], ['gc-a','other-gc-owned'], ['gc-a','cross-tenant'], ['sub-b','gc-owned'], ['sub-b','sub-owned'], ['gc-a','dual'], ['sub-a','dual'], ['gc-a','ownerless'], ['sub-a','ownerless'], ['gc-a','wrong-sub'], ['gc-a','wrong-gc'], ['sub-a','second-profile']] as const) {
    assert.equal((await request(actor, id)).status, 404, `${actor}: ${url(id)}`)
    assert.equal((await request(actor, id, 'PUT', { sourceTag: '', reviewRevision: '', details: {} })).status, 404, `${actor} write ${id}`)
  }
  const gcBefore = await dbGet('SELECT * FROM cois WHERE id = ?', ['gc-owned'])
  const subBefore = await dbGet('SELECT * FROM cois WHERE id = ?', ['sub-owned'])
  const gc = await request('gc-a', 'gc-owned')
  assert.equal(gc.status, 200)
  assert.deepEqual(gc.body.details, null)
  assert.equal(gc.body.editable, true)
  assert.match(gc.body.sourceTag, /^[a-f0-9]{64}$/)
  assert.equal(gc.body.reviewRevision, 'no-review')
  assert.equal(gc.body.certificateUrl, null, 'S3 key cannot be signed by local storage')
  assert.equal((await request('sub-a', 'gc-owned')).body.editable, false)
  assert.equal((await request('spoof', 'gc-owned')).body.editable, false)
  assert.equal((await request('sub-a', 'gc-owned', 'PUT', { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: {} })).status, 403)
  const details = {
    producer: { name: 'SENSITIVE REVIEW DATA', address: '', phone: '', email: '' }, insured: { name: '', address: '' },
    insurers: [{ letter: 'A', name: 'Carrier', naic: '' }],
    policies: [{ type: 'GL', insurerLetter: 'A', policyNumber: 'private policy', effectiveDate: '', expirationDate: '', limits: [{ label: 'Each occurrence', amount: '$1,000,000' }] }],
    source: 'manual',
  }
  const saved = await request('gc-a', 'gc-owned', 'PUT', { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body, { details, sourceTag: gc.body.sourceTag, reviewRevision: saved.body.reviewRevision, certificateUrl: null, editable: true })
  assert.match(saved.body.reviewRevision, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(saved.body.reviewRevision, gc.body.reviewRevision)
  assert.deepEqual((await request('sub-a', 'gc-owned')).body, { details, sourceTag: gc.body.sourceTag, reviewRevision: saved.body.reviewRevision, certificateUrl: null, editable: false })
  assert.deepEqual(await dbGet('SELECT * FROM cois WHERE id = ?', ['gc-owned']), gcBefore)
  assert.equal((await request('gc-a', 'gc-owned', 'PUT', { sourceTag: 'tampered', reviewRevision: saved.body.reviewRevision, details: {} })).status, 409)
  for (const invalid of [
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: {}, unknown: true },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { unknown: 'x' } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { producer: { id: 'x' } } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { insurers: [{ bogus: '' }] } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { policies: [{ limits: [{ extra: '' }] }] } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { producer: null } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { source: 'verified' } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { producer: { name: 'x'.repeat(257) } } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { insurers: Array.from({ length: 11 }, () => ({})) } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { policies: Array.from({ length: 21 }, () => ({})) } },
    { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details: { policies: [{ limits: Array.from({ length: 21 }, () => ({})) }] } },
    { sourceTag: 7, details: {} },
  ]) assert.equal((await request('gc-a', 'gc-owned', 'PUT', invalid)).status, 400, JSON.stringify(invalid).slice(0, 100))
  assert.deepEqual((await request('gc-a', 'gc-owned')).body.details, details)
  // Existing reviews without version rows remain readable and editable. Two
  // editors of that legacy state must not both succeed.
  const legacyEmpty = await request('gc-a', 'legacy')
  await dbRun('INSERT INTO coi_field_reviews (coi_id,source_tag,details_json) VALUES (?,?,?)',
    ['legacy', legacyEmpty.body.sourceTag, JSON.stringify({ insured: { name: 'legacy' } })])
  const legacy = await request('gc-a', 'legacy')
  assert.deepEqual(legacy.body.details, { insured: { name: 'legacy' } })
  assert.equal(legacy.body.reviewRevision, 'no-review')
  const legacyWrites = await Promise.all(['first', 'second'].map(name => request('gc-a', 'legacy', 'PUT', {
    sourceTag: legacy.body.sourceTag, reviewRevision: legacy.body.reviewRevision, details: { insured: { name } },
  })))
  assert.deepEqual(legacyWrites.map(value => value.status).sort(), [200, 409])
  assert.equal((await request('gc-a', 'legacy')).body.reviewRevision, legacyWrites.find(value => value.status === 200)!.body.reviewRevision)
  // X -> Y -> X never restores X's earlier revision; identical writes also
  // advance it so replaying an already successful request fails.
  const initialAba = await request('gc-a', 'aba')
  const saveAba = (revision: string, name: string) => request('gc-a', 'aba', 'PUT', {
    sourceTag: initialAba.body.sourceTag, reviewRevision: revision, details: { insured: { name } },
  })
  const x1 = await saveAba(initialAba.body.reviewRevision, 'X')
  const y = await saveAba(x1.body.reviewRevision, 'Y')
  const x2 = await saveAba(y.body.reviewRevision, 'X')
  assert.deepEqual([x1.status, y.status, x2.status], [200, 200, 200])
  assert.equal(new Set([x1.body.reviewRevision, y.body.reviewRevision, x2.body.reviewRevision]).size, 3)
  assert.equal((await saveAba(x1.body.reviewRevision, 'stale')).status, 409)
  const duplicate = await saveAba(x2.body.reviewRevision, 'X')
  assert.equal(duplicate.status, 200)
  assert.notEqual(duplicate.body.reviewRevision, x2.body.reviewRevision)
  assert.equal((await saveAba(x2.body.reviewRevision, 'X')).status, 409)
  assert.deepEqual((await request('gc-a', 'aba')).body.details, { insured: { name: 'X' } })
  // An error in the second child write must roll back the review as well.
  const beforeFailure = await request('gc-a', 'aba')
  const storedBefore = await dbGet('SELECT * FROM coi_field_reviews WHERE coi_id = ?', ['aba'])
  const versionBefore = await dbGet('SELECT * FROM coi_field_review_versions WHERE coi_id = ?', ['aba'])
  await dbRun(`CREATE TRIGGER fail_review_version BEFORE UPDATE ON coi_field_review_versions
    BEGIN SELECT RAISE(ABORT, 'test-only failure'); END`)
  try {
    const failed = await saveAba(beforeFailure.body.reviewRevision, 'must roll back')
    assert.equal(failed.status, 500)
    assert.deepEqual(failed.body, { error: 'Unable to save field review' })
    assert.deepEqual(await dbGet('SELECT * FROM coi_field_reviews WHERE coi_id = ?', ['aba']), storedBefore)
    assert.deepEqual(await dbGet('SELECT * FROM coi_field_review_versions WHERE coi_id = ?', ['aba']), versionBefore)
    assert.deepEqual((await request('gc-a', 'aba')).body, beforeFailure.body)
  } finally { await dbRun('DROP TRIGGER fail_review_version') }
  assert.equal((await saveAba(beforeFailure.body.reviewRevision, 'after rollback')).status, 200)
  // Independently loaded editors may not silently overwrite each other's work.
  const [editor1, editor2] = await Promise.all([request('gc-a', 'local-file'), request('gc-a', 'local-file')])
  assert.deepEqual(editor1.body, editor2.body)
  assert.equal(editor1.body.certificateUrl, '/uploads/local-file-one')
  const writes = await Promise.all(['One', 'Two'].map(name => request('gc-a', 'local-file', 'PUT', {
    sourceTag: editor1.body.sourceTag, reviewRevision: editor1.body.reviewRevision, details: { insured: { name } },
  })))
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409])
  const winner = writes.find(result => result.status === 200)!
  assert.equal(winner.body.certificateUrl, '/uploads/local-file-one')
  const current = await request('gc-a', 'local-file')
  assert.deepEqual(current.body, winner.body)
  assert.notEqual(current.body.reviewRevision, editor1.body.reviewRevision)
  assert.equal((await request('gc-a', 'local-file', 'PUT', { sourceTag: current.body.sourceTag, details: {} })).status, 400)
  assert.equal((await request('gc-a', 'local-file', 'PUT', { sourceTag: current.body.sourceTag, reviewRevision: null, details: {} })).status, 400)
  assert.equal((await request('gc-a', 'bad-key')).body.certificateUrl, null, 'untrusted key and legacy URL are rejected')
  await dbRun('UPDATE cois SET certificate_key = ? WHERE id = ?', ['local-file-two', 'local-file'])
  const localReplacement = await request('gc-a', 'local-file')
  assert.equal(localReplacement.body.details, null)
  assert.equal(localReplacement.body.certificateUrl, '/uploads/local-file-two')
  assert.notEqual(localReplacement.body.sourceTag, current.body.sourceTag)
  assert.notEqual(localReplacement.body.reviewRevision, current.body.reviewRevision)
  assert.equal((await request('gc-a', 'local-file', 'PUT', { sourceTag: localReplacement.body.sourceTag, reviewRevision: current.body.reviewRevision, details: {} })).status, 409)
  // A stale, corrupt or absent review maps to the explicit no-review sentinel,
  // even if a version row is still present.
  await dbRun('UPDATE coi_field_reviews SET source_tag = ?, details_json = ? WHERE coi_id = ?', [localReplacement.body.sourceTag, '{malformed', 'local-file'])
  assert.equal((await request('gc-a', 'local-file')).body.reviewRevision, localReplacement.body.reviewRevision)
  await dbRun('DELETE FROM coi_field_reviews WHERE coi_id = ?', ['local-file'])
  assert.equal((await request('gc-a', 'local-file')).body.reviewRevision, localReplacement.body.reviewRevision)
  const canonicalSave = await request('gc-a', 'local-file', 'PUT', { sourceTag: localReplacement.body.sourceTag, reviewRevision: localReplacement.body.reviewRevision, details: { insured: { name: 'Name', address: 'Address' }, source: 'manual' } })
  assert.equal(canonicalSave.status, 200)
  await dbRun('UPDATE coi_field_reviews SET details_json = ? WHERE coi_id = ?', ['{"source":"manual","insured":{"address":"Address","name":"Name"}}', 'local-file'])
  assert.equal((await request('gc-a', 'local-file')).body.reviewRevision, canonicalSave.body.reviewRevision)
  const sub = await request('sub-a', 'sub-owned')
  assert.equal(sub.body.editable, true)
  assert.equal((await request('gc-a', 'sub-owned')).body.editable, false)
  assert.equal((await request('gc-a', 'sub-owned', 'PUT', { sourceTag: sub.body.sourceTag, reviewRevision: sub.body.reviewRevision, details: {} })).status, 403)
  const partial = { policies: [{ limits: [{}] }], producer: { name: 'PUBLIC-SENSITIVE-REVIEW-DATA' }, source: 'ocr' }
  assert.deepEqual((await request('sub-a', 'sub-owned', 'PUT', { sourceTag: sub.body.sourceTag, reviewRevision: sub.body.reviewRevision, details: partial })).body.details, partial)
  assert.deepEqual((await request('gc-a', 'sub-owned')).body.details, partial)
  assert.deepEqual(await dbGet('SELECT * FROM cois WHERE id = ?', ['sub-owned']), subBefore)
  const form = new FormData()
  form.append('certificate', new Blob(['%PDF-1.4\ntest'], { type: 'application/pdf' }), 'review.pdf')
  const uploadResponse = await fetch(`${base}/api/sub/quick-upload`, { method: 'POST', headers: { authorization: `Bearer ${tokens['sub-a']}` }, body: form })
  assert.equal(uploadResponse.status, 200)
  const uploaded = await uploadResponse.json() as any
  assert.equal(uploadResponse.headers.get('cache-control'), 'no-store')
  const storedUpload = await dbGet<{ certificate_key: string }>('SELECT certificate_key FROM cois WHERE id = ?', [uploaded.id])
  assert.ok(storedUpload)
  uploadedPath = path.resolve(import.meta.dirname, '../uploads', storedUpload.certificate_key)
  assert.equal(Object.hasOwn(uploaded, 'certificate_key'), false)
  const uploadedFields = await request('sub-a', uploaded.id)
  assert.equal(uploaded.fields_source_tag, uploadedFields.body.sourceTag)
  assert.equal(uploadedFields.body.certificateUrl, `/uploads/${storedUpload.certificate_key}`)
  await dbRun('UPDATE cois SET certificate_key = ? WHERE id = ?', ['replacement-file', uploaded.id])
  const uploadReplaced = await request('sub-a', uploaded.id)
  assert.notEqual(uploaded.fields_source_tag, uploadReplaced.body.sourceTag, 'replacement between upload and GET is detectable')
  assert.equal(uploadReplaced.body.certificateUrl, '/uploads/replacement-file')
  // NULL keys are supported without exposing stored legacy URLs.
  const noKey = await request('gc-a', 'unclaimed-gc')
  assert.equal(noKey.body.editable, true)
  assert.equal((await request('gc-a', 'unclaimed-gc', 'PUT', { sourceTag: noKey.body.sourceTag, reviewRevision: noKey.body.reviewRevision, details: {} })).status, 200)
  await dbRun('UPDATE cois SET certificate_key = ? WHERE id = ?', ['cois/SECRET_NEW_KEY', 'gc-owned'])
  const replaced = await request('gc-a', 'gc-owned')
  assert.equal(replaced.body.details, null)
  assert.notEqual(replaced.body.sourceTag, gc.body.sourceTag)
  assert.equal((await request('gc-a', 'gc-owned', 'PUT', { sourceTag: gc.body.sourceTag, reviewRevision: gc.body.reviewRevision, details })).status, 409)
  assert.equal((await request('gc-a', 'gc-owned', 'PUT', { sourceTag: replaced.body.sourceTag, reviewRevision: replaced.body.reviewRevision, details: { insured: { name: '' } } })).status, 200)
  // Disconnect removes both read and write access; the sub owner retains its own record.
  await dbRun('DELETE FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['gc-a', 'profile-a'])
  assert.equal((await request('gc-a', 'gc-owned')).status, 404)
  assert.equal((await request('gc-a', 'sub-owned')).status, 404)
  assert.equal((await request('sub-a', 'gc-owned')).status, 404)
  assert.equal((await request('sub-a', 'sub-owned')).status, 200)
  assert.equal((await request('gc-a', 'gc-owned', 'PUT', { sourceTag: replaced.body.sourceTag, reviewRevision: replaced.body.reviewRevision, details: {} })).status, 404)
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id,subcontractor_id,created_at) VALUES (?,?,?)', ['gc-a', 'profile-a', now])
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['admin', 'gc-a'])
  assert.equal((await request('gc-a', 'gc-owned')).status, 404, 'signed role is not authority after DB role changes')
  assert.equal((await request('gc-a', 'gc-owned', 'PUT', { sourceTag: replaced.body.sourceTag, reviewRevision: replaced.body.reviewRevision, details: {} })).status, 404)
  await dbRun('UPDATE users SET role = ? WHERE id = ?', ['gc', 'gc-a'])
  // Public share output must not include review JSON or its document tag.
  await dbRun('INSERT INTO projects (id,user_id,name,created_at) VALUES (?,?,?,?)', ['project', 'gc-a', 'Project', now])
  await dbRun('INSERT INTO project_subcontractors (id,project_id,subcontractor_id,created_at) VALUES (?,?,?,?)', ['link', 'project', 'profile-a', now])
  await dbRun('INSERT INTO client_share_links (id,project_id,token,created_at) VALUES (?,?,?,?)', ['share', 'project', 'a'.repeat(48), now])
  const publicResponse = await fetch(`${base}/api/client/share/${'a'.repeat(48)}`)
  assert.equal(publicResponse.status, 200)
  const publicText = await publicResponse.text()
  assert.ok(!publicText.includes('PUBLIC-SENSITIVE-REVIEW-DATA') && !publicText.includes('coi_field_reviews') && !publicText.includes(replaced.body.sourceTag) && !publicText.includes(saved.body.reviewRevision))
  const malformed = await fetch(`${base}/api/coi-fields/gc-owned`, { method: 'PUT', headers: { authorization: `Bearer ${tokens['gc-a']}`, 'content-type': 'application/json' }, body: '{"SECRET_BODY"' })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.headers.get('cache-control'), 'no-store')
  assert.ok(!(await malformed.text()).includes('SECRET_BODY'))
  await dbRun('DELETE FROM cois WHERE id = ?', ['sub-owned'])
  assert.equal(await dbGet('SELECT coi_id FROM coi_field_reviews WHERE coi_id = ?', ['sub-owned']), undefined, 'child is deleted with COI')
  assert.equal(await dbGet('SELECT coi_id FROM coi_field_review_versions WHERE coi_id = ?', ['sub-owned']), undefined, 'version is deleted with COI')
})
