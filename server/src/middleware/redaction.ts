/**
 * CLIENT PRIVACY FILTER — CRITICAL REQUIREMENT
 *
 * When General Contractors share a project's compliance view with Clients,
 * clients MUST NOT receive the information needed to directly connect with
 * the subcontractor. This protects the GC's business relationship.
 *
 * ALLOWED for client view:
 *   - company_name
 *   - trade
 *   - verified COI policies & coverages (type, limits, policy #, dates, additional insured, waiver of subrogation)
 *   - compliance status badge
 *   - last verified date
 *
 * STRICTLY REDACTED (null/omitted from API response):
 *   - phone
 *   - email
 *   - contact_person
 *   - address
 *   - internal notes
 *   - direct upload links or sub IDs used for contact
 */

export interface RawSubcontractor {
  id: string
  company_name: string
  trade: string
  phone?: string | null
  email?: string | null
  contact_person?: string | null
  address?: string | null
  notes?: string | null
  status?: string | null
  [key: string]: any
}

export function redactSubcontractorForClient(sub: RawSubcontractor) {
  return {
    id: sub.id,
    company_name: sub.company_name,
    trade: sub.trade,
    status: sub.status,
    phone: null,
    email: null,
    contact_person: null,
    address: null,
    notes: null,
  }
}
