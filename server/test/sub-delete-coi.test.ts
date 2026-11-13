import test from 'node:test'
import assert from 'node:assert/strict'
import { dbGet, dbRun, deleteOwnedSubCOI, deleteOwnedGcCOI } from '../src/db/db.ts'; import { v4 as uuidv4 } from 'uuid'


const now = new Date().toISOString()

async function setup() {
  await dbRun("DELETE FROM coi_coverages")
  await dbRun("DELETE FROM cois")
  await dbRun("DELETE FROM gc_sub_connections")
  await dbRun("DELETE FROM subcontractors")
  await dbRun("DELETE FROM users")
}

test('subcontractor can delete their own COI, GC cannot delete a sub-owned COI', async (t) => {
  await setup()
  const sub = { id: uuidv4(), role: 'subcontractor' }
  const gc = { id: uuidv4(), role: 'gc' }
  for (const u of [sub, gc]) await dbRun(`INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, 'x', 'x', ?, ?)`, [u.id, `${u.id}@x.test`, u.role, now])
  const subco = { id: uuidv4(), name: 'S1', trade: 'Mason' }
  await dbRun(`INSERT INTO subcontractors (id, company_name, trade, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, [subco.id, subco.name, subco.trade, sub.id, now, now])
  await dbRun(`INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)`, [gc.id, subco.id, now])
  const c1 = uuidv4()
  await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_sub_user_id, created_at, updated_at) VALUES (?, ?, 'C', 'active', '2025-01-01', '2026-01-01', ?, ?, ?)`, [c1, subco.id, sub.id, now, now])
  await dbRun(`INSERT INTO coi_coverages (id, coi_id, type) VALUES (?, ?, 'GL')`, [uuidv4(), c1])

  await t.test('GC delete of sub-owned COI fails', async () => {
    assert.equal(await deleteOwnedGcCOI(c1, gc.id), false)
    assert.ok(await dbGet(`SELECT id FROM cois WHERE id = ?`, [c1]))
  })
  await t.test('sub deletes own COI; coverages cascade', async () => {
    assert.equal(await deleteOwnedSubCOI(c1, sub.id), true)
    assert.equal(await dbGet(`SELECT id FROM cois WHERE id = ?`, [c1]), undefined)
    assert.equal(await dbGet(`SELECT id FROM coi_coverages WHERE coi_id = ?`, [c1]), undefined)
  })
  await t.test('sub cannot delete a GC-owned COI', async () => {
    const c2 = uuidv4()
    await dbRun(`INSERT INTO cois (id, subcontractor_id, carrier, status, effective_date, expiration_date, owner_gc_user_id, created_at, updated_at) VALUES (?, ?, 'C', 'active', '2025-01-01', '2026-01-01', ?, ?, ?)`, [c2, subco.id, gc.id, now, now])
    assert.equal(await deleteOwnedSubCOI(c2, sub.id), false)
  })
})
