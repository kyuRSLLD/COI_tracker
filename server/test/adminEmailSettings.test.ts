import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-email-settings-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.JWT_SECRET = 'email-settings-test-secret'
process.env.NODE_ENV = 'test'
delete process.env.SMTP_HOST
delete process.env.SMTP_USER
delete process.env.SMTP_PASS

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet, initDatabase } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')
await initDatabase()

const now = () => new Date().toISOString()

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createAdmin() {
  const id = randomUUID()
  const email = `admin-${id}@example.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', 'Admin', 'admin', ?)`,
    [id, email, now()]
  )
  const token = signToken({ id, email, role: 'admin' })
  return { id, email, token }
}

test('email-settings endpoints require admin auth', async () => {
  const { port, close } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings`)
    assert.equal(res.status, 401)
  } finally {
    close()
  }
})

test('GET /api/admin/email-settings returns seeded defaults with pass redacted', async () => {
  const { port, close } = await startServer()
  const admin = await createAdmin()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.settings.provider, 'gmail')
    assert.equal(body.settings.from_email, 'backoffice@capitalcrestoration.com')
    assert.equal(body.settings.from_name, 'Capital Restoration')
    assert.equal(body.settings.sending_enabled, 0)
    assert.equal(body.settings.smtp_pass_configured, false)
    assert.equal(body.settings.smtp_pass_source, 'none')
    assert.equal(body.settings.smtp_pass, undefined) // never returned
    assert.equal(body.status.sending_enabled, false)
  } finally {
    close()
  }
})

test('PUT validates email, rejects invalid payload, updates allowed fields', async () => {
  const { port, close } = await startServer()
  const admin = await createAdmin()
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from_email: 'not-an-email' }),
    })
    assert.equal(bad.status, 400)

    const good = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_name: 'SafeCOI Notifications',
        from_email: 'notifications@safecoi.com',
        reply_to: 'support@safecoi.com',
        smtp_port: 587,
        sending_enabled: 0,
      }),
    })
    assert.equal(good.status, 200)
    const body = await good.json()
    assert.equal(body.settings.from_name, 'SafeCOI Notifications')
    assert.equal(body.settings.from_email, 'notifications@safecoi.com')
    assert.equal(body.settings.reply_to, 'support@safecoi.com')
  } finally {
    close()
  }
})

test('saving smtp_pass stores the secret but API never returns it', async () => {
  const { port, close } = await startServer()
  const admin = await createAdmin()
  try {
    const put = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ smtp_pass: 'google-app-password-xyz' }),
    })
    assert.equal(put.status, 200)
    const body = await put.json()
    assert.equal(body.settings.smtp_pass_configured, true)
    assert.equal(body.settings.smtp_pass_source, 'database')
    assert.equal(body.settings.smtp_pass, undefined)
    const row = await dbGet<any>('SELECT smtp_pass FROM email_settings WHERE id = ?', ['default'])
    assert.equal(row.smtp_pass, 'google-app-password-xyz')
  } finally {
    close()
  }
})

test('POST /api/admin/email-settings/test validates recipient and records failure cleanly without crashing', async () => {
  const { port, close } = await startServer()
  const admin = await createAdmin()
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'not-an-email' }),
    })
    assert.equal(bad.status, 400)

    const res = await fetch(`http://127.0.0.1:${port}/api/admin/email-settings/test`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'qa-tester@example.test' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.status, 'failed')
    assert.ok(body.error && body.error.length > 0)
    assert.equal(body.last_test.to, 'qa-tester@example.test')
    assert.equal(body.last_test.status, 'failed')
  } finally {
    close()
  }
})
