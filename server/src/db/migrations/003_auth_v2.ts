import { createHash } from 'node:crypto'
import type pg from 'pg'

// Independent ledger; explicitly invoked on a dedicated PostgreSQL session, never at startup.
const ddl = [
  `CREATE TABLE auth_v2_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    login_email TEXT NOT NULL UNIQUE CHECK (login_email = lower(trim(login_email)) AND length(login_email) BETWEEN 3 AND 254),
    password_hash TEXT NOT NULL,
    email_verified_at TIMESTAMPTZ NOT NULL,
    verification_reference TEXT NOT NULL CHECK (length(trim(verification_reference)) > 0),
    enabled BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE TABLE auth_v2_sessions (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
  )`,
  `CREATE INDEX auth_v2_sessions_user_idx ON auth_v2_sessions(user_id) WHERE revoked_at IS NULL`,
  `CREATE FUNCTION auth_v2_revoke_user_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id=OLD.user_id AND revoked_at IS NULL;
        RETURN OLD;
      END IF;
      IF TG_TABLE_NAME = 'users' THEN
        IF OLD.role IS NOT DISTINCT FROM NEW.role AND OLD.password_hash IS NOT DISTINCT FROM NEW.password_hash THEN RETURN NEW; END IF;
        UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id=OLD.id AND revoked_at IS NULL;
      ELSE
        IF OLD.user_id IS NOT DISTINCT FROM NEW.user_id AND OLD.login_email IS NOT DISTINCT FROM NEW.login_email
          AND OLD.password_hash IS NOT DISTINCT FROM NEW.password_hash AND OLD.enabled IS NOT DISTINCT FROM NEW.enabled
          AND OLD.email_verified_at IS NOT DISTINCT FROM NEW.email_verified_at
          AND OLD.verification_reference IS NOT DISTINCT FROM NEW.verification_reference THEN RETURN NEW; END IF;
        UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id=OLD.user_id AND revoked_at IS NULL;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER auth_v2_user_change AFTER UPDATE OF role, password_hash ON users FOR EACH ROW EXECUTE FUNCTION auth_v2_revoke_user_sessions()`,
  `CREATE TRIGGER auth_v2_account_change AFTER UPDATE ON auth_v2_accounts FOR EACH ROW EXECUTE FUNCTION auth_v2_revoke_user_sessions()`,
  `CREATE TRIGGER auth_v2_account_delete AFTER DELETE ON auth_v2_accounts FOR EACH ROW EXECUTE FUNCTION auth_v2_revoke_user_sessions()`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')
export async function migrateAuthV2V1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 3)')
    await client.query(`CREATE TABLE IF NOT EXISTS auth_v2_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`)
    const history = await client.query('SELECT version, checksum FROM auth_v2_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed auth v2 migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO auth_v2_schema_migrations(version,checksum) VALUES(1,$1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* retain original error */ }
    throw error
  }
}
