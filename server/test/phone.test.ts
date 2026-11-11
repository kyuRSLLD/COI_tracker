// Run with: node --experimental-strip-types --test server/test/phone.test.ts
// Uses only a temporary SQLite database; no production or seed data is touched.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { formatPhone, isValidUsPhone, US_PHONE_PATTERN } from '../../client/src/lib/formatPhone.ts'

const temp = await mkdtemp(path.join(tmpdir(), 'coi-phone-test-'))
process.env.SQLITE_PATH = path.join(temp, 'test.sqlite')
delete process.env.DATABASE_URL
const { dbExec, dbGet } = await import('../src/db/db.ts')
const { authRouter, normalizePhone } = await import('../src/routes/auth.ts')
await dbExec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password_hash TEXT, name TEXT, first_name TEXT, last_name TEXT, phone TEXT, company_name TEXT, role TEXT, created_at TEXT, subcontractor_id TEXT);
CREATE TABLE subcontractors (id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT, trade TEXT, contact_person TEXT, phone TEXT, email TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE user_phones (id TEXT PRIMARY KEY, user_id TEXT, phone TEXT, label TEXT, is_primary INTEGER, created_at TEXT);`)
const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => server.once('listening', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('server not listening')
const base = `http://127.0.0.1:${address.port}/api/auth`
async function post(endpoint: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: response.status, json: await response.json() as any }
}
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(temp, { recursive: true, force: true }) })

test('mask supports typing, formatted paste, country-code paste and visible excess digits', () => {
  let value = ''
  for (const char of '2244247271') value = formatPhone(value + char)
  assert.equal(value, '(224) 424-7271')
  assert.equal(formatPhone('(224) 424-7271'), value)
  assert.equal(formatPhone('+1 (224) 424-7271'), value)
  assert.equal(formatPhone('224424727'), '(224) 424-727')
  assert.equal(formatPhone('22442472712'), '(224) 424-72712')
  assert.equal(isValidUsPhone(value), true)
  assert.equal(isValidUsPhone(formatPhone('224424727')), false)
  assert.equal(isValidUsPhone(formatPhone('22442472712')), false)
  assert.match(value, new RegExp(`^(?:${US_PHONE_PATTERN})$`, 'v'))
})

test('normalization accepts valid US numbers and rejects invalid input', () => {
  for (const value of ['2244247271', '(224) 424-7271', '224-424-7271', '+1 (224) 424-7271', '12244247271']) assert.equal(normalizePhone(value), '(224) 424-7271')
  for (const value of ['', '224424727', '22442472712', '22244247271', '+2244247271', '2244247271 ext 1', 'letters', null, undefined]) assert.equal(normalizePhone(value), null)
})

test('registration rejects bad phones, normalizes valid ones, and preserves legacy name-only signup', async () => {
  const baseUser = { email: 'new@example.test', password: 'password', first_name: 'Jane', last_name: 'Doe' }
  for (const phone of ['', '224424727', '22442472712', '2244247271 ext 1']) {
    assert.equal((await post('/register', { ...baseUser, phone })).status, 400)
  }
  assert.equal((await post('/register', baseUser)).status, 400)
  assert.equal((await dbGet('SELECT COUNT(*) as n FROM users')).n, 0)
  const created = await post('/register', { ...baseUser, phone: '(224) 424-7271' })
  assert.equal(created.status, 200)
  assert.equal(created.json.user.phone, '(224) 424-7271')
  assert.equal((await dbGet('SELECT phone FROM user_phones WHERE user_id = ?', [created.json.user.id])).phone, '(224) 424-7271')
  assert.equal((await post('/register', { email: 'legacy@example.test', password: 'password', name: 'Legacy Client' })).status, 200)
})

test('add-phone endpoint rejects incomplete or malformed numbers before writing and accepts +1', async () => {
  const created = await post('/register', { email: 'add@example.test', password: 'password', name: 'Add Phone' })
  const token = created.json.token
  for (const phone of ['', '12345', '22442472712', '2244247271abc']) assert.equal((await post('/phones', { phone, is_primary: true }, token)).status, 400)
  assert.equal((await dbGet('SELECT COUNT(*) as n FROM user_phones WHERE user_id = ?', [created.json.user.id])).n, 0)
  const added = await post('/phones', { phone: '+1 (224) 424-7271', is_primary: true }, token)
  assert.equal(added.status, 200)
  assert.equal(added.json.phones[0].phone, '(224) 424-7271')
})
