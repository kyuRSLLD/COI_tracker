import { createHash } from 'node:crypto'
import type pg from 'pg'

// Independent, manual migration. No backfill, legacy COI references, or startup wiring.
const ddl = [
  `CREATE FUNCTION self_reported_coi_valid_coverage(value JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE item JSONB; amount NUMERIC; label TEXT; labels TEXT[] := ARRAY[]::TEXT[];
    BEGIN
      IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 12 THEN RETURN false; END IF;
      FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        IF (SELECT count(*) FROM jsonb_object_keys(item)) <> 2 OR NOT (item ? 'type') OR NOT (item ? 'limitCents')
          OR jsonb_typeof(item->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'limitCents') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        label := item->>'type'; amount := (item->>'limitCents')::numeric;
        IF length(label) NOT BETWEEN 1 AND 100 OR label <> btrim(label) OR label ~ '[[:cntrl:]]'
          OR lower(label)=ANY(labels) OR amount<0 OR amount>1000000000000 OR amount<>trunc(amount) THEN RETURN false; END IF;
        labels := array_append(labels,lower(label));
      END LOOP;
      RETURN true;
    END $$`,
  `CREATE TABLE self_reported_coi_metadata (
    id UUID PRIMARY KEY,
    profile_id UUID NOT NULL REFERENCES gc_sub_fresh_profile_evidence(profile_id),
    carrier TEXT NOT NULL CHECK (length(btrim(carrier)) BETWEEN 1 AND 200),
    effective_date DATE NOT NULL,
    expiration_date DATE NOT NULL CHECK (expiration_date >= effective_date),
    coverage JSONB NOT NULL CHECK (self_reported_coi_valid_coverage(coverage)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(id,profile_id)
  )`,
  `CREATE FUNCTION self_reported_coi_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'self-reported metadata is immutable'; END $$`,
  `CREATE TRIGGER self_reported_coi_immutable_guard BEFORE UPDATE OR DELETE ON self_reported_coi_metadata FOR EACH ROW EXECUTE FUNCTION self_reported_coi_immutable()`,
  `CREATE TABLE self_reported_coi_grants (
    id UUID PRIMARY KEY,
    coi_id UUID NOT NULL,
    profile_id UUID NOT NULL,
    gc_user_id TEXT NOT NULL,
    consent_version TEXT NOT NULL CHECK (consent_version='share-one-self-reported-coi-metadata-v1'),
    consented_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (coi_id,profile_id) REFERENCES self_reported_coi_metadata(id,profile_id),
    FOREIGN KEY (profile_id,gc_user_id) REFERENCES gc_sub_grants(profile_id,gc_user_id)
  )`,
  `CREATE UNIQUE INDEX self_reported_coi_one_active_grant ON self_reported_coi_grants(coi_id,gc_user_id) WHERE revoked_at IS NULL`,
  `CREATE INDEX self_reported_coi_grants_gc ON self_reported_coi_grants(gc_user_id,profile_id) WHERE revoked_at IS NULL`,
  `CREATE FUNCTION self_reported_coi_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
      (NEW.id,NEW.coi_id,NEW.profile_id,NEW.gc_user_id,NEW.consent_version,NEW.consented_at) IS DISTINCT FROM
      (OLD.id,OLD.coi_id,OLD.profile_id,OLD.gc_user_id,OLD.consent_version,OLD.consented_at)
    THEN RAISE EXCEPTION 'grant history is immutable'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_coi_grant_immutable BEFORE UPDATE OR DELETE ON self_reported_coi_grants FOR EACH ROW EXECUTE FUNCTION self_reported_coi_grant_guard()`,
  // Every disconnect or replacement connection irrevocably ends all child grants.
  `CREATE FUNCTION self_reported_coi_connection_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.revoked_at IS NOT NULL OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.consent_version IS DISTINCT FROM OLD.consent_version OR NEW.consented_at IS DISTINCT FROM OLD.consented_at THEN
      UPDATE self_reported_coi_grants SET revoked_at=clock_timestamp() WHERE profile_id=OLD.profile_id AND gc_user_id=OLD.gc_user_id AND revoked_at IS NULL;
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_coi_connection_revoke AFTER UPDATE ON gc_sub_grants FOR EACH ROW EXECUTE FUNCTION self_reported_coi_connection_revoke()`,
  `CREATE FUNCTION self_reported_coi_profile_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      UPDATE self_reported_coi_grants SET revoked_at=clock_timestamp() WHERE profile_id=OLD.id AND revoked_at IS NULL;
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_coi_profile_revoke AFTER UPDATE OF revoked_at ON gc_sub_profiles FOR EACH ROW EXECUTE FUNCTION self_reported_coi_profile_revoke()`,
  `CREATE FUNCTION self_reported_coi_account_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' OR (OLD.enabled AND OLD.email_verified_at IS NOT NULL AND (NOT NEW.enabled OR NEW.email_verified_at IS NULL)) THEN
      UPDATE self_reported_coi_grants SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL AND
        (gc_user_id=OLD.user_id OR profile_id IN (SELECT id FROM gc_sub_profiles WHERE sub_user_id=OLD.user_id));
    END IF; IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER self_reported_coi_account_revoke AFTER UPDATE OF enabled,email_verified_at OR DELETE ON auth_v2_accounts FOR EACH ROW EXECUTE FUNCTION self_reported_coi_account_revoke()`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')
// Pin precisely the prerequisite DDL histories reviewed for this migration.
const prerequisites = [
  ['gc_sub_schema_migrations','6cfeb2f960a43dfc7da3e4266a69270d3c23b5acf805cc113e91801d5e73a646'],
  ['auth_v2_schema_migrations','69aed48abf52127b4d5e85aa0b2253dd8f7d1da17093cb1532c062ad2e5c6b37'],
  ['registration_v2_schema_migrations','54e7d358f81fc9a9cb3ba77d3de8c80ae25453bc7c8a2b30a811ed672ab52efc'],
  ['fresh_sub_profile_schema_migrations','15c6578e90c101aae04acbe46d838bc17788266d36a1496eec9b76340fbc1bba'],
] as const

/** Explicit offline call on an exclusive idle PostgreSQL session; never auto-runs. */
export async function migrateSelfReportedCoiMetadataV1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    // Independent from the anonymous-reports 006 migration advisory lock.
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 7)')
    for (const [ledger, expected] of prerequisites) {
      const r = await client.query(`SELECT version,checksum FROM ${ledger} ORDER BY version`)
      if (r.rowCount !== 1 || r.rows[0].version !== 1 || r.rows[0].checksum !== expected) throw new Error('Missing or unknown prerequisite migration history')
    }
    await client.query(`CREATE TABLE IF NOT EXISTS self_reported_coi_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`)
    const history = await client.query('SELECT version,checksum FROM self_reported_coi_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed metadata migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const statement of ddl) await client.query(statement)
    await client.query('INSERT INTO self_reported_coi_schema_migrations(version,checksum) VALUES(1,$1)', [checksum])
    await client.query('COMMIT'); return 'applied'
  } catch (error) { try { await client.query('ROLLBACK') } catch {} throw error }
}
