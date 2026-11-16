import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { normalizeDate, cleanPolicyNumber, normalizeAmount, tryAnalyzeCoiDocument, isOcrConfigured, isTextractConfigured } from '../src/services/aiExtract.ts'

test('normalizeDate parses US, ISO and dotted formats', () => {
  assert.equal(normalizeDate('01/15/2026'), '01/15/2026')
  assert.equal(normalizeDate('2026-03-01'), '03/01/2026')
  assert.equal(normalizeDate('2026.04.05'), '04/05/2026')
  assert.equal(normalizeDate('not-a-date'), undefined)
  assert.equal(normalizeDate(''), undefined)
})

test('normalizeAmount formats as currency with two decimals', () => {
  assert.equal(normalizeAmount('1000000'), '$1,000,000.00')
  assert.equal(normalizeAmount('$2,000,000'), '$2,000,000.00')
  assert.equal(normalizeAmount('500000.5'), '$500,000.50')
  assert.equal(normalizeAmount(''), undefined)
  assert.equal(normalizeAmount('not-a-number'), 'not-a-number')
})

test('cleanPolicyNumber strips prefixes', () => {
  assert.equal(cleanPolicyNumber('# GL-2026-901'), 'GL-2026-901')
  assert.equal(cleanPolicyNumber('POLICY # AUTO-773'), 'AUTO-773')
  assert.equal(cleanPolicyNumber('number WC-55'), 'WC-55')
  assert.equal(cleanPolicyNumber(''), undefined)
})

test('configuration flags reflect OPENAI_API_KEY presence', () => {
  assert.equal(typeof isOcrConfigured(), 'boolean')
  assert.equal(isTextractConfigured, isOcrConfigured)
})

test('tryAnalyzeCoiDocument extracts fields from a simulated COI image via sandbox AI proxy', async () => {
  if (!process.env.OPENAI_API_KEY) {
    const r = await tryAnalyzeCoiDocument(Buffer.from('not-an-image'))
    assert.equal(r.ok, false)
    assert.equal(r.errorCode, 'NotConfigured')
    return
  }
  const imgPath = '/tmp/pdfconv/coi_sim.png'
  if (!fs.existsSync(imgPath)) return
  const prev = process.env.OPENAI_MODEL
  process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini'
  let r: any
  try {
    r = await tryAnalyzeCoiDocument(fs.readFileSync(imgPath))
  } finally {
    process.env.OPENAI_MODEL = prev
  }
  assert.equal(r.ok, true, `extraction failed: ${r.error}`)
  const f = r.fields!
  assert.ok(f.producer?.name?.includes('ACME'), `producer: ${JSON.stringify(f.producer)}`)
  assert.ok(f.insured?.name?.includes('Midwest Framing'), `insured: ${JSON.stringify(f.insured)}`)
  assert.ok(Array.isArray(f.insurers) && f.insurers.length >= 2, `insurers: ${JSON.stringify(f.insurers)}`)
  assert.ok(Array.isArray(f.policies) && f.policies.length >= 2, `policies: ${JSON.stringify(f.policies)}`)
  assert.equal(f.source, 'ocr')
})
