import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Set before importing any app modules. Never contact a configured database or S3.
// Node's test runner runs test files in separate processes by default.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-gc-ownership-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_REGION = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'gc-ownership-test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbAll, dbGet, dbRun, isPostgres } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

const fixtures = {
  a: { id: 'coi-owned-by-a', owner: 'gc-a', expiration: '2097-01-01', note: 'REVIEW-NOTE-ONLY-GC-A' },
  b: { id: 'coi-owned-by-b', owner: 'gc-b', expiration: '2098-01-01', note: 'REVIEW-NOTE-ONLY-GC-B' },
  sub: { id: 'coi-owned-by-sub', owner: 'sub-user', expiration: '2096-01-01', note: 'SUB-REVIEW-NOTE' },
  legacy: { id: 'coi-ambiguous-legacy', owner: null, expiration: '2099-01-01', note: 'LEGACY-REVIEW-NOTE' },
} as const

function assertNoText(value: unknown, secrets: readonly string[], context: string) {
  const text = JSON.stringify(value)
  for (const secret of secrets) assert.ok(!text.includes(secret), `${context} leaked ${secret}`)
}
function assertIds(rows: any[], expected: string[], context: string) {
  assert.ok(Array.isArray(rows), `${context} must be an array`)
  assert.deepEqual(rows.map((row) => row.id).sort(), expected.slice().sort(), context)
}

