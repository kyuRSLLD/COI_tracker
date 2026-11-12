// Manual, one-shot provisioner for a NEW, isolated, local connection-only pilot.
// Never import into application startup. No URL, remote host, resume or seed mode.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pg from 'pg'
import { postgresOwnerConnection } from '../server/src/db/ownerConnection.ts'
import { migrateOwnerFoundationV1 } from '../server/src/db/migrations/001_owner_foundation.ts'
import { migrateGcSubConsentV1 } from '../server/src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../server/src/db/migrations/003_auth_v2.ts'
import { migrateRegistrationV2V1 } from '../server/src/db/migrations/004_registration_v2.ts'
import { migrateFreshSubProfileEvidenceV1 } from '../server/src/db/migrations/005_fresh_sub_profile_evidence.ts'

const refuse = (message: string): never => { throw new Error(message) }
// Exact source pins catch accidental changes before any connection/write. This
// is not a security boundary against untrusted local code or files.
const sources: Array<[string, string]> = [
  ['001_owner_foundation.ts', 'ea25ab6377d26927ee1b982eaa42d30414f22d59842fe2ed74652e3d17dee062'],
  ['002_gc_sub_consent.ts', '0f3667383ef215747570fa57e4eaed68ed1d30bf6c2aa934f082d0970ff5cc5e'],
  ['003_auth_v2.ts', 'f0955a06103df71599a08fc50aa6ce1f075b9b7e725ea07758583071be3f894f'],
  ['004_registration_v2.ts', 'e7c32eaac6d2f47a3f9dcad1448757b2df59eef5ec59bc80cd2acf1c8352ea7f'],
  ['005_fresh_sub_profile_evidence.ts', 'e33ae0cc53e6e9a2d14b11a44551d8e1a4d58651fcfa55888950c5c21c4fbd1d'],
]
function verifySources() {
  for (const [name, expected] of sources) {
    const contents = readFileSync(resolve(dirname(process.argv[1]), '../server/src/db/migrations', name))
    if (createHash('sha256').update(contents).digest('hex') !== expected) refuse('Migration source differs from reviewed pilot version')
  }
}
function configuration() {
  if (process.argv.length !== 2) refuse('This tool accepts no arguments')
  if (process.env.PILOT_ALLOW !== 'I_UNDERSTAND_DISPOSABLE_CONNECTION_ONLY') refuse('Explicit pilot authorization required')
  if (process.env.NODE_ENV?.toLowerCase() === 'production') refuse('Production environment refused')
  const allowedDbKeys = new Set(['PILOT_DB_NAME', 'PILOT_DB_USER', 'PILOT_DB_PASSWORD', 'PILOT_DB_PORT'])
  if (process.env.DATABASE_URL !== undefined || Object.keys(process.env).some(k => /^PG/i.test(k) || /^SECURE_V2_DB_/i.test(k) || (/^PILOT_DB_/i.test(k) && !allowedDbKeys.has(k)))) refuse('Inherited database configuration refused')
  const { PILOT_DB_NAME: database, PILOT_CONFIRM_DATABASE: confirmed, PILOT_DB_USER: user, PILOT_DB_PASSWORD: password, PILOT_DB_PORT: port } = process.env
  if (!database || !/^pilot_connection_[a-z0-9_]{1,45}$/.test(database) || database !== confirmed) refuse('Dedicated pilot database name and exact confirmation required')
  if (!user || !/^[a-z_][a-z0-9_]{0,62}$/.test(user)) refuse('Explicit pilot database owner required')
  if (!password || password.length > 512 || /[\x00-\x1f\x7f]/.test(password)) refuse('Explicit pilot database password required')
  if (!port || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) refuse('Explicit local port required')
  return { database, user, password, port: Number(port) }
}

