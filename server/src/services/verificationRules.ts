import { dbExec, dbGet, dbRun } from '../db/db.ts'

/** Amounts are whole US dollars. A null minimum means that limit is not configured. */
export interface RequirementsInput {
  gl_per_occurrence_min: number | null
  gl_aggregate_min: number | null
  auto_limit_min: number | null
  umbrella_limit_min: number | null
  workers_comp_required: boolean
  additional_insured_required: boolean
}
export interface Requirements extends RequirementsInput {
  project_id: string
  version: number
  updated_at: string
}
export type Confidence = 'high' | 'low' | 'unknown'
export interface Observation<T> { value: T | null; confidence: Confidence }
export interface StructuredEvidence {
  gl_per_occurrence?: Observation<number>
  gl_aggregate?: Observation<number>
  auto_limit?: Observation<number>
  umbrella_limit?: Observation<number>
  workers_comp_present?: Observation<boolean>
}
export type CriterionStatus = 'meet' | 'does_not_meet' | 'unknown'
export interface Criterion {
  key: string
  status: CriterionStatus
  required: number | boolean
  observed: number | boolean | null
  reason: string
}
export interface Evaluation {
  status: 'meet' | 'does_not_meet' | 'needs_review'
  criteria: Criterion[]
  disclaimer: string
}

const disclaimer = 'Comparison of supplied data only; it does not verify coverage, policy terms, endorsements, dates, or guarantee insurance. Human review is required.'
let schemaReady: Promise<void> | undefined
export function initVerificationRules(): Promise<void> {
  if (!schemaReady) {
    schemaReady = dbExec(`CREATE TABLE IF NOT EXISTS project_verification_requirements (
      project_id TEXT PRIMARY KEY,
      gl_per_occurrence_min INTEGER,
      gl_aggregate_min INTEGER,
      auto_limit_min INTEGER,
      umbrella_limit_min INTEGER,
      workers_comp_required INTEGER NOT NULL,
      additional_insured_required INTEGER NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );`).catch((error) => { schemaReady = undefined; throw error })
  }
  return schemaReady
}

export async function getRequirements(projectId: string): Promise<Requirements | null> {
  await initVerificationRules()
  const row = await dbGet('SELECT * FROM project_verification_requirements WHERE project_id = ?', [projectId])
  if (!row) return null
  return { ...row, workers_comp_required: Boolean(row.workers_comp_required), additional_insured_required: Boolean(row.additional_insured_required) }
}

/** Compare-and-swap: expectedVersion 0 creates; a positive version updates only that version. */
export async function saveRequirements(projectId: string, input: RequirementsInput, expectedVersion: number): Promise<Requirements | null> {
  await initVerificationRules()
  const now = new Date().toISOString()
  const values = [input.gl_per_occurrence_min, input.gl_aggregate_min, input.auto_limit_min, input.umbrella_limit_min,
    input.workers_comp_required ? 1 : 0, input.additional_insured_required ? 1 : 0]
  let result
  if (expectedVersion === 0) {
    result = await dbRun(`INSERT INTO project_verification_requirements
      (project_id, gl_per_occurrence_min, gl_aggregate_min, auto_limit_min, umbrella_limit_min, workers_comp_required, additional_insured_required, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (project_id) DO NOTHING`, [projectId, ...values, now])
  } else {
    result = await dbRun(`UPDATE project_verification_requirements SET gl_per_occurrence_min = ?, gl_aggregate_min = ?, auto_limit_min = ?, umbrella_limit_min = ?, workers_comp_required = ?, additional_insured_required = ?, version = version + 1, updated_at = ? WHERE project_id = ? AND version = ?`, [...values, now, projectId, expectedVersion])
  }
  return result.changes ? getRequirements(projectId) : null
}

export function evaluateRequirements(requirements: RequirementsInput | null, evidence: StructuredEvidence): Evaluation {
  const criteria: Criterion[] = []
  const limit = (key: string, required: number | null, observation: Observation<number> | undefined) => {
    if (required === null) return
    const observed = observation?.value ?? null
    if (observation?.confidence !== 'high' || observed === null || !Number.isSafeInteger(observed) || observed < 0) {
      criteria.push({ key, status: 'unknown', required, observed, reason: 'Value missing, ambiguous, or not high confidence.' })
    } else {
      criteria.push({ key, status: observed >= required ? 'meet' : 'does_not_meet', required, observed, reason: observed >= required ? 'Supplied limit meets the configured minimum.' : 'Supplied limit is below the configured minimum.' })
    }
  }
  if (requirements) {
    limit('gl_per_occurrence', requirements.gl_per_occurrence_min, evidence.gl_per_occurrence)
    limit('gl_aggregate', requirements.gl_aggregate_min, evidence.gl_aggregate)
    limit('auto_limit', requirements.auto_limit_min, evidence.auto_limit)
    limit('umbrella_limit', requirements.umbrella_limit_min, evidence.umbrella_limit)
    if (requirements.workers_comp_required) {
      const observation = evidence.workers_comp_present
      const observed = observation?.value ?? null
      const known = observation?.confidence === 'high' && typeof observed === 'boolean'
      criteria.push({ key: 'workers_comp_present', required: true, observed, status: !known ? 'unknown' : observed ? 'meet' : 'does_not_meet', reason: !known ? 'Workers compensation evidence is missing or not high confidence.' : observed ? 'Coverage presence was supplied; statutory terms are not checked.' : 'Evidence indicates coverage is absent.' })
    }
    if (requirements.additional_insured_required) {
      criteria.push({ key: 'additional_insured_proof', required: true, observed: null, status: 'unknown', reason: 'Endorsement proof is not supported by this comparison; a certificate checkbox is not proof. Review the actual endorsement.' })
    }
  }
  const status = criteria.some(c => c.status === 'does_not_meet') ? 'does_not_meet'
    : criteria.length === 0 || criteria.some(c => c.status === 'unknown') ? 'needs_review' : 'meet'
  return { status, criteria, disclaimer }
}

/** Strict parsing avoids interpreting values such as '1M/2M', statutory, or malformed input as dollars. */
export function parseLegacyDollar(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?$/.test(text)) return null
  const amount = Number(text.replace(/[$,]/g, ''))
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null
}

export function legacyCoverageEvidence(coverages: Array<{ type: string; per_occurrence_limit: string | null; aggregate_limit: string | null }>): StructuredEvidence {
  const lookup = (type: string) => coverages.filter(c => c.type?.trim().toLowerCase() === type)
  const numberFrom = (type: string, field: 'per_occurrence_limit' | 'aggregate_limit'): Observation<number> => {
    const rows = lookup(type)
    return { value: rows.length === 1 ? parseLegacyDollar(rows[0][field]) : null, confidence: 'unknown' }
  }
  const wc = lookup("workers' compensation")
  return {
    gl_per_occurrence: numberFrom('general liability', 'per_occurrence_limit'),
    gl_aggregate: numberFrom('general liability', 'aggregate_limit'),
    auto_limit: numberFrom('automobile liability', 'per_occurrence_limit'),
    umbrella_limit: numberFrom('umbrella liability', 'per_occurrence_limit'),
    workers_comp_present: { value: wc.length === 1 ? true : null, confidence: 'unknown' },
  }
}
