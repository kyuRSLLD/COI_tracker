import { createHash } from 'node:crypto'
import type pg from 'pg'

// Offline, independent migration. It does not classify or backfill any existing row.
const ddl = [
  `CREATE UNIQUE INDEX gc_sub_profile_user_uq ON gc_sub_profiles(sub_user_id)`,
  `CREATE UNIQUE INDEX gc_sub_profile_identity_ref_uq ON gc_sub_profiles(id,subcontractor_id,sub_user_id,verification_reference)`,
  `CREATE UNIQUE INDEX auth_v2_sub_profile_identity_ref_uq ON auth_v2_sub_profiles(id,subcontractor_id,sub_user_id,verification_reference)`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM auth_v2_sub_profiles a JOIN gc_sub_profiles g
      ON a.id=g.id OR a.subcontractor_id=g.subcontractor_id OR a.sub_user_id=g.sub_user_id
      WHERE (a.id,a.subcontractor_id,a.sub_user_id) IS DISTINCT FROM (g.id,g.subcontractor_id,g.sub_user_id))
    THEN RAISE EXCEPTION 'conflicting existing profile identities'; END IF;
  END $$`,
  // Shared locks serialize cross-table checks, including simultaneous inserts.
  `CREATE FUNCTION fresh_sub_profile_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE k text;
    BEGIN
      FOR k IN SELECT v FROM unnest(ARRAY['id:'||NEW.id::text,'sub:'||NEW.subcontractor_id,'user:'||NEW.sub_user_id]) v ORDER BY v LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('fresh-sub-profile:'||k, 0));
      END LOOP;
      IF TG_TABLE_NAME='auth_v2_sub_profiles' THEN
        IF EXISTS (SELECT 1 FROM gc_sub_profiles p WHERE (p.id=NEW.id OR p.subcontractor_id=NEW.subcontractor_id OR p.sub_user_id=NEW.sub_user_id)
          AND (p.id,p.subcontractor_id,p.sub_user_id) IS DISTINCT FROM (NEW.id,NEW.subcontractor_id,NEW.sub_user_id))
        THEN RAISE EXCEPTION 'conflicting profile identity'; END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM auth_v2_sub_profiles p WHERE (p.id=NEW.id OR p.subcontractor_id=NEW.subcontractor_id OR p.sub_user_id=NEW.sub_user_id)
          AND (p.id,p.subcontractor_id,p.sub_user_id) IS DISTINCT FROM (NEW.id,NEW.subcontractor_id,NEW.sub_user_id))
        THEN RAISE EXCEPTION 'conflicting profile identity'; END IF;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER fresh_auth_profile_identity_guard BEFORE INSERT OR UPDATE OF id,subcontractor_id,sub_user_id ON auth_v2_sub_profiles FOR EACH ROW EXECUTE FUNCTION fresh_sub_profile_identity_guard()`,
  `CREATE TRIGGER fresh_gc_profile_identity_guard BEFORE INSERT OR UPDATE OF id,subcontractor_id,sub_user_id ON gc_sub_profiles FOR EACH ROW EXECUTE FUNCTION fresh_sub_profile_identity_guard()`,
  `CREATE TABLE gc_sub_fresh_profile_evidence (
    profile_id UUID PRIMARY KEY,
    subcontractor_id TEXT NOT NULL UNIQUE,
    sub_user_id TEXT NOT NULL UNIQUE,
    evidence_type TEXT NOT NULL CHECK (evidence_type='fresh_self_asserted_email_control_v1'),
    verification_reference TEXT NOT NULL CHECK (verification_reference LIKE 'email-control-only:%'),
    registration_challenge_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(registration_challenge_hash)=32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (profile_id,subcontractor_id,sub_user_id,verification_reference) REFERENCES auth_v2_sub_profiles(id,subcontractor_id,sub_user_id,verification_reference),
    FOREIGN KEY (profile_id,subcontractor_id,sub_user_id,verification_reference) REFERENCES gc_sub_profiles(id,subcontractor_id,sub_user_id,verification_reference)
  )`,
  `CREATE FUNCTION fresh_sub_profile_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fresh profile evidence is immutable'; END $$`,
  `CREATE TRIGGER fresh_sub_profile_evidence_guard BEFORE UPDATE OR DELETE ON gc_sub_fresh_profile_evidence FOR EACH ROW EXECUTE FUNCTION fresh_sub_profile_evidence_immutable()`,
] as const
const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex')

/** Run on an exclusively held idle PostgreSQL session, only after reviewing all prerequisites. */
export async function migrateFreshSubProfileEvidenceV1(client: pg.Client | pg.PoolClient): Promise<'applied' | 'already-applied'> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock(1129273683, 5)')
    for (const ledger of ['gc_sub_schema_migrations', 'auth_v2_schema_migrations', 'registration_v2_schema_migrations']) {
      const r = await client.query(`SELECT version FROM ${ledger} ORDER BY version`)
      if (r.rowCount !== 1 || r.rows[0].version !== 1) throw new Error('Missing or unknown prerequisite migration history')
    }
    await client.query(`CREATE TABLE IF NOT EXISTS fresh_sub_profile_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`)
    const history = await client.query('SELECT version,checksum FROM fresh_sub_profile_schema_migrations ORDER BY version')
    if (history.rows.some(r => r.version !== 1 || r.checksum !== checksum)) throw new Error('Unknown or changed fresh profile migration history')
    if (history.rowCount) { await client.query('COMMIT'); return 'already-applied' }
    for (const sql of ddl) await client.query(sql)
    await client.query('INSERT INTO fresh_sub_profile_schema_migrations(version,checksum) VALUES(1,$1)', [checksum])
    await client.query('COMMIT')
    return 'applied'
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* retain original error */ }
    throw error
  }
}
