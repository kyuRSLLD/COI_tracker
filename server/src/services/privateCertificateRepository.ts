import type pg from 'pg'
import type { CertificateRecordRepository, PrivateCertificateRecord } from './privateCertificateStorage.ts'

// The only supported principal is the verified owner of an explicitly verified sub-COI mapping.
// User/profile/ownership/COI predicates are repeated at metadata insert/read, not inferred from a GC grant.
const ownerExists = `EXISTS (
  SELECT 1 FROM gc_sub_coi_ownership o
  JOIN gc_sub_profiles p ON p.id=o.profile_id AND p.subcontractor_id=o.subcontractor_id AND p.revoked_at IS NULL
  JOIN users u ON u.id=p.sub_user_id AND u.role='sub'
  JOIN cois c ON c.id=o.coi_id AND c.subcontractor_id=o.subcontractor_id
  WHERE o.coi_id=$1 AND u.id=$2
)`

export function privateCertificateRepository(pool: pg.Pool, verifiedSubject: string) {
  async function authorized(certificateId: string): Promise<boolean> {
    const result = await pool.query(`SELECT ${ownerExists} AS allowed`, [certificateId, verifiedSubject])
    return result.rows[0]?.allowed === true
  }
  const records: CertificateRecordRepository = {
    async create(certificateId: string, record: PrivateCertificateRecord) {
      // INSERT ... SELECT repeats the current authorization in the very statement that writes.
      // No upsert: an existing mapping is never replaced.
      const result = await pool.query(`INSERT INTO private_certificate_metadata(coi_id,object_key,mime,byte_size)
        SELECT $1,$3,$4,$5 WHERE ${ownerExists} RETURNING coi_id`,
        [certificateId, verifiedSubject, record.key, record.mime, record.size])
      if (result.rowCount !== 1) throw new Error('Unavailable')
    },
    async get(certificateId: string): Promise<PrivateCertificateRecord | null> {
      const result = await pool.query(`SELECT object_key,mime,byte_size FROM private_certificate_metadata
        WHERE coi_id=$1 AND ${ownerExists}`, [certificateId, verifiedSubject])
      if (!result.rowCount) return null
      const row = result.rows[0]
      return { key: row.object_key, mime: row.mime, size: row.byte_size }
    },
  }
  return { authorized, records }
}
