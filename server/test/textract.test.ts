import test from 'node:test'
import assert from 'node:assert/strict'
import { mapAnalysisToFields } from '../src/services/textract.ts'
function mockAnalysis(kvs: Array<[string, string]>): any {
  const blocks: any[] = []
  let id = 1
  for (const [keyText, valueText] of kvs) {
    const keyId = `k${id}`, valId = `v${id}`, keyTextId = `kt${id}`, valTextId = `vt${id}`
    blocks.push(
      { BlockType: 'KEY_VALUE_SET', Id: keyId, EntityTypes: ['KEY'], Relationships: [{ Type: 'CHILD', Ids: [keyTextId] }, { Type: 'VALUE', Ids: [valId] }] },
      { BlockType: 'LINE', Id: keyTextId, Text: keyText },
      { BlockType: 'KEY_VALUE_SET', Id: valId, EntityTypes: ['VALUE'], Relationships: [{ Type: 'CHILD', Ids: [valTextId] }] },
      { BlockType: 'LINE', Id: valTextId, Text: valueText },
    )
    id++
  }
  return { Blocks: blocks }
}
test('maps producer, insured, insurers and policy lines', () => {
  const analysis = mockAnalysis([
    ['Producer', 'ACME Insurance Brokerage'],
    ['Producer phone', '(555) 010-9999'],
    ['E-Mail', 'info@acme.example'],
    ['Insured', 'Midwest Framing LLC'],
    ['Insurer A', 'Travelers'],
    ['Insurer A NAIC #', '25658'],
    ['Insurer B', 'Nationwide Mutual Insurance'],
    ['Insurer B NAIC #', '23787'],
    ['General Liability policy number', 'GL-2026-901'],
    ['General liability effective date', '2026-01-01'],
    ['General liability expiration date', '2027-01-01'],
    ['Each occurrence', '1,000,000'],
    ['General aggregate', '$2,000,000'],
  ])
  const fields = mapAnalysisToFields(analysis)
  assert.equal(fields.producer?.name, 'ACME Insurance Brokerage')
  assert.equal(fields.producer?.phone, '(555) 010-9999')
  assert.equal(fields.producer?.email, 'info@acme.example')
  assert.equal(fields.insured?.name, 'Midwest Framing LLC')
  assert.deepEqual(fields.insurers, [
    { letter: 'A', name: 'Travelers', naic: '25658' },
    { letter: 'B', name: 'Nationwide Mutual Insurance', naic: '23787' },
  ])
  assert.equal(fields.policies?.[0].type, 'General Liability')
  assert.equal(fields.policies?.[0].policyNumber, 'GL-2026-901')
  assert.equal(fields.policies?.[0].effectiveDate, '2026-01-01')
  assert.equal(fields.policies?.[0].expirationDate, '2027-01-01')
  assert.deepEqual(fields.policies?.[0].limits, [
    { label: 'each occurrence', amount: '1,000,000' },
    { label: 'general aggregate', amount: '$2,000,000' },
  ])
  assert.equal(fields.source, 'ocr')
})
test('empty analysis yields manual source and no producer/insured', () => {
  const fields = mapAnalysisToFields({ Blocks: [] })
  assert.equal(fields.source, 'manual')
  assert.equal(fields.producer, undefined)
  assert.equal(fields.insured, undefined)
  assert.equal(fields.insurers, undefined)
  assert.equal(fields.policies, undefined)
})
