import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dbRun, dbGet, dbAll } from '../src/db/db.ts'
import { createApp } from '../src/app.ts'
import { signToken } from '../src/middleware/auth.ts'
import {
  normalizeCompanyName,
  companyNamesMatch,
  extractInsuredName,
  matchOrCreateSubcontractorFromInsured,
} from '../src/services/coiFieldSync.ts'

// Pure helper tests
test('normalizeCompanyName strips LLC/Inc/Corp variants, punctuation, and extra whitespace', () => {
  assert.equal(normalizeCompanyName('Horizon Electrical Services, LLC'), 'horizon electrical services')
  assert.equal(normalizeCompanyName('Apex Drywall & Acoustics Inc.'), 'apex drywall acoustics')
  assert.equal(normalizeCompanyName('Apex & Co.'), 'apex')
  assert.equal(normalizeCompanyName('  Acme Corporation  '), 'acme')
  assert.equal(normalizeCompanyName('Midwest Co., Ltd.'), 'midwest')
  assert.equal(normalizeCompanyName(null), '')
})

test('companyNamesMatch returns true for matching variants and false for mismatches', () => {
  assert.equal(companyNamesMatch('Horizon Electrical Services, LLC', 'Horizon Electrical Services'), true)
  assert.equal(companyNamesMatch('Apex Drywall & Acoustics', 'APEX DRYWALL ACOUSTICS INC'), true)
  assert.equal(companyNamesMatch('Horizon & Sons', 'Horizon'), true)
  assert.equal(companyNamesMatch('Horizon Electrical', 'Apex Drywall'), false)
  assert.equal(companyNamesMatch('', 'Horizon'), false)
  assert.equal(companyNamesMatch(null, null), false)
})

test('extractInsuredName handles canonical and legacy schema variants', () => {
  assert.equal(extractInsuredName({ insured: { name: '  Horizon Electrical Services ' } }), 'Horizon Electrical Services')
  assert.equal(extractInsuredName({ insured: { company_name: 'Apex Drywall' } }), 'Apex Drywall')
  assert.equal(extractInsuredName({ insured: 'Lakeview Painting' }), 'Lakeview Painting')
  assert.equal(extractInsuredName({}), null)
  assert.equal(extractInsuredName(null), null)
})

function sampleFields(insuredName: string, carrier = 'Travelers') {
  return {
    insurers: [{ name: carrier }],
    insured: {
      name: insuredName,
      address: '1420 W Grand Ave, Chicago, IL',
      phone: '(312) 555-0321',
      email: 'info@horizon.demo',
    },
    producer: {
      name: 'Aon Risk Services',
      address: '200 E Randolph St, Chicago, IL',
      phone: '(312) 555-0000',
    },
    policies: [{
      type: 'General Liability',
      policyNumber: 'GL-999',
      effectiveDate: '07/01/2025',
      expirationDate: '07/01/2026',
      limits: [
        { label: 'EACH OCCURRENCE', amount: '$1,000,000' },
        { label: 'AGGREGATE', amount: '$2,000,000' },
      ],
    }],
    source: 'ocr',
  }
}

async function createGc() {
  const gc = { id: randomUUID(), email: `gc-${randomUUID()}@apex.demo`, role: 'gc', name: 'Apex GC' }
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO users (id, email, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [gc.id, gc.email, 'x', gc.role, gc.name, now],
  )
  return gc
}

async function createSub(gcId: string, companyName: string) {
  const subId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [subId, companyName, 'Electrical', now, now],
  )
  await dbRun(
    'INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
    [gcId, subId, now],
  )
  return subId
}

test('matchOrCreateSubcontractorFromInsured: reuses matching connected sub', async () => {
  const gc = await createGc()
  const subId = await createSub(gc.id, 'Horizon Electrical Services')
  const coiId = randomUUID()
  const now = new Date().toISOString()
  // COI filed under a dummy sub initially
  const dummy = await createSub(gc.id, 'Unrelated Sub')
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Not provided', '2025-07-01', '2026-07-01', 'pending_review', ?, ?)`,
    [coiId, dummy, gc.id, now, now],
  )

  const res = await matchOrCreateSubcontractorFromInsured(coiId, sampleFields('Horizon Electrical Services, LLC'))
  assert.ok(res)
  assert.equal(res.subcontractorId, subId)
  assert.equal(res.created, false)
  const after = await dbGet<any>('SELECT subcontractor_id FROM cois WHERE id = ?', [coiId])
  assert.equal(after.subcontractor_id, subId)
})

