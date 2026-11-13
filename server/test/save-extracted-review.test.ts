import test from 'node:test'
import assert from 'node:assert/strict'
import { saveExtractedReview } from '../src/routes/coiFields.ts'
import { dbRun, dbGet } from '../src/db/db.ts'
import { randomUUID } from 'crypto'
async function insertCoi(id: string, key: string | null) {
  const now = new Date().toISOString()
  await dbRun(`INSERT OR IGNORE INTO subcontractors (id, company_name, created_at, updated_at) VALUES ('sub-test', 'Test Sub', ?, ?)`, [now, now])
  await dbRun(
    `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at) VALUES (?, 'sub-test', 'X', 'pending_review', '2026-01-01', '2027-01-01', ?, 'x.png', 1, 'image/png', ?, ?)`,
    [id, key, now, now],
  )
}
test('saveExtractedReview persists fields and bumps revision, and re-extraction refreshes it', async () => {
  const coiId = randomUUID()
  const key = 'cois/test-' + randomUUID() + '.png'
  await insertCoi(coiId, key)
  const ok = await saveExtractedReview(coiId, key, { producer: { name: 'Acme Brokerage' }, insured: { name: 'Acme Co' }, source: 'ocr' })
  assert.equal(ok, true)
  const row = await dbGet<{ details_json: string }>(`SELECT details_json FROM coi_field_reviews WHERE coi_id = ?`, [coiId])
  assert.match(row?.details_json || '', /Acme Brokerage/)
  const ver = await dbGet<{ revision: string }>(`SELECT revision FROM coi_field_review_versions WHERE coi_id = ?`, [coiId])
  assert.ok(ver?.revision)
  // re-extraction refreshes existing machine review
  const ok2 = await saveExtractedReview(coiId, key, { producer: { name: 'BETTER NAME' }, source: 'ocr' })
  assert.equal(ok2, true)
  const row2 = await dbGet<{ details_json: string }>(`SELECT details_json FROM coi_field_reviews WHERE coi_id = ?`, [coiId])
  assert.match(row2?.details_json || '', /BETTER NAME/)
})
test('saveExtractedReview rejects key mismatches and invalid shapes', async () => {
  const coiId = randomUUID()
  await insertCoi(coiId, 'cois/a.png')
  assert.equal(await saveExtractedReview(coiId, 'cois/WRONG.png', { insured: { name: 'X' } }), false)
  assert.equal(await saveExtractedReview(coiId, 'cois/a.png', { producer: { name: 'a'.repeat(300) } }), false)
})
