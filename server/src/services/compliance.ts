import { parseISO, differenceInCalendarDays, isValid } from 'date-fns'

export type ComplianceStatus =
  | 'compliant'
  | 'expiring_soon'
  | 'expired'
  | 'missing'
  | 'pending_review'
  | 'needs_revision'
  | 'rejected'

export interface COIRecord {
  id?: string
  status?: string
  expiration_date?: string
  [key: string]: any
}

// The former simulation wrote these markers. They do not prove coverage exists.
export function isSimulatedCarrierCOI(coi: COIRecord | null | undefined): boolean {
  return Boolean(coi && (coi.certificate_url === 'carrier-connect://verified' ||
    coi.reviewer_notes === 'Instant verification via simulated carrier connect' ||
    coi.simulated_carrier_connect === true))
}

export function labelSimulatedCarrierCOI<T extends COIRecord>(coi: T): T {
  return isSimulatedCarrierCOI(coi)
    ? { ...coi, status: 'pending_review', simulated_carrier_connect: true }
    : coi
}

export function computeExpirationStatus(expirationDate: string | null | undefined, warningDays = 30): ComplianceStatus {
  if (!expirationDate) return 'missing'
  const exp = parseISO(expirationDate)
  if (!isValid(exp)) return 'missing'
  const days = differenceInCalendarDays(exp, new Date())
  if (days < 0) return 'expired'
  if (days <= warningDays) return 'expiring_soon'
  return 'compliant'
}

export function daysUntil(dateString: string | null | undefined): number | null {
  if (!dateString) return null
  const d = parseISO(dateString)
  if (!isValid(d)) return null
  return differenceInCalendarDays(d, new Date())
}

export function bestCOI(cois: COIRecord[]): COIRecord | null {
  if (!cois || cois.length === 0) return null
  return cois.slice().sort((a, b) => {
    const da = a.expiration_date ? parseISO(a.expiration_date).getTime() : 0
    const db = b.expiration_date ? parseISO(b.expiration_date).getTime() : 0
    return db - da
  })[0]
}

export function computeSubcontractorStatus(sub: any, cois: COIRecord[], warningDays = 30): {
  status: ComplianceStatus
  bestCOI: COIRecord | null
  daysLeft: number | null
} {
  const latest = bestCOI(cois)
  if (!latest) return { status: 'missing', bestCOI: null, daysLeft: null }
  if (isSimulatedCarrierCOI(latest) || latest.status === 'pending_review') {
    return { status: 'pending_review', bestCOI: latest, daysLeft: daysUntil(latest.expiration_date) }
  }
  if (latest.status === 'rejected' || latest.status === 'needs_revision') {
    return { status: (latest.status as ComplianceStatus), bestCOI: latest, daysLeft: daysUntil(latest.expiration_date) }
  }
  const expStatus = computeExpirationStatus(latest.expiration_date, warningDays)
  return { status: expStatus, bestCOI: latest, daysLeft: daysUntil(latest.expiration_date) }
}

export function projectComplianceScore(subRows: Array<{ sub: any; cois: COIRecord[] }>, warningDays = 30) {
  if (subRows.length === 0) return { score: 100, compliant: 0, expiring: 0, expired: 0, missing: 0, pending: 0, total: 0 }
  let compliant = 0
  let expiring = 0
  let expired = 0
  let missing = 0
  let pending = 0
  for (const r of subRows) {
    const { status } = computeSubcontractorStatus(r.sub, r.cois, warningDays)
    if (status === 'compliant') compliant++
    else if (status === 'expiring_soon') expiring++
    else if (status === 'expired') expired++
    else if (status === 'missing') missing++
    else pending++
  }
  const score = Math.round((compliant / subRows.length) * 100)
  return { score, compliant, expiring, expired, missing, pending, total: subRows.length }
}
