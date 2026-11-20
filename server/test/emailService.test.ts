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

const {
  sendEmail,
  getEmailSettings,
  saveEmailSettings,
  invalidateEmailSettingsCache,
  emailMode,
  isRealEmailConfigured,
} = await import('../src/services/email.ts')

test('default seeded settings: gmail provider, Capital Restoration from, backoffice@capitalcrestoration.com, sending_enabled=0', async () => {
  const s = await getEmailSettings()
  assert.equal(s.provider, 'gmail')
  assert.equal(s.from_name, 'Capital Restoration')
  assert.equal(s.from_email, 'backoffice@capitalcrestoration.com')
  assert.equal(s.smtp_host, 'smtp.gmail.com')
  assert.equal(s.smtp_port, 587)
  assert.equal(s.sending_enabled, 0)
})

test('master pause: non-test sends are simulated and logged when sending_enabled=0', async () => {
  const res = await sendEmail({ to: 'sub@x.test', subject: 'Test', body: 'Hello', type: 'general' })
  assert.equal(res.status, 'simulated')
  const row = await dbGet<any>('SELECT to_email, status, type FROM email_logs WHERE id = ?', [res.id])
  assert.equal(row.to_email, 'sub@x.test')
  assert.equal(row.status, 'simulated')
  assert.equal(row.type, 'general')
})

test('isRealEmailConfigured is false without credentials', async () => {
  assert.equal(isRealEmailConfigured(), false)
})

test('isRealEmailConfigured is true when SMTP_PASS is present', async () => {
  process.env.SMTP_PASS = 'app-password-123'
  assert.equal(isRealEmailConfigured(), true)
  delete process.env.SMTP_PASS
  assert.equal(isRealEmailConfigured(), false)
})

test('saveEmailSettings updates provider, sender, and sending switch', async () => {
  const updated = await saveEmailSettings({
    provider: 'smtp',
    from_name: 'Test Sender',
    from_email: 'noreply@example.com',
    smtp_host: 'mail.example.com',
    smtp_port: 465,
    sending_enabled: 1,
  })
  assert.equal(updated.provider, 'smtp')
  assert.equal(updated.from_name, 'Test Sender')
  assert.equal(updated.from_email, 'noreply@example.com')
  assert.equal(updated.smtp_host, 'mail.example.com')
  assert.equal(updated.smtp_port, 465)
  assert.equal(updated.sending_enabled, 1)

  // reset to seeded state for remaining tests
  await saveEmailSettings({
    provider: 'gmail',
    from_name: 'Capital Restoration',
    from_email: 'backoffice@capitalcrestoration.com',
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    sending_enabled: 0,
  })
})

test('env fallback detected when DB provider is simulated', async () => {
  await saveEmailSettings({ provider: 'simulated' })
  process.env.POSTMARK_SERVER_TOKEN = 'token-123'
  assert.equal(emailMode(), 'postmark')
  delete process.env.POSTMARK_SERVER_TOKEN
  process.env.SENDGRID_API_KEY = 'SG.123'
  assert.equal(emailMode(), 'sendgrid')
  delete process.env.SENDGRID_API_KEY
  process.env.SMTP_HOST = 'smtp.test'
  process.env.SMTP_USER = 'u'
  process.env.SMTP_PASS = 'p'
  assert.equal(emailMode(), 'smtp')
  delete process.env.SMTP_HOST
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS
  assert.equal(emailMode(), 'simulated')
  await saveEmailSettings({ provider: 'gmail' })
})

test('sendTestEmail records failure cleanly when credentials missing', async () => {
  const { sendTestEmail } = await import('../src/services/email.ts')
  const out = await sendTestEmail('recipient@x.test')
  assert.equal(out.ok, false)
  assert.equal(out.status, 'failed')
  assert.ok(out.error && out.error.length > 0)
  const s = await getEmailSettings()
  assert.equal(s.last_test_to, 'recipient@x.test')
  assert.equal(s.last_test_status, 'failed')
  assert.ok(s.last_test_at)
})
