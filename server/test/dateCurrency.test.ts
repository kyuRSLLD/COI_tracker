import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDisplayDate } from '../../client/src/lib/date.ts'
import { formatAmount } from '../../client/src/lib/currency.ts'

test('formatDisplayDate converts YYYY-MM-DD to MM/DD/YYYY', () => {
  assert.equal(formatDisplayDate('2026-03-01'), '03/01/2026')
  assert.equal(formatDisplayDate('2026-01-15'), '01/15/2026')
  assert.equal(formatDisplayDate('01/15/2026'), '01/15/2026')
  assert.equal(formatDisplayDate('1/5/26'), '01/05/2026')
  assert.equal(formatDisplayDate(''), '—')
  assert.equal(formatDisplayDate(null), '—')
})

test('formatAmount formats numbers as $x,xxx,xxx.xx', () => {
  assert.equal(formatAmount('1000000'), '$1,000,000.00')
  assert.equal(formatAmount('$2,000,000'), '$2,000,000.00')
  assert.equal(formatAmount('500000.5'), '$500,000.50')
  assert.equal(formatAmount('12345.67'), '$12,345.67')
  assert.equal(formatAmount('0'), '$0.00')
  assert.equal(formatAmount(''), '—')
  assert.equal(formatAmount(null), '—')
  assert.equal(formatAmount('not-a-number'), 'not-a-number')
})
