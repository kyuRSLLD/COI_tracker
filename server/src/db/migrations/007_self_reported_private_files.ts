import { createHash } from 'node:crypto'
import type pg from 'pg'

// Standalone forward migration; never imported by an app bootstrap.
const ddl = [
  `CREATE TABLE self_reported_private_files (
    id UUID PRIMARY KEY, coi_id UUID NOT NULL, profile_id UUID NOT NULL,
    storage_key TEXT NOT NULL UNIQUE CHECK (storage_key ~ '^private-coi/[0-9a-f]{64}$'),
    mime TEXT NOT NULL CHECK (mime IN ('application/pdf','image/jpeg','image/png','image/webp')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','orphan','ready')),
    storage_version TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((state='ready' AND storage_version IS NOT NULL AND length(storage_version) BETWEEN 1 AND 512) OR (state<>'ready' AND storage_version IS NULL)),
    FOREIGN KEY (coi_id,profile_id) REFERENCES self_reported_coi_metadata(id,profile_id), UNIQUE(id,profile_id)
  )`,
  `CREATE INDEX self_reported_private_files_reconcile ON self_reported_private_files(created_at) WHERE state IN ('pending','orphan')`,
  `CREATE FUNCTION self_reported_private_file_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR OLD.state<>'pending' OR NEW.state NOT IN ('ready','orphan') OR
      (NEW.id,NEW.coi_id,NEW.profile_id,NEW.storage_key,NEW.mime,NEW.size_bytes,NEW.sha256,NEW.created_at) IS DISTINCT FROM
      (OLD.id,OLD.coi_id,OLD.profile_id,OLD.storage_key,OLD.mime,OLD.size_bytes,OLD.sha256,OLD.created_at)
    THEN RAISE EXCEPTION 'immutable file'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_immutable BEFORE UPDATE OR DELETE ON self_reported_private_files FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_guard()`,
  `CREATE TABLE self_reported_private_file_grants (
    id UUID PRIMARY KEY, file_id UUID NOT NULL, profile_id UUID NOT NULL, gc_user_id TEXT NOT NULL,
    consent_version TEXT NOT NULL CHECK (consent_version='share-one-private-coi-file-v1'),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revoked_at TIMESTAMPTZ,
    FOREIGN KEY(file_id,profile_id) REFERENCES self_reported_private_files(id,profile_id),
    FOREIGN KEY(profile_id,gc_user_id) REFERENCES gc_sub_grants(profile_id,gc_user_id)
  )`,
  `CREATE UNIQUE INDEX self_reported_private_file_one_grant ON self_reported_private_file_grants(file_id,gc_user_id) WHERE revoked_at IS NULL`,
  `CREATE INDEX self_reported_private_file_grants_parent ON self_reported_private_file_grants(profile_id,gc_user_id) WHERE revoked_at IS NULL`,
  `CREATE TABLE self_reported_private_file_grant_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, grant_id UUID NOT NULL REFERENCES self_reported_private_file_grants(id),
    action TEXT NOT NULL CHECK (action IN ('granted','revoked')), occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`,
  `CREATE FUNCTION self_reported_private_file_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable event'; END $$`,
  `CREATE TRIGGER self_reported_private_file_event_guard BEFORE UPDATE OR DELETE ON self_reported_private_file_grant_events FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_event_immutable()`,
  `CREATE FUNCTION self_reported_private_file_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
      (NEW.id,NEW.file_id,NEW.profile_id,NEW.gc_user_id,NEW.consent_version,NEW.consented_at) IS DISTINCT FROM
      (OLD.id,OLD.file_id,OLD.profile_id,OLD.gc_user_id,OLD.consent_version,OLD.consented_at)
    THEN RAISE EXCEPTION 'immutable grant'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_grant_immutable BEFORE UPDATE OR DELETE ON self_reported_private_file_grants FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_grant_guard()`,
  `CREATE FUNCTION self_reported_private_file_grant_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO self_reported_private_file_grant_events(grant_id,action) VALUES(NEW.id, CASE WHEN TG_OP='INSERT' THEN 'granted' ELSE 'revoked' END); RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_grant_event AFTER INSERT OR UPDATE ON self_reported_private_file_grants FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_grant_event()`,
  `CREATE FUNCTION self_reported_private_file_parent_end() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.consented_at IS DISTINCT FROM OLD.consented_at OR NEW.consent_version IS DISTINCT FROM OLD.consent_version THEN
      UPDATE self_reported_private_file_grants SET revoked_at=clock_timestamp() WHERE profile_id=OLD.profile_id AND gc_user_id=OLD.gc_user_id AND revoked_at IS NULL;
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_parent_end AFTER UPDATE ON gc_sub_grants FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_parent_end()`,
  `CREATE FUNCTION self_reported_private_file_profile_end() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN UPDATE self_reported_private_file_grants SET revoked_at=clock_timestamp() WHERE profile_id=OLD.id AND revoked_at IS NULL; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_profile_end AFTER UPDATE OF revoked_at ON gc_sub_profiles FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_profile_end()`,
  `CREATE FUNCTION self_reported_private_file_account_end() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR (OLD.enabled AND OLD.email_verified_at IS NOT NULL AND (NOT NEW.enabled OR NEW.email_verified_at IS NULL)) THEN
      UPDATE self_reported_private_file_grants SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND (gc_user_id=OLD.user_id OR profile_id IN (SELECT id FROM gc_sub_profiles WHERE sub_user_id=OLD.user_id));
    END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_private_file_account_end AFTER UPDATE OF enabled,email_verified_at OR DELETE ON auth_v2_accounts FOR EACH ROW EXECUTE FUNCTION self_reported_private_file_account_end()`
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')
const prerequisites = [
  ['gc_sub_schema_migrations','6cfeb2f960a43dfc7da3e4266a69270d3c23b5acf805cc113e91801d5e73a646'],
  ['auth_v2_schema_migrations','69aed48abf52127b4d5e85aa0b2253dd8f7d1da17093cb1532c062ad2e5c6b37'],
  ['registration_v2_schema_migrations','54e7d358f81fc9a9cb3ba77d3de8c80ae25453bc7c8a2b30a811ed672ab52efc'],
  ['fresh_sub_profile_schema_migrations','15c6578e90c101aae04acbe46d838bc17788266d36a1496eec9b76340fbc1bba'],
  ['self_reported_coi_schema_migrations','d1f39e09e5f9e718154ed344e52535916c281caa52c9b0c1c93e22d6c0be8567']
] as const

/** Explicitly invoked on an idle exclusive PostgreSQL session, after the metadata migration. */
export async function migrateSelfReportedPrivateFilesV1(client: pg.Client | pg.PoolClient): Promise<'applied'|'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683,7)')
    for (const [ledger, expected] of prerequisites) {
      const prereq = await client.query(`SELECT version,checksum FROM ${ledger} ORDER BY version`)
      if (prereq.rowCount !== 1 || prereq.rows[0].version !== 1 || prereq.rows[0].checksum !== expected) throw new Error('Missing or unknown prerequisite migration')
    }
    await client.query('CREATE TABLE IF NOT EXISTS self_reported_private_file_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())')
    const history = await client.query('SELECT version,checksum FROM self_reported_private_file_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown private file migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO self_reported_private_file_schema_migrations(version,checksum) VALUES(1,$1)',[checksum])
    await client.query('COMMIT'); return 'applied'
  } catch (e) { try { await client.query('ROLLBACK') } catch {} throw e }
}
