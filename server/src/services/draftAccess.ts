import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dbAll, dbGet, dbRun } from '../db/db.ts'
import { ensureDraftTable } from './coiOcr.ts'
import { evaluateRequirements, getRequirements, type StructuredEvidence } from './verificationRules.ts'

// One row is both the one-use invitation and, after redemption, its explicit permission.
// Nothing is inferred from legacy project associations, email, or a JWT claim.
let schemaReady: Promise<void> | undefined
export function initDraftAccess(): Promise<void> {
  if (!schemaReady) schemaReady = createSchema().catch(error => { schemaReady = undefined; throw error })
  return schemaReady
}
async function createSchema(): Promise<void> {
  await ensureDraftTable()
  await dbRun(`CREATE TABLE IF NOT EXISTS draft_review_permissions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
    gc_user_id TEXT NOT NULL, invitation_expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
    sub_user_id TEXT, draft_id TEXT, consented_at TEXT, revoked_at TEXT
  )`)
  await dbRun('CREATE INDEX IF NOT EXISTS idx_draft_review_gc ON draft_review_permissions (gc_user_id, project_id)')
  await dbRun('CREATE INDEX IF NOT EXISTS idx_draft_review_sub ON draft_review_permissions (sub_user_id)')
}
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')
export const validToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
const now = () => new Date().toISOString()

export async function ownedProject(projectId: string, gcId: string) {
  return dbGet<any>(`SELECT p.id, p.name FROM projects p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND p.user_id = ? AND u.role = 'gc'`, [projectId, gcId])
}
export async function createInvitation(projectId: string, gcId: string, hours: number) {
  const project = await ownedProject(projectId, gcId)
  if (!project) return null
  const token = randomBytes(32).toString('base64url') // 256 bits, stored only as a SHA-256 digest
  const id = randomUUID(), createdAt = now(), expiresAt = new Date(Date.now() + hours * 3600000).toISOString()
  // Recheck ownership at insertion, including current role.
  const result = await dbRun(`INSERT INTO draft_review_permissions (id, token_hash, project_id, gc_user_id, invitation_expires_at, created_at)
    SELECT ?, ?, p.id, u.id, ?, ? FROM projects p JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND u.id = ? AND u.role = 'gc'`, [id, hashToken(token), expiresAt, createdAt, projectId, gcId])
  return result.changes ? { id, token, expires_at: expiresAt, project: { id: project.id, name: project.name } } : null
}

// Preview discloses the named project/owner only to a signed-in sub possessing the capability.
export async function previewInvitation(token: string) {
  return dbGet<any>(`SELECT p.id AS project_id, p.name AS project_name, u.id AS gc_user_id, u.name AS gc_name, a.invitation_expires_at AS expires_at
    FROM draft_review_permissions a JOIN projects p ON p.id = a.project_id AND p.user_id = a.gc_user_id
    JOIN users u ON u.id = a.gc_user_id AND u.role = 'gc'
    WHERE a.token_hash = ? AND a.sub_user_id IS NULL AND a.revoked_at IS NULL AND a.invitation_expires_at > ?`, [hashToken(token), now()])
}

export async function acceptInvitation(token: string, draftId: string, subId: string, projectId: string) {
  const t = now()
  // The conditional update is atomic on both SQLite and PostgreSQL: only one sub can
  // consume this invitation, and only for a draft actually owned by that current sub.
  const result = await dbRun(`UPDATE draft_review_permissions SET sub_user_id = ?, draft_id = ?, consented_at = ?
    WHERE token_hash = ? AND project_id = ? AND sub_user_id IS NULL AND revoked_at IS NULL AND invitation_expires_at > ?
    AND EXISTS (SELECT 1 FROM projects p JOIN users g ON g.id = p.user_id
      WHERE p.id = draft_review_permissions.project_id AND p.user_id = draft_review_permissions.gc_user_id AND g.role = 'gc')
    AND EXISTS (SELECT 1 FROM sub_coi_drafts d JOIN users s ON s.id = d.owner_user_id
      WHERE d.id = ? AND d.owner_user_id = ? AND s.role = 'sub')`, [subId, draftId, t, hashToken(token), projectId, t, draftId, subId])
  if (!result.changes) return null
  return dbGet<any>(`SELECT a.id, a.project_id, p.name AS project_name, u.id AS gc_user_id, u.name AS gc_name, a.draft_id, a.consented_at
    FROM draft_review_permissions a JOIN projects p ON p.id = a.project_id AND p.user_id = a.gc_user_id
    JOIN users u ON u.id = a.gc_user_id AND u.role = 'gc' WHERE a.token_hash = ? AND a.sub_user_id = ?`, [hashToken(token), subId])
}

