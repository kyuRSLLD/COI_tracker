import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'crypto'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coi-sec-test-'))
process.env.SQLITE_PATH = path.join(tempDir, 'test.sqlite')
process.env.DATABASE_URL = ''
process.env.AWS_S3_BUCKET = ''
process.env.JWT_SECRET = 'test-only-secret'
process.env.NODE_ENV = 'test'

const { createApp } = await import('../src/app.ts')
const { dbRun, dbGet, dbAll } = await import('../src/db/db.ts')
const { signToken } = await import('../src/middleware/auth.ts')

async function createAdmin() {
  const now = new Date().toISOString()
  const id = randomUUID()
  await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'Admin', 'admin', ?)`, [id, `${id}@admin.test`, now])
  return { id, token: signToken({ id, email: `${id}@admin.test`, role: 'admin' }) }
}

async function createCompany(name: string, plan: string, mrr: number, isTest = 0) {
  const id = randomUUID()
  const now = new Date().toISOString()
  await dbRun(`INSERT INTO companies (id, name, plan, mrr, status, is_test, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`, [id, name, plan, mrr, isTest, now])
  return id
}

test('1.5 role endpoint accepts admin, gc, pro_gc, sub and protects last admin; pro_gc syncs company plan', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const admin = await createAdmin()
    const targetId = randomUUID()
    const now = new Date().toISOString()
    await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, 'target@x.test', 'x', 'T', 'gc', ?)`, [targetId, now])
    await dbRun(`INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at) VALUES (?, 'T Corp', 'General Contractor', 10, 'active', ?, ?)`, [randomUUID(), targetId, now])

    const setRole = (role: string) => fetch(`${base}/api/admin/users/${targetId}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })

    // sub
    assert.equal((await setRole('sub')).status, 200)
    assert.equal((await dbGet<any>('SELECT role FROM users WHERE id = ?', [targetId])).role, 'sub')

    // pro_gc auto-sets company plan to 'Pro GC'
    assert.equal((await setRole('pro_gc')).status, 200)
    assert.equal((await dbGet<any>('SELECT role FROM users WHERE id = ?', [targetId])).role, 'pro_gc')
    assert.equal((await dbGet<any>('SELECT plan FROM companies WHERE owner_user_id = ?', [targetId])).plan, 'Pro GC')

    // gc resets Pro GC plan
    assert.equal((await setRole('gc')).status, 200)
    assert.equal((await dbGet<any>('SELECT plan FROM companies WHERE owner_user_id = ?', [targetId])).plan, 'General Contractor')

    // invalid role rejected
    assert.equal((await setRole('manager')).status, 400)

    // cannot demote last admin
    assert.equal((await fetch(`${base}/api/admin/users/${admin.id}/role`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'gc' }),
    })).status, 400)
  } finally {
    server.close()
  }
})

test('1.6 plan change records audit row in plan_changes with reason', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const admin = await createAdmin()
    const cid = await createCompany('Acme Builders', 'General Contractor', 10)
    const res = await fetch(`${base}/api/admin/companies/${cid}/plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Pro GC', reason: 'Sales upgrade' }),
    })
    assert.equal(res.status, 200)
    const row = await dbGet<any>('SELECT from_plan, to_plan, changed_by, reason FROM plan_changes WHERE company_id = ? ORDER BY changed_at DESC LIMIT 1', [cid])
    assert.equal(row.from_plan, 'General Contractor')
    assert.equal(row.to_plan, 'Pro GC')
    assert.equal(row.reason, 'Sales upgrade')
    assert.ok(row.changed_by)
    const company = await dbGet<any>('SELECT plan, mrr FROM companies WHERE id = ?', [cid])
    assert.equal(company.plan, 'Pro GC')
    assert.equal(company.mrr, 29)
    // plan-changes list endpoint
    const list = await (await fetch(`${base}/api/admin/companies/${cid}/plan-changes`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.ok(Array.isArray(list.changes))
    assert.ok(list.changes.length >= 1)
    // invalid plan rejected
    assert.equal((await fetch(`${base}/api/admin/companies/${cid}/plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'Ultra' }),
    })).status, 400)
  } finally {
    server.close()
  }
})

test('1.7 test flag toggle and exclude_test=1 overview filtering', async () => {
  const app = await createApp({ maintenanceMode: false })
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const admin = await createAdmin()
    const real = await createCompany('Real GC LLC', 'General Contractor', 10, 0)
    const demo = await createCompany('Acme Demo Co', 'Pro GC', 29, 0)

    // toggle demo company's test flag
    const toggle = await fetch(`${base}/api/admin/companies/${demo}/test-flag`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_test: true }),
    })
    assert.equal(toggle.status, 200)
    assert.equal((await toggle.json() as any).is_test, true)
    assert.equal((await dbGet<any>('SELECT is_test FROM companies WHERE id = ?', [demo])).is_test, 1)

    // companies list returns boolean is_test
    const comps = await (await fetch(`${base}/api/admin/companies`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    const demoRow = comps.companies.find((c: any) => c.id === demo)
    assert.equal(demoRow.is_test, true)

    // overview without exclude includes both
    const ovAll = await (await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.ok(ovAll.revenue.mrr >= 39)

    // overview with exclude_test=1 excludes demo
    const ovClean = await (await fetch(`${base}/api/admin/overview?exclude_test=1`, { headers: { Authorization: `Bearer ${admin.token}` } })).json() as any
    assert.ok(ovClean.revenue.mrr < ovAll.revenue.mrr)
  } finally {
    server.close()
  }
})