test('GC COI ownership stays isolated across connected GCs and public views', async (t) => {
  // Register cleanup before initialization so a failing setup still removes the DB.
  let server: ReturnType<Awaited<ReturnType<typeof createApp>>['listen']> | undefined
  const uploadNamePrefix = `ownership-${path.basename(tempDir)}`
  t.after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((err) => err ? reject(err) : resolve()))
    // Storage is local in this test. Remove only this run's uniquely named files,
    // even if a submit failed after writing a file but before inserting its COI.
    const uploadDir = path.resolve(import.meta.dirname, '../uploads')
    if (fs.existsSync(uploadDir)) {
      for (const name of fs.readdirSync(uploadDir)) {
        if (name.endsWith(`${uploadNamePrefix}.pdf`) || name.endsWith(`${uploadNamePrefix}.png`)) {
          fs.rmSync(path.join(uploadDir, name), { force: true })
        }
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  assert.equal(isPostgres, false, 'test must use its temporary SQLite database')
  const app = await createApp({ maintenanceMode: false })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const now = new Date().toISOString()

  for (const [id, role] of [['gc-a', 'gc'], ['gc-b', 'gc'], ['sub-user', 'sub']] as const) {
    await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, `${id}@example.test`, 'unused-test-hash', id, role, now])
  }
  await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['shared-sub', 'sub-user', 'Synthetic Shared Sub', 'Electrical', now, now])
  await dbRun('UPDATE users SET subcontractor_id = ? WHERE id = ?', ['shared-sub', 'sub-user'])
  for (const id of ['gc-a', 'gc-b']) {
    await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [id, 'shared-sub', now])
    await dbRun('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)', [`project-${id}`, id, `Project ${id}`, now])
    await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)', [`link-${id}`, `project-${id}`, 'shared-sub', now])
    const shareToken = id === 'gc-a' ? 'a'.repeat(48) : 'b'.repeat(48)
    await dbRun('INSERT INTO client_share_links (id, project_id, token, created_at) VALUES (?, ?, ?, ?)', [`share-${id}`, `project-${id}`, shareToken, now])
    const uploadToken = `gc1.${Buffer.from(id).toString('base64url')}.${id === 'gc-a' ? 'c'.repeat(48) : 'd'.repeat(48)}`
    await dbRun('INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, created_at) VALUES (?, ?, ?, ?, ?)',
      [`request-${id}`, 'shared-sub', uploadToken, `${id}@example.test`, now])
  }
  for (const [kind, row] of Object.entries(fixtures)) {
    const gcOwner = kind === 'a' || kind === 'b' ? row.owner : null
    const subOwner = kind === 'sub' ? row.owner : null
    await dbRun(`INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, owner_sub_user_id, carrier, policy_number,
      effective_date, expiration_date, status, reviewer_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, 'shared-sub', gcOwner, subOwner, `CARRIER-${kind}`, `POLICY-${kind}`, '2020-01-01', row.expiration,
        kind === 'legacy' ? 'rejected' : 'compliant', row.note, now, now])
    await dbRun('INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, notes) VALUES (?, ?, ?, ?, ?)',
      [`coverage-${kind}`, row.id, 'General Liability', `$${{ a: 1000001, b: 1000002, sub: 1000003, legacy: 1000004 }[kind as 'a' | 'b' | 'sub' | 'legacy']}`, `COVERAGE-SECRET-${kind}`])
  }

  const token = (id: string, role: string) => signToken({ id, email: `${id}@example.test`, role, name: id })
  async function get(url: string, id?: string, role = 'gc') {
    const response = await fetch(`${base}${url}`, { headers: id ? { authorization: `Bearer ${token(id, role)}` } : {} })
    const text = await response.text()
    let body: any
    try { body = JSON.parse(text) } catch { assert.fail(`${url} returned non-JSON: ${text.slice(0, 200)}`) }
    return { response, body }
  }
  async function mutation(id: string, method: string, url: string, body?: object) {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { authorization: `Bearer ${token(id, 'gc')}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    return { response, text }
  }

  for (const gc of [
    { id: 'gc-a', own: fixtures.a, other: fixtures.b, share: 'a'.repeat(48), upload: 'c'.repeat(48) },
    { id: 'gc-b', own: fixtures.b, other: fixtures.a, share: 'b'.repeat(48), upload: 'd'.repeat(48) },
  ]) {
    const expected = [gc.own.id, fixtures.sub.id]
    const forbidden = [gc.other.id, fixtures.legacy.id, gc.other.note, fixtures.legacy.note, `POLICY-${gc.id === 'gc-a' ? 'b' : 'a'}`, 'POLICY-legacy']
    await t.test(`${gc.id}: lists, details, alerts, projects and status use only visible COIs`, async () => {
      for (const url of ['/api/cois', '/api/cois?sub_id=shared-sub', '/api/cois/alerts/expiring?days=50000']) {
        const { response, body } = await get(url, gc.id)
        assert.equal(response.status, 200, url)
        assertIds(body.cois ?? body.alerts, expected, `${gc.id} ${url}`)
        assertNoText(body, forbidden, url)
      }
      for (const id of expected) {
        const { response, body } = await get(`/api/cois/${id}`, gc.id)
        assert.equal(response.status, 200, `${gc.id} can read ${id}`)
        assert.equal(body.coi.id, id)
        assertNoText(body, forbidden, `${gc.id} detail`)
      }
      for (const id of [gc.other.id, fixtures.legacy.id]) {
        const { response, body } = await get(`/api/cois/${id}`, gc.id)
        assert.ok([403, 404].includes(response.status), `${gc.id} cannot read ${id}: ${response.status}`)
        assertNoText(body, forbidden, `${gc.id} denied detail`)
      }
      const detail = await get('/api/subcontractors/shared-sub', gc.id)
      assert.equal(detail.response.status, 200)
      assertIds(detail.body.subcontractor.cois, expected, `${gc.id} subcontractor detail`)
      assert.equal(detail.body.subcontractor.best_coi.id, gc.own.id)
      assert.equal(detail.body.subcontractor.computed_status, 'compliant')
      assertNoText(detail.body, forbidden, 'subcontractor detail')
      const list = await get('/api/subcontractors', gc.id)
      assert.equal(list.response.status, 200)
      const listed = list.body.subcontractors.find((s: any) => s.id === 'shared-sub')
      assert.ok(listed)
      assert.equal(listed.coi_count, 2)
      assert.equal(listed.best_coi.id, gc.own.id)
      assert.equal(listed.computed_status, 'compliant')
      assertNoText(list.body, forbidden, 'subcontractor list')
      const project = await get(`/api/projects/project-${gc.id}`, gc.id)
      assert.equal(project.response.status, 200)
      assert.equal(project.body.project.subcontractors.length, 1)
      assertIds(project.body.project.subcontractors[0].cois, expected, `${gc.id} project detail`)
      assert.equal(project.body.project.subcontractors[0].best_coi.id, gc.own.id)
      assert.equal(project.body.project.scorecard.compliant, 1)
      assertNoText(project.body, forbidden, 'project detail')
      const projects = await get('/api/projects', gc.id)
      assert.equal(projects.response.status, 200)
      assert.equal(projects.body.projects.find((p: any) => p.id === `project-${gc.id}`).scorecard.compliant, 1)
      assertNoText(projects.body, forbidden, 'project list')
      const stats = await get('/api/stats', gc.id)
      assert.equal(stats.response.status, 200)
      assert.equal(stats.body.totals.compliant, 1)
      assertNoText(stats.body, forbidden, 'stats')
    })

    await t.test(`${gc.id}: client share and upload history cannot disclose another owner's records or reviewer notes`, async () => {
      const report = await get(`/api/client/share/${gc.share}`)
      assert.equal(report.response.status, 200)
      assert.equal(report.body.subcontractors.length, 1)
      assert.equal(report.body.subcontractors[0].company_name, 'Subcontractor 1')
      assert.equal(report.body.subcontractors[0].trade, 'Trade withheld')
      assertNoText(report.body, ['Synthetic Shared Sub', 'Electrical'], 'client anonymity')
      const publicCois = report.body.subcontractors[0].cois
      assert.ok(Array.isArray(publicCois))
      assert.deepEqual(publicCois.map((coi: any) => coi.expiration_date).sort(), [gc.own.expiration, fixtures.sub.expiration].sort())
      assert.equal(report.body.subcontractors[0].best_coi.expiration_date, gc.own.expiration)
      assert.equal(report.body.scorecard.compliant, 1)
      assertNoText(report.body, [...forbidden, fixtures.a.note, fixtures.b.note, fixtures.sub.note, fixtures.legacy.note, 'reviewer_notes', 'COVERAGE-SECRET'], 'client share')
      const uploadToken = `gc1.${Buffer.from(gc.id).toString('base64url')}.${gc.upload}`
      const history = await get(`/api/upload/my/${uploadToken}`)
      assert.equal(history.response.status, 200)
      assertIds(history.body.cois, expected, `${gc.id} upload history`)
      assertNoText(history.body, [...forbidden, fixtures.a.note, fixtures.b.note, fixtures.sub.note, fixtures.legacy.note, 'reviewer_notes', 'COVERAGE-SECRET'], 'upload history')
    })

    await t.test(`${gc.id}: cannot change, review or delete other, sub-owned, or ambiguous COIs`, async () => {
      const beforeCois = await dbAll('SELECT * FROM cois ORDER BY id')
      const beforeCoverage = await dbAll('SELECT * FROM coi_coverages ORDER BY id')
      for (const id of [gc.other.id, fixtures.sub.id, fixtures.legacy.id]) {
        for (const [method, suffix, body] of [
          ['PUT', '', { carrier: 'UNAUTHORIZED CHANGE', reviewer_notes: 'UNAUTHORIZED NOTE' }],
          ['PUT', '/review', { status: 'rejected', reviewer_notes: 'UNAUTHORIZED REVIEW' }],
          ['DELETE', '', undefined],
        ] as const) {
          const result = await mutation(gc.id, method, `/api/cois/${id}${suffix}`, body)
          assert.ok([403, 404].includes(result.response.status), `${gc.id} ${method} ${id}${suffix}: ${result.response.status} ${result.text}`)
          assertNoText(result.text, [gc.other.note, fixtures.sub.note, fixtures.legacy.note], 'denied mutation')
        }
      }
      assert.deepEqual(await dbAll('SELECT * FROM cois ORDER BY id'), beforeCois, 'denied requests must not modify COIs')
      assert.deepEqual(await dbAll('SELECT * FROM coi_coverages ORDER BY id'), beforeCoverage, 'denied requests must not modify coverages')
    })
  }

  await t.test('subcontractor dashboard excludes ownerless legacy COIs and GC coverage notes', async () => {
    const result = await get('/api/sub/my', 'sub-user', 'sub')
    assert.equal(result.response.status, 200)
    assertIds(result.body.cois, [fixtures.a.id, fixtures.b.id, fixtures.sub.id], 'sub dashboard visible COIs')
    for (const gc of ['a', 'b'] as const) {
      const coi = result.body.cois.find((row: any) => row.id === fixtures[gc].id)
      assert.equal(coi.coverages.length, 1, `sub can see GC ${gc} coverage details`)
      assert.equal(coi.coverages[0].type, 'General Liability')
      assert.equal(coi.coverages[0].per_occurrence_limit, gc === 'a' ? '$1000001' : '$1000002')
    }
    assertNoText(result.body, [fixtures.legacy.id, 'CARRIER-legacy', 'POLICY-legacy', fixtures.a.note, fixtures.b.note,
      fixtures.legacy.note, 'COVERAGE-SECRET-a', 'COVERAGE-SECRET-b', 'COVERAGE-SECRET-legacy'], 'sub dashboard')
  })

  await t.test('GC-created certificates are attributed to the creator and remain editable, reviewable and deletable by that GC', async () => {
    for (const id of ['gc-a', 'gc-b']) {
      const created = await mutation(id, 'POST', '/api/cois', {
        subcontractor_id: 'shared-sub', carrier: `CREATED-${id}`, effective_date: '2020-01-01', expiration_date: '2090-01-01',
      })
      assert.equal(created.response.status, 201, created.text)
      const createdId = JSON.parse(created.text).coi.id
      const row = await dbGet<any>('SELECT owner_gc_user_id, owner_sub_user_id FROM cois WHERE id = ?', [createdId])
      assert.deepEqual(row, { owner_gc_user_id: id, owner_sub_user_id: null })
      const edited = await mutation(id, 'PUT', `/api/cois/${createdId}`, { carrier: 'EDITED-CARRIER' })
      assert.equal(edited.response.status, 200, edited.text)
      const reviewed = await mutation(id, 'PUT', `/api/cois/${createdId}/review`, { status: 'compliant', reviewer_notes: 'owner review' })
      assert.equal(reviewed.response.status, 200, reviewed.text)
      const deleted = await mutation(id, 'DELETE', `/api/cois/${createdId}`)
      assert.equal(deleted.response.status, 200, deleted.text)
      assert.equal(await dbGet('SELECT id FROM cois WHERE id = ?', [createdId]), undefined)
    }
  })

  // A complete, minimal PDF with calculated xref offsets and a valid 1x1 PNG.
  function syntheticPdf() {
    let pdf = '%PDF-1.4\n'
    const offsets = [0]
    for (const [i, body] of [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>',
    ].entries()) {
      offsets.push(Buffer.byteLength(pdf))
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
    }
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
    pdf += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(pdf)
  }
  const images = [
    { extension: 'pdf', mime: 'application/pdf', bytes: syntheticPdf(), gc: 'gc-a', secret: 'e' },
    { extension: 'png', mime: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64'), gc: 'gc-b', secret: 'f' },
  ] as const
  for (const file of images) {
    await t.test(`scoped ${file.extension.toUpperCase()} upload cannot edit a sub-account-owned profile`, async () => {
      await dbRun(`UPDATE subcontractors SET contact_person = ?, phone = ?, email = ?, address = ?, status = ?, updated_at = ? WHERE id = ?`,
        ['Original Contact', '555-0101', 'original@example.test', '123 Original Street', 'compliant', now, 'shared-sub'])
      const before = await dbGet<any>('SELECT * FROM subcontractors WHERE id = ?', ['shared-sub'])
      assert.equal(before.user_id, 'sub-user')
      const uploadToken = `gc1.${Buffer.from(file.gc).toString('base64url')}.${file.secret.repeat(48)}`
      await dbRun('INSERT INTO upload_requests (id, subcontractor_id, token, requested_by_email, created_at) VALUES (?, ?, ?, ?, ?)',
        [`profile-upload-${file.extension}`, 'shared-sub', uploadToken, `${file.gc}@example.test`, now])
      const form = new FormData()
      for (const [key, value] of Object.entries({
        carrier: `Upload Carrier ${file.extension}`, policy_number: `UPLOAD-${file.extension}`,
        effective_date: '2026-01-01', expiration_date: '2030-01-01',
        contact_person: 'Injected Contact', phone: '555-9999', email: 'injected@example.test',
        address: '999 Injected Street', status: 'rejected',
      })) form.append(key, value)
      form.append('certificate', new Blob([file.bytes], { type: file.mime }), `${uploadNamePrefix}.${file.extension}`)
      const response = await fetch(`${base}/api/upload/submit/${uploadToken}`, { method: 'POST', body: form })
      const text = await response.text()
      assert.equal(response.status, 200, text)
      const body = JSON.parse(text)
      assert.equal(body.success, true)
      assert.equal(body.coi.carrier, `Upload Carrier ${file.extension}`)
      assert.equal(body.coi.status, 'pending_review')
      assert.equal(body.coi.certificate_mime, file.mime)
      assert.equal(body.coi.certificate_size, file.bytes.length)
      const inserted = await dbGet<any>('SELECT * FROM cois WHERE id = ?', [body.coi.id])
      assert.ok(inserted, 'upload must create a certificate')
      assert.equal(inserted.owner_gc_user_id, file.gc)
      assert.equal(inserted.owner_sub_user_id, null)
      assert.deepEqual(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '../uploads'), inserted.certificate_key)), file.bytes)
      assert.deepEqual(await dbGet('SELECT * FROM subcontractors WHERE id = ?', ['shared-sub']), before,
        'a public upload capability must not mutate the account-owned profile, including status or timestamps')
    })
  }

  await t.test('legacy profile notes stay hidden from the remaining GC after another GC unlinks', async (t) => {
    const legacyId = 'shared-unclaimed-legacy-sub'
    const secret = 'LEGACY-UNATTRIBUTED-SUB-NOTE'
    await dbRun('INSERT INTO subcontractors (id, company_name, trade, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [legacyId, 'Unclaimed Legacy Sub', 'Plumbing', secret, now, now])
    for (const gc of ['gc-a', 'gc-b']) {
      await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [gc, legacyId, now])
    }
    await dbRun('INSERT INTO project_subcontractors (id, project_id, subcontractor_id, created_at) VALUES (?, ?, ?, ?)',
      ['link-legacy-gc-a', 'project-gc-a', legacyId, now])
    const surfaces = [
      { url: '/api/subcontractors', find: (body: any) => body.subcontractors.find((row: any) => row.id === legacyId) },
      { url: `/api/subcontractors/${legacyId}`, find: (body: any) => body.subcontractor },
      { url: '/api/projects/project-gc-a', find: (body: any) => body.project.subcontractors.find((row: any) => row.id === legacyId) },
    ]
    for (const stage of ['before unlink', 'after unlink']) {
      if (stage === 'after unlink') {
        const deleted = await mutation('gc-b', 'DELETE', `/api/subcontractors/${legacyId}`)
        assert.equal(deleted.response.status, 200, deleted.text)
        assert.deepEqual(await dbAll('SELECT gc_user_id FROM gc_sub_connections WHERE subcontractor_id = ? ORDER BY gc_user_id', [legacyId]), [{ gc_user_id: 'gc-a' }])
        assert.equal((await dbGet<any>('SELECT notes FROM subcontractors WHERE id = ?', [legacyId])).notes, secret,
          'unlink must not delete or overwrite the historical note')
      }
      for (const surface of surfaces) {
        await t.test(`${stage}: ${surface.url} hides unattributed notes`, async () => {
          const result = await get(surface.url, 'gc-a')
          assert.equal(result.response.status, 200)
          assert.ok(surface.find(result.body), 'the remaining GC can still see the profile')
          assertNoText(result.body, [secret], `${stage} ${surface.url}`)
        })
      }
    }
  })
})
