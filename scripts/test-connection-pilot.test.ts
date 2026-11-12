import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import express from 'express'
import { createV2Registration } from '../server/src/v2/registration.ts'
import { migrateAuthV2V1 } from '../server/src/db/migrations/003_auth_v2.ts'

const port = process.env.PILOT_TEST_PORT
if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Disposable harness port required')
const common = { host: '127.0.0.1', port: Number(port), password: 'synthetic-only', ssl: false }
const client = (db: string, user = 'pilot_owner') => new pg.Client({ ...common, database: `pilot_connection_${db}`, user })
const envFor = (db: string) => ({ HOME: process.env.HOME!, PATH: process.env.PATH!, NODE_ENV: 'test', PILOT_ALLOW: 'I_UNDERSTAND_DISPOSABLE_CONNECTION_ONLY', PILOT_DB_NAME: `pilot_connection_${db}`, PILOT_CONFIRM_DATABASE: `pilot_connection_${db}`, PILOT_DB_USER: 'pilot_owner', PILOT_DB_PASSWORD: 'synthetic-only', PILOT_DB_PORT: port })
function run(db: string, overrides: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/provision-connection-pilot.ts'], { cwd: process.cwd(), env: { ...envFor(db), ...overrides }, encoding: 'utf8', timeout: 30000 })
}
async function connect(db: string, user?: string) { const c = client(db, user); await c.connect(); return c }

test('guard rejects invalid configuration before a connection and never echoes secrets', () => {
  for (const override of [
    { PILOT_ALLOW: '' }, { PILOT_CONFIRM_DATABASE: 'wrong' }, { PILOT_DB_NAME: 'production' },
    { PILOT_DB_PORT: '01' }, { PILOT_DB_PORT: '65536' }, { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgres://secret@remote/prod' }, { PGHOST: 'remote' }, { PGOPTIONS: '-c search_path=evil' },
    { PILOT_DB_HOST: 'remote.example' }, { SECURE_V2_DB_HOST: 'remote.example' },
  ]) {
    const p = run('success', override); assert.notEqual(p.status, 0); assert.doesNotMatch(p.stdout + p.stderr, /synthetic-only|postgres:\/\/secret/)
  }
})

test('changed migration source is rejected before any schema write', async () => {
  const root = mkdtempSync(join(process.cwd(), '.work', 'connection-pilot-copy-'))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true }); mkdirSync(join(root, 'server/src/db/migrations'), { recursive: true })
    copyFileSync('scripts/provision-connection-pilot.ts', join(root, 'scripts/provision-connection-pilot.ts'))
    copyFileSync('server/src/db/ownerConnection.ts', join(root, 'server/src/db/ownerConnection.ts'))
    for (const name of ['001_owner_foundation.ts','002_gc_sub_consent.ts','003_auth_v2.ts','004_registration_v2.ts','005_fresh_sub_profile_evidence.ts']) copyFileSync(`server/src/db/migrations/${name}`, join(root, 'server/src/db/migrations', name))
    appendFileSync(join(root, 'server/src/db/migrations/003_auth_v2.ts'), '\n// changed\n')
    const p = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/provision-connection-pilot.ts')], { env: envFor('success'), encoding: 'utf8', timeout: 30000 })
    assert.notEqual(p.status, 0)
    const c = await connect('success'); assert.equal((await c.query("SELECT to_regclass('public.users') AS name")).rows[0].name, null); await c.end()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects nonempty objects, schema, public access, active sessions and competing pilot lock without writes', async () => {
  const wrongOwner = run('success', { PILOT_DB_USER: 'pilot_admin' })
  assert.notEqual(wrongOwner.status, 0); assert.match(wrongOwner.stderr, /Target identity/)
  for (const [db, setup] of [
    ['dirty', 'CREATE TABLE public.existing(id int)'],
    ['function', 'CREATE FUNCTION public.existing() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$'],
    ['schema', 'CREATE SCHEMA other'],
  ]) {
    const c = await connect(db); await c.query(setup); await c.end()
    const p = run(db); assert.notEqual(p.status, 0, db); assert.match(p.stderr, /not isolated, empty, or exclusively writable/)
    const check = await connect(db); assert.equal((await check.query("SELECT to_regclass('public.users') AS name")).rows[0].name, null); await check.end()
  }
  const admin = await connect('grant', 'pilot_admin'); await admin.query('GRANT CONNECT ON DATABASE pilot_connection_grant TO PUBLIC'); await admin.end()
  assert.notEqual(run('grant').status, 0)
  const active = await connect('active'); assert.notEqual(run('active').status, 0); await active.end()
  const lock = await connect('lock'); await lock.query('SELECT pg_advisory_lock(1129273683,16100)'); const blocked = run('lock'); assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /holds the lock/); await lock.end()
})

