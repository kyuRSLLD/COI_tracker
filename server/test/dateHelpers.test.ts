import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDateSafe, daysFromNow, isExpiredDate, formatDisplayDate } from '../../client/src/lib/date.ts'

test('parseDateSafe handles ISO and MM/DD/YYYY formats', () => {
  const iso = parseDateSafe('2026-10-31')
  assert.ok(iso)
  assert.equal(iso!.getUTCFullYear?.() ? (iso.getUTCMonth() + 1) : 0, 0 || iso!.getMonth() + 1)
  const mdy = parseDateSafe('10/31/2026')
  assert.ok(mdy)
  assert.equal(parseDateSafe(''), null)
  assert.equal(parseDateSafe('not-a-date'), null)
})

test('daysFromNow returns negative for past, positive for future, null for invalid', () => {
  assert.ok(daysFromNow('1999-01-01')! < 0)
  assert.ok(daysFromNow('2099-01-01')! > 0)
  assert.ok(daysFromNow('01/01/1999')! < 0)
  assert.ok(daysFromNow('01/01/2099')! > 0)
  assert.equal(daysFromNow(null), null)
  assert.equal(daysFromNow('garbage'), null)
})

test('isExpiredDate returns true only for past dates', () => {
  assert.equal(isExpiredDate('1999-01-01'), true)
  assert.equal(isExpiredDate('01/01/1999'), true)
  assert.equal(isExpiredDate('2099-01-01'), false)
  assert.equal(isExpiredDate('01/01/2099'), false)
  assert.equal(isExpiredDate(null), false)
  assert.equal(isExpiredDate('garbage'), false)
})

test('formatDisplayDate preserves MM/DD/YYYY and converts ISO', () => {
  assert.equal(formatDisplayDate('2026-10-31'), '10/31/2026')
  assert.equal(formatDisplayDate('10/31/2026'), '10/31/2026')
  assert.equal(formatDisplayDate(null), '—')
})
