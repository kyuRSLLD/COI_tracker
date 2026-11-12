import { test } from 'node:test'
import assert from 'node:assert/strict'

// These must precede imports: even seed() clears only this disposable in-memory DB.
process.env.DATABASE_URL = ''
process.env.SQLITE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { dbAll, dbGet, dbRun, initDatabase, isPostgres, PLAN_PRICES, planToMRR } = await import('../src/db/db.ts')
const { seed } = await import('../src/seed.ts')

test('subcontractor pricing, insert-only startup backfill, and seed accounting', async () => {
  assert.equal(isPostgres, false, 'the test must never connect to PostgreSQL')
  assert.deepEqual(PLAN_PRICES, {
    'Free Demo': 0,
    Subcontractor: 0,
    'General Contractor': 10,
    'Pro GC': 29,
  })
  assert.equal(planToMRR('Subcontractor'), 0)
  assert.equal(planToMRR('General Contractor'), 10)
  assert.equal(planToMRR('Pro GC'), 29)
  assert.equal(planToMRR('Unknown'), 10)

  await initDatabase()
  const createdAt = '2026-01-01T00:00:00.000Z'
  const users = [
    ['new-sub', 'New Sub Co', 'sub'],
    ['new-gc', 'New GC Co', 'gc'],
    ['new-admin', 'New Admin Co', 'admin'],
    ['null-role', 'Null Role Co', null],
    ['existing-sub', 'Existing Legacy Sub', 'sub'],
    ['shared-sub', 'Shared Co', 'sub'],
    ['no-company', null, 'sub'],
  ]
  for (const [id, company, role] of users) {
    await dbRun(`INSERT INTO users (id, email, password_hash, name, company_name, role, created_at)
      VALUES (?, ?, 'unused', ?, ?, ?, ?)`, [id, `${id}@example.test`, id, company, role, createdAt])
  }
  await dbRun(`INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
    VALUES ('legacy', 'Existing Legacy Sub', 'Subcontractor', 2, 'inactive', NULL, ?)`, [createdAt])
  await dbRun(`INSERT INTO companies (id, name, plan, mrr, status, owner_user_id, created_at)
    VALUES ('shared', 'Shared Co', 'Pro GC', 29, 'active', 'another-owner', ?)`, [createdAt])
  const before = await dbAll('SELECT * FROM companies ORDER BY id')

  await initDatabase()
  assert.deepEqual(await dbAll("SELECT * FROM companies WHERE id IN ('legacy', 'shared') ORDER BY id"), before,
    'existing company data, including ownership and historical MRR, must not be changed')
  for (const [name, plan, mrr, owner] of [
    ['New Sub Co', 'Subcontractor', 0, 'new-sub'],
    ['New GC Co', 'General Contractor', 10, 'new-gc'],
    ['New Admin Co', 'General Contractor', 10, 'new-admin'],
    ['Null Role Co', 'General Contractor', 10, 'null-role'],
  ]) {
    assert.deepEqual(await dbGet('SELECT plan, mrr, owner_user_id, created_at FROM companies WHERE name = ?', [name]),
      { plan, mrr, owner_user_id: owner, created_at: createdAt })
  }
  assert.equal((await dbGet<{ count: number }>('SELECT COUNT(*) AS count FROM companies'))?.count, 6)
  const after = await dbAll('SELECT * FROM companies ORDER BY id')
  await initDatabase()
  assert.deepEqual(await dbAll('SELECT * FROM companies ORDER BY id'), after, 'repeated startup must not change existing companies')

  await seed()
  const seeded = await dbAll<{ name: string; plan: string; mrr: number }>('SELECT name, plan, mrr FROM companies ORDER BY name')
  const seededSubs = seeded.filter((company) => company.plan === 'Subcontractor')
  assert.deepEqual(seededSubs.map((company) => company.name), [
    'Crestline Electrical Co.', 'Keystone Drywall & Frame', 'Strata Steel & Structural', 'Summit Contracting',
  ])
  assert.ok(seededSubs.every((company) => company.mrr === 0))
  for (const company of seeded) assert.equal(company.mrr, planToMRR(company.plan), company.name)
  // Two seeded sub users have no company until the next startup backfill.
  await initDatabase()
  for (const name of ['Horizon Electrical Services', 'Blue Ridge Plumbing & Fire Protection']) {
    assert.deepEqual(await dbGet('SELECT plan, mrr FROM companies WHERE name = ?', [name]), { plan: 'Subcontractor', mrr: 0 })
  }
  assert.deepEqual(await dbAll('SELECT name, plan, mrr FROM companies WHERE name NOT IN (?, ?) ORDER BY name',
    ['Horizon Electrical Services', 'Blue Ridge Plumbing & Fire Protection']), seeded,
    'startup must preserve all pre-existing seeded company rows')
})