test('actual migration rolls back its own ledger and DDL on an injected mid-step failure', async () => {
  const c = await connect('failure')
  try {
    await c.query('CREATE TABLE users(id text PRIMARY KEY, password_hash text, role text)')
    const realQuery = c.query.bind(c)
    const wrapped = { query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('CREATE TABLE auth_v2_sessions')) throw new Error('injected failure')
      return realQuery(sql, values as any)
    } }
    await assert.rejects(migrateAuthV2V1(wrapped as pg.Client), /injected failure/)
    const r = (await c.query("SELECT to_regclass('public.users') AS base, to_regclass('public.auth_v2_accounts') AS accounts, to_regclass('public.auth_v2_schema_migrations') AS ledger")).rows[0]
    assert.equal(r.base, 'users'); assert.equal(r.accounts, null); assert.equal(r.ledger, null)
    assert.equal((await c.query('SELECT 1 AS ok')).rows[0].ok, 1)
  } finally { await c.end() }
})

test('fresh pilot applies and checks exact migrations, rejects rerun, and supports real synthetic registration', async () => {
  const result = run('success')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Committed: base schema/)
  for (const step of ['001 owner foundation','002 gc-sub consent','003 auth v2','004 registration v2','005 fresh sub evidence']) {
    assert.match(result.stdout, new RegExp(`Committed: ${step}`)); assert.match(result.stdout, new RegExp(`Verified: ${step}`))
  }
  const c = await connect('success')
  for (const table of ['users','subcontractors','cois','user_phones','auth_v2_accounts','auth_v2_sessions','gc_sub_profiles','gc_sub_fresh_profile_evidence']) {
    assert.equal(Number((await c.query(`SELECT count(*) FROM public.${table}`)).rows[0].count), 0, table)
  }
  for (const ledger of ['owner_foundation_schema_migrations','gc_sub_schema_migrations','auth_v2_schema_migrations','registration_v2_schema_migrations','fresh_sub_profile_schema_migrations']) {
    const r = await c.query(`SELECT version,checksum FROM public.${ledger}`); assert.equal(r.rowCount, 1); assert.equal(r.rows[0].version, 1); assert.match(r.rows[0].checksum, /^[0-9a-f]{64}$/)
  }
  for (const absent of ['self_reported_coi_metadata','self_reported_private_files','private_certificate_metadata','report_v1_projects','companies']) {
    assert.equal((await c.query('SELECT to_regclass($1) AS name', [`public.${absent}`])).rows[0].name, null)
  }
  await c.end()
  assert.notEqual(run('success').status, 0, 'rerun must refuse a nonempty schema')
  const pool = new pg.Pool({ ...common, database: 'pilot_connection_success', user: 'pilot_owner', options: '-c search_path=public,pg_catalog' })
  let token = ''
  const app = express(); app.use(createV2Registration(pool, { delivery: { async sendVerification(input) { token = input.token } }, rateLimiter: { async allow() { return true } } }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/register/request', { email: 'pilot@example.test' })).status, 202); assert.ok(token)
    assert.equal((await post('/register/confirm', { token, role: 'sub', password: 'Synthetic-password-123', first_name: 'Test', last_name: 'Person', phone: '415-555-2671', company_name: 'Synthetic', trade: 'Testing' })).status, 200)
    assert.equal(Number((await pool.query('SELECT count(*) FROM gc_sub_fresh_profile_evidence')).rows[0].count), 1)
    assert.equal(Number((await pool.query('SELECT count(*) FROM user_phones')).rows[0].count), 1)
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await pool.end() }
})