test('matchOrCreateSubcontractorFromInsured: creates new connected sub when no match exists', async () => {
  const gc = await createGc()
  const dummy = await createSub(gc.id, 'Horizon Electrical Services')
  const coiId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Not provided', '2025-07-01', '2026-07-01', 'pending_review', ?, ?)`,
    [coiId, dummy, gc.id, now, now],
  )

  const res = await matchOrCreateSubcontractorFromInsured(coiId, sampleFields('Newco Electrical Inc.'))
  assert.ok(res)
  assert.equal(res.created, true)
  assert.notEqual(res.subcontractorId, dummy)

  const created = await dbGet<any>('SELECT company_name, phone, email, address FROM subcontractors WHERE id = ?', [res.subcontractorId])
  assert.equal(created.company_name, 'Newco Electrical Inc.')
  assert.equal(created.phone, '(312) 555-0321')
  assert.equal(created.email, 'info@horizon.demo')
  assert.equal(created.address, '1420 W Grand Ave, Chicago, IL')

  const conn = await dbGet<any>('SELECT 1 FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc.id, res.subcontractorId])
  assert.ok(conn)

  const after = await dbGet<any>('SELECT subcontractor_id FROM cois WHERE id = ?', [coiId])
  assert.equal(after.subcontractor_id, res.subcontractorId)
})

test('matchOrCreateSubcontractorFromInsured: cleans up provisional placeholder sub with 0 remaining COIs', async () => {
  const gc = await createGc()
  const provisionalId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [provisionalId, 'Pending document scan', 'Other', now, now],
  )
  await dbRun(
    'INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
    [gc.id, provisionalId, now],
  )
  const coiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Not provided', '2025-07-01', '2026-07-01', 'pending_review', ?, ?)`,
    [coiId, provisionalId, gc.id, now, now],
  )

  const res = await matchOrCreateSubcontractorFromInsured(coiId, sampleFields('Brightstar Electric LLC'))
  assert.ok(res?.created)
  const gone = await dbGet<any>('SELECT id FROM subcontractors WHERE id = ?', [provisionalId])
  assert.equal(gone, undefined)
  const connGone = await dbAll<any>('SELECT * FROM gc_sub_connections WHERE subcontractor_id = ?', [provisionalId])
  assert.equal(connGone.length, 0)
})

test('matchOrCreateSubcontractorFromInsured: returns null when no insured name is extracted', async () => {
  const gc = await createGc()
  const subId = await createSub(gc.id, 'Horizon Electrical Services')
  const coiId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Not provided', '2025-07-01', '2026-07-01', 'pending_review', ?, ?)`,
    [coiId, subId, gc.id, now, now],
  )
  const res = await matchOrCreateSubcontractorFromInsured(coiId, { insurers: [{ name: 'Travelers' }] })
  assert.equal(res, null)
  const after = await dbGet<any>('SELECT subcontractor_id FROM cois WHERE id = ?', [coiId])
  assert.equal(after.subcontractor_id, subId)
})

test('POST /api/cois without subcontractor_id creates a provisional sub and accepts the upload', async () => {
  const app = await createApp({ maintenanceMode: false })
  const gc = await createGc()
  const token = signToken(gc)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const port = (server.address() as any).port

  const boundary = `----WebKitFormBoundary${randomUUID().replace(/-/g, '')}`
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="carrier"',
    '',
    'Liberty Mutual',
    `--${boundary}`,
    'Content-Disposition: form-data; name="effective_date"',
    '',
    '2025-07-01',
    `--${boundary}`,
    'Content-Disposition: form-data; name="expiration_date"',
    '',
    '2026-07-01',
    `--${boundary}--`,
  ].join('\r\n')

  try {
  const res = await fetch(`http://127.0.0.1:${port}/api/cois`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  })
  assert.equal(res.status, 201)
  const d = await res.json()
  assert.ok(d.coi?.id)

  const coi = await dbGet<any>('SELECT subcontractor_id FROM cois WHERE id = ?', [d.coi.id])
  const sub = await dbGet<any>('SELECT company_name FROM subcontractors WHERE id = ?', [coi.subcontractor_id])
  assert.equal(sub.company_name, 'Pending document scan')
  const conn = await dbGet<any>('SELECT 1 FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc.id, coi.subcontractor_id])
  assert.ok(conn)
  } finally {
    server.close()
  }
})

test('saveExtractedReview reassigns provisional sub to matched existing sub and cleans placeholder', async () => {
  const gc = await createGc()
  const realSub = await createSub(gc.id, 'Apex Drywall & Acoustics Inc.')
  const provisionalId = randomUUID()
  const now = new Date().toISOString()
  await dbRun(
    'INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [provisionalId, 'Pending document scan', 'Other', now, now],
  )
  await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [gc.id, provisionalId, now])
  const coiId = randomUUID()
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, effective_date, expiration_date, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Not provided', '2025-07-01', '2026-07-01', 'pending_review', ?, ?)`,
    [coiId, provisionalId, gc.id, now, now],
  )

  const { saveExtractedReview } = await import('../src/routes/coiFields.ts')
  const ok = await saveExtractedReview(coiId, null, sampleFields('Apex Drywall & Acoustics'), {
    overwrite: false,
    uploaderGcUserId: gc.id,
  })
  assert.equal(ok, true)

  const coi = await dbGet<any>('SELECT subcontractor_id FROM cois WHERE id = ?', [coiId])
  assert.equal(coi.subcontractor_id, realSub)
  const placeholder = await dbGet<any>('SELECT id FROM subcontractors WHERE id = ?', [provisionalId])
  assert.equal(placeholder, undefined)
})
