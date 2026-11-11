import { createHash } from 'node:crypto'
import type pg from 'pg'

// Offline-only. Independent namespace: no backfill, legacy project joins, or startup hook.
const ddl = [
  `CREATE TABLE report_v1_projects (
    id UUID PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    enabled BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE TABLE report_v1_members (
    project_id UUID NOT NULL REFERENCES report_v1_projects(id),
    source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
    label TEXT NOT NULL DEFAULT ('Member-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')) CHECK (label ~ '^Member-[0-9a-f]{32}$'),
    status TEXT NOT NULL CHECK (status IN ('compliant','noncompliant','pending','unknown')),
    PRIMARY KEY(project_id, source_ref), UNIQUE(project_id, label)
  )`,
  `CREATE TABLE report_v1_capabilities (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
    project_id UUID NOT NULL REFERENCES report_v1_projects(id),
    scope TEXT NOT NULL CHECK (scope='anonymous-report:v1'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
  )`,
  `CREATE INDEX report_v1_capabilities_project_idx ON report_v1_capabilities(project_id)`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')

/** Call only on an exclusive idle PostgreSQL session after an approved offline review. */
export async function migrateAnonymousReportsV1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 6)')
    await client.query(`CREATE TABLE IF NOT EXISTS report_v1_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`)
    const history = await client.query('SELECT version,checksum FROM report_v1_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed report migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO report_v1_schema_migrations(version,checksum) VALUES(1,$1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (err) {
    try { await client.query('ROLLBACK') } catch { /* caller must discard connection */ }
    throw err
  }
}