export async function subPermissions(subId: string) {
  return dbAll<any>(`SELECT a.id, a.project_id, p.name AS project_name, a.gc_user_id, g.name AS gc_name, a.draft_id, a.consented_at, a.revoked_at,
    CASE WHEN p.user_id = a.gc_user_id AND g.role = 'gc' AND d.owner_user_id = a.sub_user_id AND s.role = 'sub' AND a.revoked_at IS NULL THEN 1 ELSE 0 END AS active
    FROM draft_review_permissions a LEFT JOIN projects p ON p.id = a.project_id AND p.user_id = a.gc_user_id
    LEFT JOIN users g ON g.id = a.gc_user_id LEFT JOIN users s ON s.id = a.sub_user_id
    LEFT JOIN sub_coi_drafts d ON d.id = a.draft_id WHERE a.sub_user_id = ? ORDER BY a.consented_at DESC`, [subId])
}
export async function gcInvitations(projectId: string, gcId: string) {
  return dbAll<any>(`SELECT a.id, a.invitation_expires_at AS expires_at, a.created_at, a.consented_at, a.revoked_at
    FROM draft_review_permissions a JOIN projects p ON p.id = a.project_id AND p.user_id = a.gc_user_id
    JOIN users u ON u.id = a.gc_user_id AND u.role = 'gc'
    WHERE a.project_id = ? AND a.gc_user_id = ? ORDER BY a.created_at DESC`, [projectId, gcId])
}
export async function revokePermission(id: string, userId: string, role: 'gc' | 'sub') {
  if (role === 'gc') {
    return dbRun(`UPDATE draft_review_permissions SET revoked_at = ? WHERE id = ? AND gc_user_id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = draft_review_permissions.project_id AND p.user_id = ? AND u.role = 'gc')`, [now(), id, userId, userId])
  }
  return dbRun(`UPDATE draft_review_permissions SET revoked_at = ? WHERE id = ? AND sub_user_id = ? AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.role = 'sub')`, [now(), id, userId, userId])
}

// All document/OCR queries use this join, including at link redemption time. The
// project owner and both database roles must still be current; revoked consent fails.
const accessJoin = `FROM draft_review_permissions a
  JOIN projects p ON p.id = a.project_id AND p.user_id = a.gc_user_id
  JOIN users g ON g.id = a.gc_user_id AND g.role = 'gc'
  JOIN users s ON s.id = a.sub_user_id AND s.role = 'sub'
  JOIN sub_coi_drafts d ON d.id = a.draft_id AND d.owner_user_id = a.sub_user_id
  WHERE a.project_id = ? AND a.gc_user_id = ? AND a.consented_at IS NOT NULL AND a.revoked_at IS NULL`
export async function gcDrafts(projectId: string, gcId: string) {
  return dbAll<any>(`SELECT a.id AS permission_id, d.id AS draft_id, s.name AS sub_name, d.certificate_name, d.certificate_mime,
    d.certificate_size, d.ocr_status, d.created_at, a.consented_at ${accessJoin} ORDER BY a.consented_at DESC`, [projectId, gcId])
}
export async function gcDraft(projectId: string, gcId: string, permissionId: string) {
  return dbGet<any>(`SELECT a.id AS permission_id, d.id AS draft_id, s.name AS sub_name, d.certificate_name, d.certificate_mime,
    d.certificate_size, d.ocr_status, d.ocr_result, d.storage_backend, d.storage_key, d.created_at, a.consented_at
    ${accessJoin} AND a.id = ?`, [projectId, gcId, permissionId])
}
const aliases = ['insuredName', 'generalLiabilityEachOccurrence', 'generalLiabilityAggregate', 'autoCombinedSingleLimit', 'umbrellaEachOccurrence', 'umbrellaAggregate',
  'generalLiabilityInsurer', 'generalLiabilityPolicyNumber', 'generalLiabilityEffectiveDate', 'generalLiabilityExpirationDate',
  'autoInsurer', 'autoPolicyNumber', 'autoEffectiveDate', 'autoExpirationDate', 'umbrellaInsurer', 'umbrellaPolicyNumber', 'umbrellaEffectiveDate', 'umbrellaExpirationDate'] as const
export async function draftReview(row: any, projectId: string) {
  let proposal: any = null
  try {
    const parsed = JSON.parse(row.ocr_result || 'null')
    if (row.ocr_status === 'completed' && parsed?.proposal?.status === 'unverified' && parsed.proposal.fields && typeof parsed.proposal.fields === 'object') {
      const fields: Record<string, any> = {}
      for (const key of aliases) {
        const field = parsed.proposal.fields[key]
        if (!field || typeof field !== 'object') continue
        const value = typeof field.value === 'string' ? field.value.slice(0, 200) : typeof field.value === 'number' && Number.isSafeInteger(field.value) ? field.value : null
        fields[key] = { status: field.status === 'proposed' ? 'proposed' : 'unknown', value, reason: typeof field.reason === 'string' ? field.reason.slice(0, 200) : null }
      }
      proposal = { status: 'unverified', fields }
    }
  } catch { /* malformed/incomplete OCR is unknown */ }
  const fieldValue = (key: string) => {
    const f = proposal?.fields?.[key]
    return f?.status === 'proposed' && typeof f.value === 'number' && Number.isSafeInteger(f.value) && f.value >= 0 ? f.value : null
  }
  const evidence: StructuredEvidence = {
    gl_per_occurrence: { value: fieldValue('generalLiabilityEachOccurrence'), confidence: 'unknown' },
    gl_aggregate: { value: fieldValue('generalLiabilityAggregate'), confidence: 'unknown' },
    auto_limit: { value: fieldValue('autoCombinedSingleLimit'), confidence: 'unknown' },
    umbrella_limit: { value: fieldValue('umbrellaEachOccurrence'), confidence: 'unknown' },
    workers_comp_present: { value: null, confidence: 'unknown' },
  }
  const requirements = await getRequirements(projectId)
  return { permission_id: row.permission_id, draft_id: row.draft_id, sub_name: row.sub_name,
    certificate_name: row.certificate_name, certificate_mime: row.certificate_mime, certificate_size: row.certificate_size,
    created_at: row.created_at, consented_at: row.consented_at, ocr_status: row.ocr_status, proposal,
    requirements, requirements_version: requirements?.version ?? null, evaluation: evaluateRequirements(requirements, evidence),
    disclaimer: 'OCR proposals are unverified. Human review of the document, dates, policy terms, and endorsements is required. This is not approval or external verification.' }
}
