import { isExpiredDate, formatDisplayDate } from './date'

export interface PolicyDateRow {
  type?: string
  policyNumber?: string
  policy_number?: string
  expirationDate?: string
  expiration_date?: string
}

/**
 * A COI is considered fully expired ONLY when every one of its digitised
 * policies has an expiration date in the past. If policies are not yet
 * extracted, falls back to the COI's single expiration_date.
 */
export function coiExpiryAllExpired(
  expirationDate?: string | null,
  policies?: PolicyDateRow[],
): boolean {
  if (policies && policies.length > 0) {
    return policies.every((p) => isExpiredDate(p.expirationDate || p.expiration_date))
  }
  return isExpiredDate(expirationDate)
}

/** Policies whose expiration date is in the past. */
export function expiredPolicyRows(policies?: PolicyDateRow[]): PolicyDateRow[] {
  if (!policies) return []
  return policies.filter((p) => isExpiredDate(p.expirationDate || p.expiration_date))
}

/** True when some — but not all — policies are expired. */
export function isPartiallyExpired(
  expirationDate?: string | null,
  policies?: PolicyDateRow[],
): boolean {
  if (!policies || policies.length <= 1) return false
  const expired = expiredPolicyRows(policies)
  return expired.length > 0 && expired.length < policies.length
}

/** Human list: "Workers' Compensation (ended 03/15/2026), Auto Liability (ended 04/01/2026)" */
export function formatExpiredPolicyList(policies?: PolicyDateRow[]): string {
  const expired = expiredPolicyRows(policies)
  return expired
    .map((p) => {
      const type = p.type || 'Coverage'
      const pn = p.policyNumber || p.policy_number
      const exp = formatDisplayDate(p.expirationDate || p.expiration_date)
      return `${type}${pn ? ` (#${pn})` : ''} (ended ${exp})`
    })
    .join(', ')
}
