import { randomUUID } from 'crypto'
import { dbRun, dbGet, dbAll } from '../db/db.ts'
import { normalizeDate, normalizeAmount } from './aiExtract.ts'

export interface ExtractedFields {
  producer?: { name?: string; address?: string; phone?: string; email?: string }
  insured?: { name?: string; address?: string }
  insurers?: Array<{ letter?: string; name?: string; naic?: string }>
  insurer?: { name?: string; naic?: string }
  carrier?: string
  policies?: Array<{
    type?: string
    insurerLetter?: string
    policyNumber?: string
    policy_number?: string
    effectiveDate?: string
    effective_date?: string
    expirationDate?: string
    expiration_date?: string
    limits?: Array<{ name?: string; label?: string; amount?: string | number }>
  }>
  source?: string
}

export interface NormalizedExtractedDb {
  carrier: string | null
  policyNumber: string | null
  effectiveDate: string | null
  expirationDate: string | null
  coverages: Array<{
    type: string
    perOccurrenceLimit: string | null
    aggregateLimit: string | null
  }>
}

export function normalizeExtractedForDb(fields: ExtractedFields | unknown): NormalizedExtractedDb {
  const f = (fields || {}) as ExtractedFields
  const insurers = f.insurers || (f.insurer ? [f.insurer] : [])
  const policies = f.policies || []
  const first = policies[0] || {}
  const eff = normalizeDate(first.effectiveDate || first.effective_date)
  const exp = normalizeDate(first.expirationDate || first.expiration_date)
  const carrier = (insurers[0]?.name || f.carrier || '').trim() || null
  const policyNumber = (first.policyNumber || first.policy_number || '').trim() || null
  const coverages = policies.map((p) => {
    const limits = p.limits || []
    const pick = (kws: string[]) => {
      const l = limits.find((x) => kws.some((k) => (x.name || x.label || '').toLowerCase().includes(k)))
      return l ? normalizeAmount(String(l.amount)) : null
    }
    return {
      type: (p.type || 'General Liability').trim(),
      perOccurrenceLimit: pick(['occur', 'each occur', 'combined']) ?? null,
      aggregateLimit: pick(['aggregate', 'agg']) ?? null,
    }
  })
  return { carrier, policyNumber, effectiveDate: eff || null, expirationDate: exp || null, coverages }
}

export interface SyncOptions {
  /** When false, only fill columns that are currently empty/'Not provided'. Default true. */
  overwrite?: boolean
}

export async function applyExtractedFieldsToCoi(coiId: string, fields: unknown, options: SyncOptions = {}): Promise<void> {
  const { overwrite = true } = options
  const norm = normalizeExtractedForDb(fields)
  const now = new Date().toISOString()
  if (overwrite) {
    await dbRun(
      `UPDATE cois SET carrier = ?, policy_number = ?, effective_date = ?, expiration_date = ?, updated_at = ? WHERE id = ?`,
      [norm.carrier, norm.policyNumber, norm.effectiveDate, norm.expirationDate, now, coiId],
    )
    await dbRun('DELETE FROM coi_coverages WHERE coi_id = ?', [coiId])
    for (const cov of norm.coverages) {
      await dbRun(
        `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation)
         VALUES (?, ?, ?, ?, ?, 0, 0)`,
        [randomUUID(), coiId, cov.type, cov.perOccurrenceLimit, cov.aggregateLimit],
      )
    }
  } else {
    // Fill-only mode (used for automatic post-upload extraction): keep any values
    // the user manually entered and only backfill placeholders.
    const row = await dbGet<any>('SELECT carrier, policy_number, effective_date, expiration_date FROM cois WHERE id = ?', [coiId])
    if (!row) return
    const carrier = row.carrier && row.carrier !== 'Not provided' ? row.carrier : norm.carrier
    const policyNumber = row.policy_number ?? norm.policyNumber
    const effectiveDate = row.effective_date ? row.effective_date : norm.effectiveDate
    const expirationDate = row.expiration_date ? row.expiration_date : norm.expirationDate
    await dbRun(
      `UPDATE cois SET carrier = ?, policy_number = ?, effective_date = ?, expiration_date = ?, updated_at = ? WHERE id = ?`,
      [carrier, policyNumber, effectiveDate, expirationDate, now, coiId],
    )
    const existing = await dbAll('SELECT id FROM coi_coverages WHERE coi_id = ? LIMIT 1', [coiId])
    if (existing.length === 0) {
      for (const cov of norm.coverages) {
        await dbRun(
          `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation)
           VALUES (?, ?, ?, ?, ?, 0, 0)`,
          [randomUUID(), coiId, cov.type, cov.perOccurrenceLimit, cov.aggregateLimit],
        )
      }
    }
  }
}
