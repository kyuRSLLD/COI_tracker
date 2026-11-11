import express from 'express'
import { z } from 'zod'
import { dbAll, dbGet } from '../db/db.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { evaluateRequirements, getRequirements, legacyCoverageEvidence, saveRequirements } from '../services/verificationRules.ts'

export const verificationRouter = express.Router()

const money = z.number().int().min(0).max(2147483647)
const requirementsSchema = z.object({
  gl_per_occurrence_min: money.nullable(),
  gl_aggregate_min: money.nullable(),
  auto_limit_min: money.nullable(),
  umbrella_limit_min: money.nullable(),
  workers_comp_required: z.boolean(),
  additional_insured_required: z.boolean(),
}).strict()
const confidence = z.enum(['high', 'low', 'unknown'])
const amountObservation = z.object({ value: money.nullable(), confidence }).strict()
const evidenceSchema = z.object({
  gl_per_occurrence: amountObservation.optional(),
  gl_aggregate: amountObservation.optional(),
  auto_limit: amountObservation.optional(),
  umbrella_limit: amountObservation.optional(),
  workers_comp_present: z.object({ value: z.boolean().nullable(), confidence }).strict().optional(),
}).strict()
const putSchema = z.object({ expected_version: z.number().int().min(0).max(2147483646), requirements: requirementsSchema }).strict()

verificationRouter.use(requireAuth)
verificationRouter.use((req: AuthRequest, res, next) => {
  if (req.user?.role !== 'gc' && req.user?.role !== 'admin') return res.status(403).json({ error: 'GC or admin access required' })
  next()
})

// Do not allow administrators to bypass ownership, and never adopt unowned projects.
verificationRouter.use('/projects/:projectId', async (req: AuthRequest, res, next) => {
  try {
    const project = await dbGet('SELECT id FROM projects WHERE id = ? AND user_id = ?', [req.params.projectId, req.user!.id])
    if (!project) return res.status(404).json({ error: 'Project not found' })
    next()
  } catch (error) { next(error) }
})

verificationRouter.get('/projects/:projectId/requirements', async (req, res, next) => {
  try { res.json({ requirements: await getRequirements(req.params.projectId) }) } catch (error) { next(error) }
})

verificationRouter.put('/projects/:projectId/requirements', async (req, res, next) => {
  const parsed = putSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid requirements or expected_version', issues: parsed.error.issues })
  try {
    const requirements = await saveRequirements(req.params.projectId, parsed.data.requirements, parsed.data.expected_version)
    if (!requirements) return res.status(409).json({ error: 'Requirements changed; reload before saving.' })
    res.json({ requirements })
  } catch (error) { next(error) }
})

/**
 * POST /api/verification/projects/:projectId/evaluate
 * Body: { evidence: { gl_per_occurrence?, gl_aggregate?, auto_limit?, umbrella_limit?,
 *   workers_comp_present? } }. Each field is { value: number|boolean|null,
 *   confidence: 'high'|'low'|'unknown' }; limits are whole USD, WC is boolean.
 *
 * This is a non-persistent comparison of caller-supplied values against saved rules,
 * NOT a verification, approval, policy/date check, or endorsement check. A 'meet'
 * result is not approval and the GC must review the source. Textract line confidence
 * alone is not field-level confidence: map absent, ambiguous, or unreviewed OCR
 * proposals to unknown/low. A human or separately validated process must establish
 * field-level confidence. Additional-insured endorsement proof is always unknown.
 */
verificationRouter.post('/projects/:projectId/evaluate', async (req, res, next) => {
  const parsed = z.object({ evidence: evidenceSchema }).strict().safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid structured evidence', issues: parsed.error.issues })
  try {
    const requirements = await getRequirements(req.params.projectId)
    res.json({ requirements_version: requirements?.version ?? null, evidence_source: 'caller_supplied_unverified', evaluation: evaluateRequirements(requirements, parsed.data.evidence) })
  } catch (error) { next(error) }
})

// Existing coverage rows include user defaults and simulated carrier data with no confidence or provenance.
// They are displayed as unverified and never promoted to high confidence by this adapter.
verificationRouter.get('/projects/:projectId/evidence', async (req, res, next) => {
  try {
    const projectId = req.params.projectId
    const requirements = await getRequirements(projectId)
    const subs = await dbAll(`SELECT s.id, s.company_name FROM project_subcontractors ps
      JOIN subcontractors s ON s.id = ps.subcontractor_id WHERE ps.project_id = ? ORDER BY s.company_name, s.id`, [projectId])
    const certificates = await dbAll(`SELECT c.id, c.subcontractor_id, c.carrier, c.effective_date, c.expiration_date, c.status, c.updated_at
      FROM project_subcontractors ps JOIN cois c ON c.subcontractor_id = ps.subcontractor_id
      WHERE ps.project_id = ? ORDER BY c.expiration_date DESC, c.id`, [projectId])
    const coverages = await dbAll(`SELECT cv.coi_id, cv.type, cv.per_occurrence_limit, cv.aggregate_limit
      FROM project_subcontractors ps JOIN cois c ON c.subcontractor_id = ps.subcontractor_id
      JOIN coi_coverages cv ON cv.coi_id = c.id WHERE ps.project_id = ?`, [projectId])
    const subcontractors = subs.map(sub => ({
      id: sub.id, company_name: sub.company_name,
      certificates: certificates.filter(c => c.subcontractor_id === sub.id).map(c => {
        const evidence = legacyCoverageEvidence(coverages.filter(cv => cv.coi_id === c.id))
        return { ...c, evidence, evaluation: evaluateRequirements(requirements, evidence) }
      }),
    }))
    res.json({ requirements_version: requirements?.version ?? null, evidence_source: 'existing_coverage_rows_unverified', subcontractors, disclaimer: 'Existing values may be defaults or simulated; no OCR or carrier verification is performed. Dates and endorsements require human review.' })
  } catch (error) { next(error) }
})
