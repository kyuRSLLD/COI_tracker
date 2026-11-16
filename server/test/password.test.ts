import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-pw-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.JWT_SECRET = 'test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

async function createAdmin() {
  const now = new Date().toISOString()
  const id = randomUUID()
  const hash = await bcrypt.hash('admin-old-pass', 6)
  await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, 'Test Admin', 'admin', ?)`, [id, `admin-${Date.now()}@test.test`, hash, now])
  return { id, token: signToken({ id, role: 'admin' }) }
}

async function createUser(role = 'gc', password = 'user-old-pass') {
  const now = new Date().toISOString()
  const id = randomUUID()
  const hash = await bcrypt.hash(password, 6)
  await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, 'Test User', ?, ?)`, [id, `user-${randomUUID()}@test.test`, hash, role, now])
  return { id, token: signToken({ id, role }), password }
}

test('POST /api/auth/change-password — valid change succeeds, new password verifiable with bcrypt, old rejected', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  const base = `http://127.0.0.1:${port}`
  try {
    const admin = await createAdmin()
    const res = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'admin-old-pass', new_password: 'newSecretPassword123' }),
    })
    assert.equal(res.status, 200)
    const row = await dbGet<any>('SELECT password_hash FROM users WHERE id = ?', [admin.id])
    assert.ok(row)
    assert.ok(await bcrypt.compare('newSecretPassword123', row.password_hash))
    assert.ok(!(await bcrypt.compare('admin-old-pass', row.password_hash)))
  } finally { server.close() }
})

test('POST /api/auth/change-password — wrong current password returns 401', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const admin = await createAdmin()
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'WRONG', new_password: 'newSecretPassword123' }),
    })
    assert.equal(res.status, 401)
  } finally { server.close() }
})

test('POST /api/auth/change-password — new password under 8 chars returns 400', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const admin = await createAdmin()
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'admin-old-pass', new_password: 'short' }),
    })
    assert.equal(res.status, 400)
  } finally { server.close() }
})

test('PUT /api/admin/users/:id/password — admin resets any user password, bcrypt verifies', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const admin = await createAdmin()
    const user = await createUser('gc', 'weakpass1')
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/${user.id}/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: 'strongTempPassword9' }),
    })
    assert.equal(res.status, 200)
    const row = await dbGet<any>('SELECT password_hash FROM users WHERE id = ?', [user.id])
    assert.ok(row)
    assert.ok(await bcrypt.compare('strongTempPassword9', row.password_hash))
  } finally { server.close() }
})

test('PUT /api/admin/users/:id/password — non-admin receives 403', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const user = await createUser('gc')
    const victim = await createUser('sub')
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/${victim.id}/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: 'strongTempPassword9' }),
    })
    assert.equal(res.status, 403)
  } finally { server.close() }
})

test('PUT /api/admin/users/:id/password — under 8 chars returns 400', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const admin = await createAdmin()
    const user = await createUser('gc')
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/${user.id}/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: 'abc' }),
    })
    assert.equal(res.status, 400)
  } finally { server.close() }
})

test('PUT /api/admin/users/:id/password — unknown user returns 404', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const { port } = server.address() as any
  try {
    const admin = await createAdmin()
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/${randomUUID()}/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: 'strongTempPassword9' }),
    })
    assert.equal(res.status, 404)
  } finally { server.close() }
})
