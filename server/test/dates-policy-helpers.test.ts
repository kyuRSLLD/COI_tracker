import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDate, cleanPolicyNumber } from '../src/services/textract.ts'

test('normalizeDate parses US MM/DD/YYYY, ISO, short years, slashes and dots', () => {
  assert.equal(normalizeDate('03/12/2023'), '2023-03-12')
  assert.equal(normalizeDate('3/12/2023'), '2023-03-12')
  assert.equal(normalizeDate('2023-03-12'), '2023-03-12')
  assert.equal(normalizeDate('12.5.24'), '2024-12-05')
  assert.equal(normalizeDate('garbage'), undefined)
  assert.equal(normalizeDate(), undefined)
})
test('cleanPolicyNumber strips label noise and whitespace', () => {
  assert.equal(cleanPolicyNumber('POLICY # U21AC122599-03'), 'U21AC122599-03')
  assert.equal(cleanPolicyNumber('# U21AC122599-03 '), 'U21AC122599-03')
  assert.equal(cleanPolicyNumber('no. 12345'), '12345')
  assert.equal(cleanPolicyNumber(''), undefined)
})
