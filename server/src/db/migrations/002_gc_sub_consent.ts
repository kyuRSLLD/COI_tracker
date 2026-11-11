import { createHash } from 'node:crypto'
import type pg from 'pg'

// Independent, immutable PostgreSQL-only migration. No bootstrap or route imports it.
const ddl = [
  `CREATE UNIQUE INDEX gc_sub_cois_id_sub_uq ON cois(id, subcontractor_id)`,
  `CREATE TABLE gc_sub_profiles (
    id UUID PRIMARY KEY,
    subcontractor_id TEXT NOT NULL UNIQUE REFERENCES subcontractors(id),
    sub_user_id TEXT NOT NULL REFERENCES users(id),
    verified_at TIMESTAMPTZ NOT NULL,
    verification_reference TEXT NOT NULL CHECK (length(trim(verification_reference)) > 0),
    revoked_at TIMESTAMPTZ,
    UNIQUE (id, subcontractor_id)
  )`,
  `CREATE FUNCTION gc_sub_profile_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.subcontractor_id IS DISTINCT FROM OLD.subcontractor_id
        OR NEW.sub_user_id IS DISTINCT FROM OLD.sub_user_id THEN
        RAISE EXCEPTION 'profile identity is immutable';
      END IF;
      IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'profile suspension is irreversible';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER gc_sub_profile_identity_guard BEFORE UPDATE ON gc_sub_profiles
    FOR EACH ROW EXECUTE FUNCTION gc_sub_profile_identity_immutable()`,
  `CREATE TABLE gc_sub_coi_ownership (
    coi_id TEXT PRIMARY KEY,
    profile_id UUID NOT NULL,
    subcontractor_id TEXT NOT NULL,
    verified_at TIMESTAMPTZ NOT NULL,
    verification_reference TEXT NOT NULL CHECK (length(trim(verification_reference)) > 0),
    FOREIGN KEY (coi_id, subcontractor_id) REFERENCES cois(id, subcontractor_id),
    FOREIGN KEY (profile_id, subcontractor_id) REFERENCES gc_sub_profiles(id, subcontractor_id)
  )`,
  `CREATE INDEX gc_sub_coi_ownership_profile_idx ON gc_sub_coi_ownership(profile_id)`,
  `CREATE TABLE gc_sub_grants (
    profile_id UUID NOT NULL REFERENCES gc_sub_profiles(id),
    gc_user_id TEXT NOT NULL REFERENCES users(id),
    consent_version TEXT NOT NULL,
    consented_at TIMESTAMPTZ NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (profile_id, gc_user_id)
  )`,
  `CREATE INDEX gc_sub_grants_gc_idx ON gc_sub_grants(gc_user_id) WHERE revoked_at IS NULL`,
  `CREATE TABLE gc_sub_capabilities (
    token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    kind TEXT NOT NULL CHECK (kind IN ('qr', 'invite')),
    profile_id UUID NOT NULL REFERENCES gc_sub_profiles(id),
    gc_user_id TEXT REFERENCES users(id),
    consent_version TEXT,
    consented_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK ((kind = 'qr' AND gc_user_id IS NULL AND consent_version IS NOT NULL AND consented_at IS NOT NULL)
       OR (kind = 'invite' AND gc_user_id IS NOT NULL AND consent_version IS NULL AND consented_at IS NULL))
  )`,
  `CREATE INDEX gc_sub_capabilities_profile_idx ON gc_sub_capabilities(profile_id)`,
  `CREATE TABLE gc_sub_grant_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES gc_sub_profiles(id),
    gc_user_id TEXT NOT NULL REFERENCES users(id),
    sub_user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('granted_qr', 'granted_invite', 'revoked', 'revoked_role')),
    consent_version TEXT,
    consented_at TIMESTAMPTZ,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE FUNCTION gc_sub_invalidate_changed_role() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.role IS NOT DISTINCT FROM NEW.role THEN RETURN NEW; END IF;
      UPDATE gc_sub_capabilities cap SET invalidated_at=clock_timestamp()
        WHERE cap.used_at IS NULL AND cap.invalidated_at IS NULL AND
        ((OLD.role = 'gc' AND cap.kind = 'invite' AND cap.gc_user_id = OLD.id)
          OR (OLD.role = 'sub' AND cap.profile_id IN (SELECT id FROM gc_sub_profiles WHERE sub_user_id=OLD.id)));
      WITH revoked AS (
        UPDATE gc_sub_grants g SET revoked_at=clock_timestamp()
        WHERE g.revoked_at IS NULL AND
          ((OLD.role = 'gc' AND g.gc_user_id=OLD.id)
            OR (OLD.role = 'sub' AND g.profile_id IN (SELECT id FROM gc_sub_profiles WHERE sub_user_id=OLD.id)))
        RETURNING g.profile_id,g.gc_user_id,g.consent_version,g.consented_at
      ) INSERT INTO gc_sub_grant_events(profile_id,gc_user_id,sub_user_id,action,consent_version,consented_at)
        SELECT r.profile_id,r.gc_user_id,p.sub_user_id,'revoked_role',r.consent_version,r.consented_at
        FROM revoked r JOIN gc_sub_profiles p ON p.id=r.profile_id;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER gc_sub_role_change AFTER UPDATE OF role ON users
    FOR EACH ROW EXECUTE FUNCTION gc_sub_invalidate_changed_role()`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')

/** Explicit offline call only; exclusive checked-out PostgreSQL connection, no transaction. */
export async function migrateGcSubConsentV1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 2)')
    await client.query(`CREATE TABLE IF NOT EXISTS gc_sub_schema_migrations (
      version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`)
    const history = await client.query('SELECT version, checksum FROM gc_sub_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed gc-sub migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO gc_sub_schema_migrations(version, checksum) VALUES (1, $1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* retain original error */ }
    throw error
  }
}
