import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-email-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.JWT_SECRET = 'test-only-secret'
process.env.NODE_ENV = 'test'
delete process.env.SMTP_HOST
delete process.env.SMTP_USER
delete process.env.SMTP_PASS
delete process.env.POSTMARK_SERVER_TOKEN
delete process.env.SENDGRID_API_KEY

const { initDatabase, dbGet } = await import('../src/db/db.ts')
await initDatabase()
const { sendEmail, emailMode, isRealEmailConfigured } = await import('../src/services/email.ts')

test('1.3 simulated mode when no provider configured: status simulated and logged', async () => {
  assert.equal(emailMode(), 'simulated')
  assert.equal(isRealEmailConfigured(), false)
  const res = await sendEmail({ to: 'sub@x.test', subject: 'Test', body: 'Hello', type: 'general' })
  assert.equal(res.status, 'simulated')
  const row = await dbGet<any>('SELECT to_email, status, type FROM email_logs WHERE id = ?', [res.id])
  assert.equal(row.to_email, 'sub@x.test')
  assert.equal(row.status, 'simulated')
  assert.equal(row.type, 'general')
})

test('1.3 provider env shapes detected correctly', async () => {
  process.env.POSTMARK_SERVER_TOKEN = 'token-123'
  assert.equal(emailMode(), 'postmark')
  assert.equal(isRealEmailConfigured(), true)
  delete process.env.POSTMARK_SERVER_TOKEN

  process.env.SENDGRID_API_KEY = 'SG.123'
  assert.equal(emailMode(), 'sendgrid')
  assert.equal(isRealEmailConfigured(), true)
  delete process.env.SENDGRID_API_KEY

  process.env.SMTP_HOST = 'smtp.test'
  process.env.SMTP_USER = 'u'
  process.env.SMTP_PASS = 'p'
  assert.equal(emailMode(), 'smtp')
  assert.equal(isRealEmailConfigured(), true)
  delete process.env.SMTP_HOST
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS

  assert.equal(emailMode(), 'simulated')
})