// Matches the four legacy base table definitions used by the mounted v2
// registration and owner services. The broader legacy initializer is unsafe here:
// it creates unrelated tables and backfills companies.
const baseDDL = `
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 name TEXT NOT NULL, first_name TEXT, last_name TEXT, phone TEXT, company_name TEXT,
 role TEXT DEFAULT 'gc', subcontractor_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE subcontractors (
 id TEXT PRIMARY KEY, user_id TEXT, company_name TEXT NOT NULL, trade TEXT NOT NULL,
 contact_person TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT,
 status TEXT DEFAULT 'pending_review', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cois (
 id TEXT PRIMARY KEY, subcontractor_id TEXT NOT NULL, carrier TEXT NOT NULL,
 am_best_rating TEXT, policy_number TEXT, effective_date TEXT NOT NULL, expiration_date TEXT NOT NULL,
 status TEXT DEFAULT 'pending_review', reviewer_notes TEXT, review_date TEXT, certificate_url TEXT,
 certificate_key TEXT, certificate_name TEXT, certificate_size INTEGER, certificate_mime TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE user_phones (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, phone TEXT NOT NULL,
 label TEXT DEFAULT 'mobile', is_primary INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX idx_user_phones_user ON user_phones(user_id);
`

async function preflight(c: pg.Client, config: ReturnType<typeof configuration>) {
  const identity = (await c.query(`SELECT current_database() AS db, current_user AS usr, session_user AS sess,
    inet_server_addr()::text AS server_ip, inet_client_addr()::text AS client_ip,
    inet_server_port() AS port, current_setting('server_version_num')::int AS version,
    current_setting('search_path') AS path,
    d.datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owns_db,
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls AS elevated
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0]
  if (!identity || identity.db !== config.database || identity.usr !== config.user || identity.sess !== config.user ||
      identity.server_ip !== '127.0.0.1/32' || identity.client_ip !== '127.0.0.1/32' || identity.port !== config.port ||
      identity.version < 160000 || identity.version >= 170000 || identity.path !== 'public,pg_catalog' || !identity.owns_db || identity.elevated) {
    refuse('Target identity, version, owner, role, address or search path did not match')
  }
  const lock = await c.query('SELECT pg_try_advisory_lock(1129273683, 16100) AS acquired')
  if (!lock.rows[0]?.acquired) refuse('Another pilot provisioner holds the lock')
  const checks = (await c.query(`SELECT
    (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_sessions,
    (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%') AS extra_schemas,
    (SELECT count(*) FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_proc x JOIN pg_namespace n ON n.oid=x.pronamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_type x JOIN pg_namespace n ON n.oid=x.typnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_operator x JOIN pg_namespace n ON n.oid=x.oprnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_collation x JOIN pg_namespace n ON n.oid=x.collnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_conversion x JOIN pg_namespace n ON n.oid=x.connamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_opclass x JOIN pg_namespace n ON n.oid=x.opcnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_opfamily x JOIN pg_namespace n ON n.oid=x.opfnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_ts_config x JOIN pg_namespace n ON n.oid=x.cfgnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_ts_dict x JOIN pg_namespace n ON n.oid=x.dictnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_ts_parser x JOIN pg_namespace n ON n.oid=x.prsnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_ts_template x JOIN pg_namespace n ON n.oid=x.tmplnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_statistic_ext x JOIN pg_namespace n ON n.oid=x.stxnamespace WHERE n.nspname='public') AS schema_objects,
    (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') + (SELECT count(*) FROM pg_event_trigger) +
    (SELECT count(*) FROM pg_publication) + (SELECT count(*) FROM pg_subscription) +
    (SELECT count(*) FROM pg_foreign_server) + (SELECT count(*) FROM pg_foreign_data_wrapper) AS extra_objects,
    (SELECT count(*) FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
       WHERE d.datname=current_database() AND a.privilege_type='CONNECT' AND a.grantee<>d.datdba) AS other_connect_grants,
    (SELECT count(*) FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
       WHERE n.nspname='public' AND a.privilege_type='CREATE' AND a.grantee<>n.nspowner AND a.grantee<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS other_create_grants,
    (SELECT nspowner IN ((SELECT oid FROM pg_roles WHERE rolname=current_user), (SELECT oid FROM pg_roles WHERE rolname='pg_database_owner')) FROM pg_namespace WHERE nspname='public') AS trusted_schema_owner,
    has_schema_privilege(current_user,'public','CREATE') AS can_create`)).rows[0]
  if (['other_sessions','extra_schemas','schema_objects','extra_objects','other_connect_grants','other_create_grants'].some(k => Number(checks[k]) !== 0) || !checks.can_create || !checks.trusted_schema_owner) {
    refuse('Database is not isolated, empty, or exclusively writable')
  }
}

async function main() {
  const config = configuration() // validates before opening any connection
  verifySources()
  const client = new pg.Client({ host: '127.0.0.1', port: config.port, database: config.database, user: config.user,
    password: config.password, ssl: false, options: '-c search_path=public,pg_catalog', application_name: 'connection_pilot_provision',
    connectionTimeoutMillis: 5000, statement_timeout: 30000, lock_timeout: 3000, idle_in_transaction_session_timeout: 30000 })
  let connected = false
  let stage = 'preflight'
  try {
    await client.connect(); connected = true
    await preflight(client, config)
    stage = 'base schema'
    await client.query('BEGIN')
    try { await client.query(baseDDL); await client.query('COMMIT') }
    catch (e) { try { await client.query('ROLLBACK') } catch {} throw e }
    console.log('Committed: base schema')
    const steps: Array<[string, string, string, () => Promise<string>]> = [
      ['001 owner foundation', 'owner_foundation_schema_migrations', '3b6b43de46a994a7accff8428ec86a51e875681cb7147f4039d21f691b7cd1f3', () => migrateOwnerFoundationV1(postgresOwnerConnection(client))],
      ['002 gc-sub consent', 'gc_sub_schema_migrations', '6cfeb2f960a43dfc7da3e4266a69270d3c23b5acf805cc113e91801d5e73a646', () => migrateGcSubConsentV1(client)],
      ['003 auth v2', 'auth_v2_schema_migrations', '69aed48abf52127b4d5e85aa0b2253dd8f7d1da17093cb1532c062ad2e5c6b37', () => migrateAuthV2V1(client)],
      ['004 registration v2', 'registration_v2_schema_migrations', '54e7d358f81fc9a9cb3ba77d3de8c80ae25453bc7c8a2b30a811ed672ab52efc', () => migrateRegistrationV2V1(client)],
      ['005 fresh sub evidence', 'fresh_sub_profile_schema_migrations', '15c6578e90c101aae04acbe46d838bc17788266d36a1496eec9b76340fbc1bba', () => migrateFreshSubProfileEvidenceV1(client)],
    ]
    for (const [name, ledger, expected, migrate] of steps) {
      stage = name
      if (await migrate() !== 'applied') refuse('Unexpected existing migration')
      console.log(`Committed: ${name}`)
      if (await migrate() !== 'already-applied') refuse('Migration checksum verification failed')
      const history = await client.query(`SELECT version,checksum FROM public.${ledger}`)
      if (history.rowCount !== 1 || history.rows[0].version !== 1 || history.rows[0].checksum !== expected) refuse('Unexpected migration ledger')
      console.log(`Verified: ${name}`)
    }
    console.log('Pilot schema provisioned; no users or seed data created.')
  } catch (error) {
    // Do not expose raw database errors or credentials. A lost connection can make
    // even a COMMIT/ROLLBACK outcome ambiguous. Never automatically retry.
    console.error(`Pilot provision stopped at ${stage}. Do not retry; discard the isolated database after inspecting the outcome.`)
    if (stage === 'preflight' && error instanceof Error && /^(This tool|Explicit|Production|Inherited|Dedicated|Target|Another|Database is)/.test(error.message)) console.error(error.message)
    process.exitCode = 1
  } finally { if (connected) await client.end().catch(() => { process.exitCode = 1 }) }
}
main().catch(() => { console.error('Pilot provision refused before connection.'); process.exitCode = 1 })
