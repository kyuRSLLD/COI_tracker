import { createHash } from 'node:crypto'
import type pg from 'pg'

// Independent, offline-only migration. No legacy startup import or automatic execution.
const ddl = [
  `CREATE TABLE private_certificate_metadata (
    coi_id TEXT PRIMARY KEY REFERENCES gc_sub_coi_ownership(coi_id),
    object_key TEXT NOT NULL UNIQUE CHECK (object_key ~ '^private-certificates/[0-9a-f]{64}$'),
    mime TEXT NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png','image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE FUNCTION private_certificate_metadata_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private certificate metadata is immutable'; END $$`,
  `CREATE TRIGGER private_certificate_metadata_immutable BEFORE UPDATE OR DELETE ON private_certificate_metadata
    FOR EACH ROW EXECUTE FUNCTION private_certificate_metadata_immutable()`
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')

/** Dedicated idle client with explicit trusted search_path only; never called at startup. */
export async function migratePrivateCertificateMetadataV1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 3)')
    await client.query(`CREATE TABLE IF NOT EXISTS private_certificate_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`)
    const history = await client.query('SELECT version, checksum FROM private_certificate_schema_migrations ORDER BY version')
    if (history.rows.some(row => row.version !== 1 || row.checksum !== checksum)) throw new Error('Unknown or changed private certificate migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO private_certificate_schema_migrations(version, checksum) VALUES (1, $1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* retain original */ }
    throw error
  }
}
