// Subject-scoped low-level reads. The caller must verify the credential and supply
// its immutable subject ID, never a request parameter or a claimed role. The v2 GC
// router additionally uses the locked, session-checked withOwnerV2Transaction scope.
import type { OwnerConnection } from '../db/ownerConnection.ts'

type SubRow = {
  id: string; company_name: string; trade: string; contact_person: string | null;
  phone: string | null; email: string | null; status: string | null
}
type CoiRow = {
  id: string; subcontractor_id: string; carrier: string; effective_date: string;
  expiration_date: string; status: string | null
}

function requireSubject(subject: string): void {
  if (typeof subject !== 'string' || !subject.trim()) throw new Error('Verified subject required')
}

const subSelect = `SELECT s.id, s.company_name, s.trade, s.contact_person, s.phone, s.email, s.status
  FROM subcontractors s
  JOIN owner_subcontractor_connections sc ON sc.subcontractor_id = s.id
  JOIN users u ON u.id = sc.owner_user_id AND u.role = 'gc'
  WHERE sc.owner_user_id = ?`

const coiSelect = `SELECT c.id, c.subcontractor_id, c.carrier, c.effective_date, c.expiration_date, c.status
  FROM cois c
  JOIN owner_coi_records oc ON oc.coi_id = c.id AND oc.subcontractor_id = c.subcontractor_id
  JOIN owner_subcontractor_connections sc ON sc.subcontractor_id = oc.subcontractor_id AND sc.owner_user_id = oc.owner_user_id
  JOIN users u ON u.id = oc.owner_user_id AND u.role = 'gc'
  WHERE oc.owner_user_id = ?`

/** Each call checks the live role, even if an earlier token claimed GC or admin. */
export function ownerReads(db: OwnerConnection, verifiedSubject: string) {
  requireSubject(verifiedSubject)
  return {
    async listSubcontractors(): Promise<SubRow[]> {
      return db.query<SubRow>(`${subSelect} ORDER BY s.id`, [verifiedSubject])
    },
    async getSubcontractor(id: string): Promise<SubRow | undefined> {
      return (await db.query<SubRow>(`${subSelect} AND s.id = ?`, [verifiedSubject, id]))[0]
    },
    async listCois(subcontractorId: string): Promise<CoiRow[]> {
      return db.query<CoiRow>(`${coiSelect} AND c.subcontractor_id = ? ORDER BY c.id`, [verifiedSubject, subcontractorId])
    },
    async getCoi(id: string): Promise<CoiRow | undefined> {
      return (await db.query<CoiRow>(`${coiSelect} AND c.id = ?`, [verifiedSubject, id]))[0]
    },
  }
}
