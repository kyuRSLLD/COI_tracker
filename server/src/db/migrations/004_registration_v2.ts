import { createHash } from 'node:crypto'
import type pg from 'pg'

// Explicit offline migration only. Dirty or colliding legacy email values deliberately
// fail migration: JS trims Unicode whitespace and folds Unicode differently from SQL.
// Restricting stored identifiers to printable ASCII removes that ambiguity, and C
// collation ensures stable ASCII case folding for every writer (including legacy).
const ddl = [
  `ALTER TABLE users ADD CONSTRAINT auth_v2_users_unambiguous_email CHECK (email IS NOT NULL AND (email COLLATE "C") ~ '^[!-~]+$')`,
  `CREATE UNIQUE INDEX auth_v2_users_normalized_email_uq ON users (lower(email COLLATE "C"))`,
  `CREATE TABLE auth_v2_registration_challenges (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
    email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    delivered_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
  )`,
  `CREATE INDEX auth_v2_registration_expiry_idx ON auth_v2_registration_challenges(expires_at)`,
  `CREATE TABLE auth_v2_sub_profiles (
    id UUID PRIMARY KEY,
    subcontractor_id TEXT NOT NULL UNIQUE REFERENCES subcontractors(id),
    sub_user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    email_verified_at TIMESTAMPTZ NOT NULL,
    verification_reference TEXT NOT NULL CHECK (verification_reference LIKE 'email-control-only:%')
  )`,
  `CREATE FUNCTION auth_v2_sub_profile_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'email-control profile is immutable'; END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER auth_v2_sub_profile_identity_guard BEFORE UPDATE ON auth_v2_sub_profiles
    FOR EACH ROW EXECUTE FUNCTION auth_v2_sub_profile_immutable()`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')

/** Call manually on a dedicated session without an active transaction. */
export async function migrateRegistrationV2V1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 4)')
    await client.query(`CREATE TABLE IF NOT EXISTS registration_v2_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`)
    const history = await client.query('SELECT version, checksum FROM registration_v2_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed registration v2 migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const statement of ddl) await client.query(statement)
    await client.query('INSERT INTO registration_v2_schema_migrations(version,checksum) VALUES(1,$1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* retain original error */ }
    throw error
  }
}
