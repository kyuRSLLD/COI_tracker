// Test-only fixtures, never a historical migration or production provisioning workflow.
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { migrateRegistrationV2V1 } from '../src/db/migrations/004_registration_v2.ts'
import { migrateFreshSubProfileEvidenceV1 } from '../src/db/migrations/005_fresh_sub_profile_evidence.ts'

export async function migrateFreshFixture(c: pg.PoolClient) {
  const columns = await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='email'")
  if (!columns.rowCount) await c.query("ALTER TABLE users ADD COLUMN email text DEFAULT (gen_random_uuid()::text||'@example.test')")
  await c.query("UPDATE users SET email=id||'@example.test' WHERE email IS NULL")
  await migrateRegistrationV2V1(c)
  await migrateFreshSubProfileEvidenceV1(c)
}

/** Only for freshly created, explicitly synthetic test rows, never actual or unknown profiles. */
export async function addFreshFixtureEvidence(pool: pg.Pool, profile: string) {
  const p = (await pool.query('SELECT * FROM gc_sub_profiles WHERE id=$1', [profile])).rows[0]
  if (!p || !p.verification_reference.startsWith('email-control-only:')) throw new Error('Synthetic fixture must explicitly use email-control evidence')
  await pool.query(`INSERT INTO auth_v2_sub_profiles(id,subcontractor_id,sub_user_id,email_verified_at,verification_reference)
    VALUES($1,$2,$3,clock_timestamp(),$4)`, [p.id,p.subcontractor_id,p.sub_user_id,p.verification_reference])
  await pool.query(`INSERT INTO gc_sub_fresh_profile_evidence(profile_id,subcontractor_id,sub_user_id,evidence_type,verification_reference,registration_challenge_hash)
    VALUES($1,$2,$3,'fresh_self_asserted_email_control_v1',$4,$5)`, [p.id,p.subcontractor_id,p.sub_user_id,p.verification_reference,randomBytes(32)])
}
