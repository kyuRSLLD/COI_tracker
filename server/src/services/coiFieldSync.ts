import { randomUUID } from 'node:crypto'
import { dbRun, dbGet, dbAll, isPostgres } from '../db/db.ts'
import { normalizeDate, normalizeAmount } from './aiExtract.ts'

export interface ExtractedFields {
  producer?: { name?: string; address?: string; phone?: string; email?: string }
  insured?: { name?: string; address?: string; phone?: string; email?: string }
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

/**
 * Normalizes a company name for fuzzy-ish matching:
 * lowercase, strip common suffixes (LLC, Inc, Corp, Corporation, Company, Co,
 * Ltd, Limited, LP, LLP), collapse whitespace and punctuation.
 */
export function normalizeCompanyName(name?: string | null): string {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/[&.,'ʼ'`"/\\#@]/g, ' ')
    .replace(/\b(llc|inc|corp|corporation|company|co|ltd|limited|lp|llp|sons|son|bros|brothers)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Returns true when two company names match under normalizeCompanyName.
 * Both sides must be non-empty after normalization.
 */
export function companyNamesMatch(a?: string | null, b?: string | null): boolean {
  const na = normalizeCompanyName(a)
  const nb = normalizeCompanyName(b)
  return Boolean(na) && Boolean(nb) && na === nb
}

export function extractInsuredName(fields: unknown): string | null {
  const f: any = fields && typeof fields === 'object' ? fields : {}
  const name =
    (typeof f.insured?.name === 'string' && f.insured.name.trim()) ||
    (typeof f.insured?.company_name === 'string' && f.insured.company_name.trim()) ||
    (typeof f.insured === 'string' && f.insured.trim()) ||
    null
  return name && name.length > 0 ? name : null
}

function extractContacts(fields: unknown): {
  contactPerson?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
} {
  const f: any = fields && typeof fields === 'object' ? fields : {}
  const i = f.insured || {}
  const p = f.producer || {}
  const s = (v: any) => (typeof v === 'string' && v.trim()) || null
  return {
    contactPerson: s(i.contactPerson ?? i.contact_person ?? i.contact ?? p.contactPerson ?? p.contact_person),
    phone: s(i.phone ?? p.phone),
    email: s(i.email ?? p.email),
    address: s(i.address ?? p.address),
  }
}

export interface SubcontractorMatchResult {
  subcontractorId: string
  created: boolean
  matchedName: string
}

/**
 * Resolves or creates a subcontractor for the given COI based on the
 * AI-extracted insured name:
 *
 * 1. Find the GC(s) in scope: `owner_gc_user_id` on the COI, or `options.uploaderGcUserId`.
 *    If none, but any GCs are connected to the COI's current sub, use those GCs.
 * 2. Look up all connected subcontractors for those GC(s).
 * 3. If a connected sub's normalized name matches insured.name -> keep/move the COI there.
 * 4. If none match -> CREATE a new subcontractor with the extracted insured
 *    name (and contacts if available), connect it to each relevant GC, and
 *    reassign the COI.
 * 5. If the COI was previously filed under a provisional placeholder sub
 *    ("Pending document scan") that now has 0 COIs, clean it up.
 */
export async function matchOrCreateSubcontractorFromInsured(
  coiId: string,
  fields: unknown,
  options: { uploaderGcUserId?: string } = {},
): Promise<SubcontractorMatchResult | null> {
  const insuredName = extractInsuredName(fields)
  if (!insuredName) return null

  const coi = await dbGet<any>('SELECT id, subcontractor_id, owner_gc_user_id FROM cois WHERE id = ?', [coiId])
  if (!coi) return null

  const gcIds = new Set<string>()
  if (options.uploaderGcUserId) gcIds.add(options.uploaderGcUserId)
  if (coi.owner_gc_user_id) gcIds.add(coi.owner_gc_user_id)
  if (gcIds.size === 0) {
    const conns = await dbAll<any>('SELECT gc_user_id FROM gc_sub_connections WHERE subcontractor_id = ?', [coi.subcontractor_id])
    for (const c of conns) if (c.gc_user_id) gcIds.add(c.gc_user_id)
  }
  if (gcIds.size === 0) return null

  const gcList = [...gcIds]
  const rows = await dbAll<any>(
    `SELECT DISTINCT s.id, s.company_name, s.user_id FROM subcontractors s
     JOIN gc_sub_connections g ON g.subcontractor_id = s.id
     WHERE g.gc_user_id IN (${gcList.map(() => '?').join(',')})`,
    gcList,
  )

  const matched = rows.find((r) => companyNamesMatch(r.company_name, insuredName))
  const previousSubId = coi.subcontractor_id
  let targetSubId: string
  let created = false

  if (matched) {
    targetSubId = matched.id
  } else {
    targetSubId = randomUUID()
    const now = new Date().toISOString()
    const contacts = extractContacts(fields)
    await dbRun(
      `INSERT INTO subcontractors (id, company_name, trade, contact_person, phone, email, address, created_at, updated_at)
       VALUES (?, ?, 'Other', ?, ?, ?, ?, ?, ?)`,
      [targetSubId, insuredName, contacts.contactPerson ?? null, contacts.phone ?? null, contacts.email ?? null, contacts.address ?? null, now, now],
    )
    for (const gid of gcIds) {
      if (isPostgres) {
        await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [gid, targetSubId, now])
      } else {
        await dbRun('INSERT OR IGNORE INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', [gid, targetSubId, now])
      }
    }
    created = true
  }

  if (targetSubId !== previousSubId) {
    const now = new Date().toISOString()
    await dbRun('UPDATE cois SET subcontractor_id = ?, updated_at = ? WHERE id = ?', [targetSubId, now, coiId])
    const prev = await dbGet<any>('SELECT company_name FROM subcontractors WHERE id = ?', [previousSubId])
    if (prev && prev.company_name === 'Pending document scan') {
      const remaining = await dbAll<any>('SELECT id FROM cois WHERE subcontractor_id = ? LIMIT 1', [previousSubId])
      if (remaining.length === 0) {
        await dbRun('DELETE FROM gc_sub_connections WHERE subcontractor_id = ?', [previousSubId])
        await dbRun('DELETE FROM subcontractors WHERE id = ?', [previousSubId])
      }
    }
  }

  return { subcontractorId: targetSubId, created, matchedName: insuredName }
}
