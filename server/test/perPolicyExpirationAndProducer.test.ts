import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { latestExpirationDate, normalizeExtractedForDb, matchOrCreateSubcontractorFromInsured, applyExtractedFieldsToCoi } from '../src/services/coiFieldSync.ts'
import { dbRun, dbGet, initDatabase } from '../src/db/db.ts'

test('latestExpirationDate returns undefined for empty input', () => {
  assert.equal(latestExpirationDate([]), undefined)
  assert.equal(latestExpirationDate([{ expirationDate: 'bad-date' }]), undefined)
})

test('latestExpirationDate picks the furthest-out policy expiration date', () => {
  const policies = [
    { expirationDate: '06/01/2026' },
    { expirationDate: '11/01/2026' },
    { expirationDate: '01/15/2026' },
  ]
  assert.equal(latestExpirationDate(policies), '11/01/2026')
})

test('latestExpirationDate works across year boundaries and mixed formats', () => {
  const policies = [
    { expirationDate: '12/31/2025' },
    { expirationDate: '03/01/2027' },
    { expirationDate: '2026-06-15' },
  ]
  assert.equal(latestExpirationDate(policies), '03/01/2027')
})

test('normalizeExtractedForDb sets expirationDate to the latest policy date (not just the first)', () => {
  const norm = normalizeExtractedForDb({
    insurers: [{ name: 'Carrier A' }],
    policies: [
      { type: 'General Liability', expirationDate: '06/01/2026' },
      { type: 'Auto', expirationDate: '11/01/2026' },
    ],
  })
  assert.equal(norm.expirationDate, '11/01/2026')
})

test('normalizeExtractedForDb falls back to first policy date when latest cannot be parsed', () => {
  const norm = normalizeExtractedForDb({
    policies: [{ type: 'General Liability', expiration_date: '2027-02-01' }],
  })
  assert.equal(norm.expirationDate, '02/01/2027')
})

async function mkGc() {
  await initDatabase()
  const uid = randomUUID()
  const now = new Date().toISOString()
  await dbRun("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'GC Co', 'gc', ?)", [uid, `gc-${uid}@test.local`, now])
  return uid
}

async function mkCoi(ownerGcUserId: string) {
  const sid = randomUUID()
  const cid = randomUUID()
  const now = new Date().toISOString()
  await dbRun("INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, 'Pending document scan', 'Other', ?, ?)", [sid, now, now])
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [ownerGcUserId, sid, now])
  await dbRun("INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at) VALUES (?, ?, ?, 'Carrier X', '2026-01-01', '2026-06-01', 'pending_review', ?, ?)", [cid, sid, ownerGcUserId, now, now])
  return { coiId: cid, subId: sid }
}

test('matchOrCreateSubcontractorFromInsured does NOT use producer contacts for the subcontractor row', async () => {
  const gc = await mkGc()
  const { coiId } = await mkCoi(gc)
  const fields = {
    producer: {
      name: 'Agency Broking LLC',
      phone: '312-555-0199',
      email: 'producer@agency.test',
      address: '990 Broker Way, Chicago, IL',
      contactPerson: 'Jane Agent',
    },
    insured: {
      name: `Prime Sub Contractors ${Date.now()}`,
      address: '100 Sub Blvd, Chicago, IL',
    },
    insurers: [{ name: 'Carrier A' }],
    policies: [{ type: 'GL', policyNumber: 'P1', expirationDate: '11/01/2026' }],
  }
  const res = await matchOrCreateSubcontractorFromInsured(coiId, fields, { uploaderGcUserId: gc })
  assert.ok(res?.created)
  const sub = await dbGet<any>('SELECT company_name, phone, email, contact_person, address FROM subcontractors WHERE id = ?', [res.subcontractorId])
  assert.equal(sub.company_name, fields.insured.name)
  assert.equal(sub.phone, null)
  assert.equal(sub.email, null)
  assert.equal(sub.contact_person, null)
  assert.equal(sub.address, fields.insured.address)
})

test('applyExtractedFieldsToCoi stores the MAX policy expiration date on cois.expiration_date', async () => {
  const gc = await mkGc()
  const { coiId } = await mkCoi(gc)
  const fields = {
    insurers: [{ name: 'Carrier A' }],
    policies: [
      { type: 'GL', effectiveDate: '01/01/2026', expirationDate: '06/01/2026' },
      { type: 'Auto', expirationDate: '12/15/2026' },
      { type: 'WC', expirationDate: '03/01/2026' },
    ],
  }
  await applyExtractedFieldsToCoi(coiId, fields)
  const coi = await dbGet<any>('SELECT expiration_date FROM cois WHERE id = ?', [coiId])
  assert.equal(coi.expiration_date, '12/15/2026')
})
