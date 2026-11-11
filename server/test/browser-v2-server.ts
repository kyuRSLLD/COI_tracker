// TEST ONLY: invoked by scripts/test-v2-browser-e2e.sh with a new isolated cluster.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createSecureV2SyntheticTestApp } from '../src/secure-v2-synthetic.ts'
import { postgresOwnerConnection } from '../src/db/ownerConnection.ts'
import { migrateOwnerFoundationV1 } from '../src/db/migrations/001_owner_foundation.ts'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migratePrivateCertificateMetadataV1 } from '../src/db/migrations/003_private_certificate_metadata.ts'
import { migrateRegistrationV2V1 } from '../src/db/migrations/004_registration_v2.ts'
import { migrateFreshSubProfileEvidenceV1 } from '../src/db/migrations/005_fresh_sub_profile_evidence.ts'
import { migrateSelfReportedCoiMetadataV1 } from '../src/db/migrations/006_self_reported_coi_metadata.ts'

const url = process.env.SECURE_V2_TEST_PG_URL
const work = process.env.E2E_WORK
if (process.env.NODE_ENV !== 'test' || !url || !work || !resolve(work).startsWith(resolve('.work') + '/')) throw new Error('Disposable test environment required')
const u = new URL(url)
if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/secure_v2_test_browser' || u.search || u.hash) throw new Error('Disposable loopback database required')
const pool = new pg.Pool({ connectionString: url, max: 8 })
const version = (await pool.query("SELECT current_setting('server_version_num')::int AS v")).rows[0].v
assert.ok(version >= 160000 && version < 170000, 'PostgreSQL 16 required')
await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,name TEXT NOT NULL,first_name TEXT,last_name TEXT,phone TEXT,company_name TEXT,role TEXT NOT NULL,subcontractor_id TEXT,created_at TEXT NOT NULL);
  CREATE TABLE user_phones(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,phone TEXT NOT NULL,label TEXT DEFAULT 'mobile',is_primary INTEGER DEFAULT 0,created_at TEXT NOT NULL);
  CREATE TABLE subcontractors(id TEXT PRIMARY KEY,user_id TEXT,company_name TEXT NOT NULL,trade TEXT NOT NULL,contact_person TEXT,phone TEXT,email TEXT,address TEXT,notes TEXT,status TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
  CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,am_best_rating TEXT,policy_number TEXT,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,reviewer_notes TEXT,certificate_url TEXT,certificate_key TEXT,certificate_name TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`)
const c = await pool.connect()
try {
  assert.equal(await migrateOwnerFoundationV1(postgresOwnerConnection(c)), 'applied')
  assert.equal(await migrateGcSubConsentV1(c), 'applied')
  assert.equal(await migrateAuthV2V1(c), 'applied')
  assert.equal(await migratePrivateCertificateMetadataV1(c), 'applied')
  assert.equal(await migrateRegistrationV2V1(c), 'applied')
  assert.equal(await migrateFreshSubProfileEvidenceV1(c), 'applied')
  assert.equal(await migrateSelfReportedCoiMetadataV1(c), 'applied')
} finally { c.release() }
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const authConfig = { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'browser-synthetic', audience: 'browser-synthetic' }
// The actual SES adapter formats the message. The transport writes only known
// synthetic mailboxes to this runner's private, temporary local directory.
const mockSes = { async send(command: SendEmailCommand) {
  assert.ok(command instanceof SendEmailCommand)
  const email = command.input.Destination?.ToAddresses?.[0]
  const match = /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(command.input.Content?.Simple?.Body?.Text?.Data || '')
  if (!email || !['sub@example.test', 'gc@example.test', 'other@example.test'].includes(email) || !match) throw new Error('Unexpected synthetic delivery')
  await writeFile(join(work, `mail-${email.split('@')[0]}`), match[1], { mode: 0o600 })
  return { MessageId: 'synthetic-only' }
} }
const base = { pool, authConfig, testRateLimit: async () => true, testRegistrationRateLimit: async () => true, unsafeTestOnlyMockSes: mockSes }
const enabled = createSecureV2SyntheticTestApp({ ...base, unsafeTestOnlyEnableConsent: true, unsafeTestOnlyEnableMetadata: true })
const disabled = createSecureV2SyntheticTestApp(base)
const listen = async (app: typeof enabled) => {
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  return server
}
const s1 = await listen(enabled), s2 = await listen(disabled)
await writeFile(join(work, 'ports.json.tmp'), JSON.stringify({ enabled: (s1.address() as AddressInfo).port, disabled: (s2.address() as AddressInfo).port }), { mode: 0o600 })
await rename(join(work, 'ports.json.tmp'), join(work, 'ports.json'))
const stop = async () => {
  await Promise.all([s1, s2].map(s => new Promise<void>(resolve => s.close(() => resolve()))))
  await pool.end()
  process.exit(0)
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
