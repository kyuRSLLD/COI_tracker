import { createHash } from 'node:crypto'
import type { OwnerConnection } from '../ownerConnection.ts'

// Version 1 is immutable once applied. Existing rows intentionally receive no mappings.
const statements = [
  // SQLite requires an exact unique parent key for the composite foreign key.
  `CREATE UNIQUE INDEX owner_foundation_cois_id_sub_uq ON cois(id, subcontractor_id)`,
  `CREATE TABLE owner_subcontractor_connections (
    subcontractor_id TEXT NOT NULL PRIMARY KEY REFERENCES subcontractors(id),
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    assigned_at TEXT NOT NULL,
    UNIQUE (owner_user_id, subcontractor_id)
  )`,
  `CREATE INDEX owner_subcontractor_connections_owner_idx ON owner_subcontractor_connections(owner_user_id)`,
  `CREATE TABLE owner_coi_records (
    coi_id TEXT NOT NULL PRIMARY KEY,
    subcontractor_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    FOREIGN KEY (coi_id, subcontractor_id) REFERENCES cois(id, subcontractor_id),
    FOREIGN KEY (owner_user_id, subcontractor_id)
      REFERENCES owner_subcontractor_connections(owner_user_id, subcontractor_id)
  )`,
  `CREATE INDEX owner_coi_records_owner_sub_idx ON owner_coi_records(owner_user_id, subcontractor_id)`,
] as const

const VERSION = 1
const checksum = createHash('sha256').update(statements.join('\n')).digest('hex')

/**
 * Manually invoked only on a dedicated connection with no open transaction.
 * Caller enables SQLite foreign_keys on this connection before invoking.
 * PostgreSQL is serialized by a transaction-scoped advisory lock; SQLite uses
 * BEGIN IMMEDIATE. Any error rolls back both schema and version record.
 */
export async function migrateOwnerFoundationV1(db: OwnerConnection): Promise<'applied' | 'already-applied'> {
  if (db.dialect === 'sqlite') {
    const state = await db.query<{ foreign_keys: number }>('PRAGMA foreign_keys')
    if (state[0]?.foreign_keys !== 1) throw new Error('SQLite foreign_keys must be enabled on the migration connection')
  }
  await db.query(db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    if (db.dialect === 'postgres') await db.query('SELECT pg_advisory_xact_lock(1129273683, 1)')
    await db.query(`CREATE TABLE IF NOT EXISTS owner_foundation_schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`)
    const history = await db.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM owner_foundation_schema_migrations ORDER BY version'
    )
    for (const entry of history) {
      if (entry.version !== VERSION || entry.checksum !== checksum) {
        throw new Error('Owner foundation migration history is unknown or has changed; refusing to proceed')
      }
    }
    if (history.length) {
      await db.query('COMMIT')
      return 'already-applied'
    }
    for (const sql of statements) await db.query(sql)
    await db.query('INSERT INTO owner_foundation_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
      [VERSION, checksum, new Date().toISOString()])
    await db.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await db.query('ROLLBACK') } catch { /* Preserve the original error. */ }
    throw error
  }
}
