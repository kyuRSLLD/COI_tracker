import test from 'node:test'
import assert from 'node:assert/strict'
import { mapAnalysisToFields } from '../src/services/textract.ts'

function mockAnalysis(kvs: Array<[string, string]>): any {
  const blocks: any[] = []
  let id = 1
  for (const [key, val] of kvs) {
    const keyId = `k${id}`, valId = `v${id}`, keyTextId = `kt${id}`, valTextId = `vt${id}`
    id++
    blocks.push(
      { Id: keyId, BlockType: 'KEY_VALUE_SET', EntityTypes: ['KEY'], Relationships: [{ Type: 'CHILD', Ids: [keyTextId] }, { Type: 'VALUE', Ids: [valId] }] },
      { Id: keyTextId, BlockType: 'WORD', Text: key },
      { Id: valId, BlockType: 'KEY_VALUE_SET', EntityTypes: ['VALUE'], Relationships: [{ Type: 'CHILD', Ids: [valTextId] }] },
      { Id: valTextId, BlockType: 'WORD', Text: val },
    )
  }
  return { Blocks: blocks }
}

test('real ACORD fixture extracts normalized policy number and dates', () => {
  const analysis = mockAnalysis([
    ['producer', 'ABC Insurance Broker'],
    ['insured', 'TOTAL HOME IMPROVEMENT LLC'],
    ['insurer a', 'U.S. Specialty Insurance Company'],
    ['insurer a naic #', '29559'],
    ['commercial general liability policy number', 'U21AC122599-03'],
    ['policy eff date', '03/12/2023'],
    ['policy exp date', '03/12/2024'],
    ['each occurrence', '1,000,000.00'],
  ])
  const fields = mapAnalysisToFields(analysis)
  assert.equal(fields.producer?.name, 'ABC Insurance Broker')
  assert.equal(fields.insured?.name, 'TOTAL HOME IMPROVEMENT LLC')
  assert.equal(fields.insurers?.[0]?.name, 'U.S. Specialty Insurance Company')
  assert.equal(fields.insurers?.[0]?.naic, '29559')
  assert.equal(fields.policies?.[0]?.policyNumber, 'U21AC122599-03')
  assert.equal(fields.policies?.[0]?.effectiveDate, '2023-03-12')
  assert.equal(fields.policies?.[0]?.expirationDate, '2024-03-12')
})


test('date salvage picks first two valid dates anywhere in the document', () => {
  const analysis = mockAnalysis([
    ['insured', 'TOTAL HOME IMPROVEMENT LLC'],
    ['commercial general liability policy number', 'U21AC122599-03'],
    ['random note', '03/12/2023'],
    ['another note', '03/12/2024'],
  ])
  const fields = mapAnalysisToFields(analysis)
  assert.equal(fields.policies?.[0]?.effectiveDate, '2023-03-12')
  assert.equal(fields.policies?.[0]?.expirationDate, '2024-03-12')
})
