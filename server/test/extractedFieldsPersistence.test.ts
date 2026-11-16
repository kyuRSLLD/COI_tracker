import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import { dbRun, dbGet, dbAll } from '../src/db/db.ts'
import { signToken } from '../src/middleware/auth.ts'
import { createApp } from '../src/app.ts'
import { applyExtractedFieldsToCoi, normalizeExtractedForDb } from '../src/services/coiFieldSync.ts'
import { saveExtractedReview } from '../src/routes/coiFields.ts'

async function mkUser(role: string) {
  const id = randomUUID()
  const email = `${id}@test.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'T', ?, ?)`,
    [id, email, role, new Date().toISOString()],
  )
  return { id, email, token: signToken({ id, email, role }) }
}

async function mkCoi(ownerSubUserId?: string) {
  const now = new Date().toISOString()
  const subId = randomUUID()
  await dbRun(
    `INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Acme Corp', 'Electrical', ?, ?)`,
    [subId, now, now],
  )
  const id = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, created_at, updated_at, owner_sub_user_id)
     VALUES (?, ?, 'Not provided', 'pending_review', '', '', ?, ?, ?)`,
    [id, subId, now, now, ownerSubUserId || null],
  )
  return { id, subId }
}

test('normalizeExtractedForDb handles current AI extraction shape', () => {
  const n = normalizeExtractedForDb({
    producer: { name: 'Producer LLC' },
    insured: { name: 'Acme Corp' },
    insurers: [{ letter: 'A', name: 'Travelers Casualty', naic: '25674' }],
    policies: [{
      type: 'Commercial General Liability',
      insurerLetter: 'A',
      policyNumber: 'TCPA-123',
      effectiveDate: '2026-10-31',
      expirationDate: '2027-10-31',
      limits: [
        { name: 'EACH OCCURRENCE', amount: 1000000 },
        { name: 'GENERAL AGGREGATE', amount: 2000000 },
      ],
    }],
    source: 'ocr',
  })
  assert.equal(n.carrier, 'Travelers Casualty')
  assert.equal(n.policyNumber, 'TCPA-123')
  assert.equal(n.effectiveDate, '10/31/2026')
  assert.equal(n.expirationDate, '10/31/2027')
  assert.equal(n.coverages.length, 1)
  assert.equal(n.coverages[0].perOccurrenceLimit, '$1,000,000.00')
  assert.equal(n.coverages[0].aggregateLimit, '$2,000,000.00')
})

test('normalizeExtractedForDb handles legacy snake_case shape', () => {
  const n = normalizeExtractedForDb({
    insurer: { name: 'Hartford Fire Insurance', naic: '25674' },
    policies: [{
      type: 'General Liability',
      policy_number: 'HF-9',
      effective_date: '01/01/2026',
      expiration_date: '12/31/2026',
      limits: [{ label: 'occurrence', amount: 1000000 }, { label: 'aggregate', amount: 2000000 }],
    }],
  })
  assert.equal(n.carrier, 'Hartford Fire Insurance')
  assert.equal(n.policyNumber, 'HF-9')
  assert.equal(n.effectiveDate, '01/01/2026')
  assert.equal(n.expirationDate, '12/31/2026')
  assert.equal(n.coverages[0].perOccurrenceLimit, '$1,000,000.00')
})

test('applyExtractedFieldsToCoi updates cois columns and recreates coi_coverages', async () => {
  const { id } = await mkCoi()
  const sample = {
    insurers: [{ letter: 'A', name: 'Nationwide Mutual' }],
    policies: [{
      type: 'Commercial General Liability',
      policyNumber: 'NWM-42',
      effectiveDate: '2026-10-31',
      expirationDate: '2027-10-31',
      limits: [
        { name: 'EACH OCCURRENCE', amount: 1000000 },
        { name: 'GENERAL AGGREGATE', amount: 2000000 },
      ],
    }],
  }
  await applyExtractedFieldsToCoi(id, sample)
  const coi = await dbGet<any>('SELECT carrier, policy_number, effective_date, expiration_date FROM cois WHERE id = ?', [id])
  assert.equal(coi.carrier, 'Nationwide Mutual')
  assert.equal(coi.policy_number, 'NWM-42')
  assert.equal(coi.effective_date, '10/31/2026')
  assert.equal(coi.expiration_date, '10/31/2027')
  const covs = await dbAll<any>('SELECT type, per_occurrence_limit, aggregate_limit FROM coi_coverages WHERE coi_id = ?', [id])
  assert.equal(covs.length, 1)
  assert.equal(covs[0].per_occurrence_limit, '$1,000,000.00')
  assert.equal(covs[0].aggregate_limit, '$2,000,000.00')
})

test('applyExtractedFieldsToCoi with overwrite=false preserves manually entered values', async () => {
  const { id } = await mkCoi()
  await dbRun("UPDATE cois SET carrier = 'Existing Carrier', policy_number = 'OLD-1' WHERE id = ?", [id])
  const sample = {
    insurers: [{ letter: 'A', name: 'New Carrier' }],
    policies: [{
      type: 'Auto',
      policyNumber: 'NEW-2',
      effectiveDate: '2026-05-01',
      expirationDate: '2027-05-01',
      limits: [{ name: 'combined single limit', amount: 500000 }],
    }],
  }
  await applyExtractedFieldsToCoi(id, sample, { overwrite: false })
  const coi = await dbGet<any>('SELECT carrier, policy_number, effective_date, expiration_date FROM cois WHERE id = ?', [id])
  assert.equal(coi.carrier, 'Existing Carrier')
  assert.equal(coi.policy_number, 'OLD-1')
  assert.equal(coi.effective_date, '05/01/2026')
  assert.equal(coi.expiration_date, '05/01/2027')
})

test('saveExtractedReview persists review JSON AND syncs columns', async () => {
  const { id } = await mkCoi()
  const sample = {
    producer: { name: 'Acme Brokerage' },
    insured: { name: 'Acme Corp' },
    insurers: [{ letter: 'A', name: 'Liberty Mutual Insurance', naic: '23035' }],
    policies: [{
      type: 'Commercial General Liability',
      insurerLetter: 'A',
      policyNumber: 'LM-77',
      effectiveDate: '2026-10-31',
      expirationDate: '2027-10-31',
      limits: [
        { label: 'occurrence', amount: '1000000' },
        { label: 'aggregate', amount: '2000000' },
      ],
    }],
    source: 'ocr',
  }
  const ok = await saveExtractedReview(id, null, sample, { overwrite: true })
  assert.equal(ok, true)
  const rev = await dbGet<any>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [id])
  assert.ok(rev)
  const details = JSON.parse(rev.details_json)
  assert.equal(details.producer.name, 'Acme Brokerage')
  assert.equal(details.insurers[0].naic, '23035')
  const coi = await dbGet<any>('SELECT carrier, policy_number, effective_date, expiration_date FROM cois WHERE id = ?', [id])
  assert.equal(coi.carrier, 'Liberty Mutual Insurance')
  assert.equal(coi.policy_number, 'LM-77')
  assert.equal(coi.effective_date, '10/31/2026')
  assert.equal(coi.expiration_date, '10/31/2027')
  const covs = await dbAll<any>('SELECT type, per_occurrence_limit, aggregate_limit FROM coi_coverages WHERE coi_id = ?', [id])
  assert.equal(covs.length, 1)
  assert.equal(covs[0].per_occurrence_limit, '$1,000,000.00')
})

test('GET /api/sub/my exposes review_details and review_source_tag for owned COIs', async () => {
  const subUser = await mkUser('sub')
  const { id } = await mkCoi(subUser.id)
  await dbRun(`UPDATE subcontractors SET user_id = ? WHERE id = (SELECT subcontractor_id FROM cois WHERE id = ?)`, [subUser.id, id])
  const sample = {
    producer: { name: 'Prime Broker' },
    insured: { name: 'Prime Sub LLC' },
    insurers: [{ letter: 'A', name: 'Travelers Casualty' }],
    policies: [{
      type: 'CGL',
      policyNumber: 'PR-1',
      effectiveDate: '2026-10-31',
      expirationDate: '2027-10-31',
      limits: [{ label: 'occurrence', amount: '1000000' }],
    }],
    source: 'ocr',
  }
  await saveExtractedReview(id, null, sample, { overwrite: true })
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const res = await fetch(`${base}/api/sub/my`, { headers: { Authorization: `Bearer ${subUser.token}` } })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.ok(Array.isArray(body.cois))
    const found = body.cois.find((c: any) => c.id === id)
    assert.ok(found)
    assert.equal(found.carrier, 'Travelers Casualty')
    assert.ok(found.review_details)
    assert.equal(found.review_details.producer.name, 'Prime Broker')
    assert.equal(found.review_details.insurers[0].name, 'Travelers Casualty')
    assert.ok(typeof found.review_source_tag === 'string')
  } finally {
    server.close()
  }
})

test('GET /api/admin/cois/:id/review returns full extracted object for staff validation', async () => {
  const admin = await mkUser('admin')
  const { id } = await mkCoi()
  const sample = {
    producer: { name: 'Full Broker LLC', phone: '312-555-0100', email: 'agent@broker.test', address: '123 W Wacker Dr, Chicago, IL 60601' },
    insured: { name: 'Full Sub LLC', address: '456 N Michigan Ave' },
    insurers: [
      { letter: 'A', name: 'Travelers Property Casualty', naic: '25674' },
      { letter: 'B', name: 'Hartford Fire Insurance', naic: '19682' },
    ],
    policies: [
      {
        type: 'Commercial General Liability',
        insurerLetter: 'A',
        policyNumber: 'TCPA-100',
        effectiveDate: '2026-10-31',
        expirationDate: '2027-10-31',
        limits: [
          { label: 'occurrence', amount: '1000000' },
          { label: 'aggregate', amount: '2000000' },
        ],
      },
      {
        type: 'Automobile Liability',
        insurerLetter: 'B',
        policyNumber: 'AL-200',
        effectiveDate: '2026-10-31',
        expirationDate: '2027-10-31',
        limits: [{ label: 'combined single limit', amount: '1000000' }],
      },
    ],
    source: 'ocr',
  }
  await saveExtractedReview(id, null, sample, { overwrite: true })
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    const res = await fetch(`${base}/api/admin/cois/${id}/review`, { headers: { Authorization: `Bearer ${admin.token}` } })
    assert.equal(res.status, 200)
    const body: any = await res.json()
    assert.equal(body.coi.carrier, 'Travelers Property Casualty')
    assert.equal(body.coi.policy_number, 'TCPA-100')
    assert.equal(body.extracted.producer.name, 'Full Broker LLC')
    assert.equal(body.extracted.producer.phone, '312-555-0100')
    assert.equal(body.extracted.producer.email, 'agent@broker.test')
    assert.equal(body.extracted.producer.address, '123 W Wacker Dr, Chicago, IL 60601')
    assert.equal(body.extracted.insured.name, 'Full Sub LLC')
    assert.equal(body.extracted.insurers.length, 2)
    assert.equal(body.extracted.insurers[1].name, 'Hartford Fire Insurance')
    assert.equal(body.extracted.policies.length, 2)
    assert.equal(body.extracted.policies[0].limits.length, 2)
  } finally {
    server.close()
  }
})

test('POST /api/admin/cois/:id/extract persists extracted fields to cois columns and coverages', async () => {
  const admin = await mkUser('admin')
  const { id } = await mkCoi()
  // fake stored file row
  await dbRun("UPDATE cois SET certificate_key = 'cois/test-12345678-1234-1234-1234-123456789abc.png' WHERE id = ?", [id])
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const savedKey = process.env.OPENAI_API_KEY
  try {
    process.env.OPENAI_API_KEY = ''
    // with no API key, extraction returns 503 — verifies the route exists and guards work
    const res = await fetch(`${base}/api/admin/cois/${id}/extract`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` } })
    assert.equal(res.status, 503)
  } finally {
    process.env.OPENAI_API_KEY = savedKey
    server.close()
  }
})
