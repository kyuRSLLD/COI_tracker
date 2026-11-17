import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.ts'
import { dbRun, initDatabase } from '../src/db/db.ts'
import { signToken } from '../src/middleware/auth.ts'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-kpi-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.AWS_ACCESS_KEY_ID = ''
process.env.AWS_SECRET_ACCESS_KEY = ''
process.env.AWS_S3_ENDPOINT = ''
process.env.JWT_SECRET = 'kpi-test-secret-only'
process.env.NODE_ENV = 'test'

await initDatabase()

const now = () => new Date().toISOString()
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

async function startServer() {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as any).port
  return { port, close: () => server.close() }
}

async function createGc() {
  const id = randomUUID()
  const email = `gc-${id}@example.test`
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'hash', 'GC', 'gc', ?)`,
    [id, email, now()],
  )
  return { id, token: signToken({ id, email, role: 'gc', name: 'GC' }) }
}

async function setup() {
  await dbRun('DELETE FROM coi_coverages')
  await dbRun('DELETE FROM cois')
  await dbRun('DELETE FROM gc_sub_connections')
  await dbRun('DELETE FROM subcontractors')
  await dbRun('DELETE FROM users')
}

test('apiSubcontractors.list computes status and expiration metadata per bucket', async () => {
  await setup()
  const gc = await createGc()
  const { port, close } = await startServer()
  try {
    const today = new Date()
    const in90 = new Date(today); in90.setDate(today.getDate() + 90)
    const in15 = new Date(today); in15.setDate(today.getDate() + 15)
    const ago20 = new Date(today); ago20.setDate(today.getDate() - 20)

    const subs = [
      { id: randomUUID(), name: 'Compliant Co', exp: isoDate(in90), status: 'compliant' },
      { id: randomUUID(), name: 'Expiring Co', exp: isoDate(in15), status: 'compliant' },
      { id: randomUUID(), name: 'Expired Co', exp: isoDate(ago20), status: 'compliant' },
      { id: randomUUID(), name: 'Missing Co', exp: null, status: null },
      { id: randomUUID(), name: 'Pending Co', exp: isoDate(in90), status: 'pending_review' },
    ]

    for (const s of subs) {
      await dbRun(
        `INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, 'Electrical', ?, ?)`,
        [s.id, s.name, now(), now()],
      )
      await dbRun(
        `INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)`,
        [gc.id, s.id, now()],
      )
      if (s.exp) {
        await dbRun(
          `INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_gc_user_id, created_at, updated_at)
           VALUES (?, ?, 'Acme', ?, '2026-01-01', ?, ?, ?, ?)`,
          [randomUUID(), s.id, s.status, s.exp, gc.id, now(), now()],
        )
      }
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/subcontractors`, {
      headers: { Authorization: `Bearer ${gc.token}` },
    })
    assert.equal(res.status, 200)
    const { subcontractors } = (await res.json()) as any

    const byName = Object.fromEntries(subcontractors.map((s: any) => [s.company_name, s]))

    assert.equal(byName['Compliant Co'].computed_status, 'compliant')
    assert.ok(byName['Compliant Co'].days_left >= 85)

    assert.equal(byName['Expiring Co'].computed_status, 'expiring_soon')
    assert.ok(byName['Expiring Co'].days_left <= 15 && byName['Expiring Co'].days_left >= 0)

    assert.equal(byName['Expired Co'].computed_status, 'expired')
    assert.ok(byName['Expired Co'].days_left < 0)

    assert.equal(byName['Missing Co'].computed_status, 'missing')
    assert.equal(byName['Missing Co'].best_coi, null)

    assert.equal(byName['Pending Co'].computed_status, 'pending_review')
  } finally {
    close()
  }
})
