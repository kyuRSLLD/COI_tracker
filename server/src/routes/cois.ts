import express from 'express'; const Router = express.Router
import multer from 'multer'
import { v4 as uuidv4 } from 'uuid'
import { randomUUID } from 'crypto'
import { dbAll, dbGet, dbRun, deleteOwnedGcCOI } from '../db/db.ts'
import { storeFile, getFileViewUrl } from '../services/storage.ts'
import { prepareUploadFile } from '../services/imageFormat.ts'
import { requireAuth, isGcRole, type AuthRequest } from '../middleware/auth.ts'
import { labelSimulatedCarrierCOI } from '../services/compliance.ts'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
})

export const coisRouter = Router()

// A connection is necessary, but not sufficient: unowned legacy rows and
// records owned by other GCs are not visible. The sub owner must be the user
// currently linked to this exact subcontractor.
const readAccess = `EXISTS (SELECT 1 FROM gc_sub_connections g
  WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
  AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL
    AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id))`

// Even a malformed dual-owned record is not writable by a GC.
const writeAccess = `c.owner_gc_user_id = ? AND c.owner_sub_user_id IS NULL
  AND EXISTS (SELECT 1 FROM gc_sub_connections g
    WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)`
const writeAccessForUpdate = `cois.owner_gc_user_id = ? AND cois.owner_sub_user_id IS NULL
  AND EXISTS (SELECT 1 FROM gc_sub_connections g
    WHERE g.subcontractor_id = cois.subcontractor_id AND g.gc_user_id = ?)`

async function coverageForGC(coiId: string, gcUserId: string) {
  return dbAll(`SELECT cv.* FROM coi_coverages cv
    JOIN cois c ON c.id = cv.coi_id
    JOIN subcontractors s ON s.id = c.subcontractor_id
    WHERE c.id = ? AND ${readAccess}`, [coiId, gcUserId, gcUserId])
}

// Never expose the internal object key or return a persisted legacy URL. Only
// derive a fresh view URL from an acceptable key, after authorizing the row.
async function publicCOI(row: any) {
  const labelled = labelSimulatedCarrierCOI(row)
  const { certificate_key: key, certificate_url: _storedUrl, ...safe } = labelled
  let certificate_url: string | null = null
  if (typeof key === 'string' && /^(?:cois\/[a-zA-Z0-9._-]+|[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(key)) {
    try {
      try { certificate_url = await getFileViewUrl(key) } catch { certificate_url = null }
    } catch {
      // Unavailable storage or an unusable legacy key is not a reason to
      // return the old URL, which may be public or otherwise untrusted.
    }
  }
  return { ...safe, certificate_url }
}

coisRouter.use(requireAuth, async (req: AuthRequest, res, next) => {
  if (!req.user || !isGcRole(req.user.role) || typeof req.user.id !== 'string' || !req.user.id) {
    return res.status(403).json({ error: 'GC access required' })
  }
  try {
    const user = await dbGet("SELECT id FROM users WHERE id = ? AND role IN ('gc', 'pro_gc')", [req.user.id])
    if (!user) return res.status(403).json({ error: 'GC access required' })
    next()
  } catch {
    res.status(500).json({ error: 'Unable to verify access' })
  }
})

coisRouter.get('/', async (req: AuthRequest, res) => {
  try {
    const { sub_id, status } = req.query as { sub_id?: string; status?: string }
    let sql = `SELECT c.*, s.company_name, s.trade, s.contact_person
      FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
      WHERE ${readAccess}`
    const params: any[] = [req.user!.id, req.user!.id]
    if (sub_id) {
      sql += ' AND c.subcontractor_id = ?'
      params.push(sub_id)
    }
    sql += ' ORDER BY c.expiration_date ASC'
    const allRows = (await dbAll(sql, params)).map(labelSimulatedCarrierCOI)
    const rows = status && status !== 'all' ? allRows.filter((c) => c.status === status) : allRows
    const enriched = await Promise.all(rows.map(async (c) => ({
      ...await publicCOI(c),
      coverages: await coverageForGC(c.id, req.user!.id),
    })))
    res.json({ cois: enriched })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.get('/alerts/expiring', async (req: AuthRequest, res) => {
  try {
    const days = Number(req.query.days) || 30
    const today = new Date()
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + days)
    const todayStr = today.toISOString().slice(0, 10)
    const horizonStr = horizon.toISOString().slice(0, 10)

    const rows = await dbAll(
      `SELECT c.*, s.company_name, s.trade, s.phone, s.email, s.contact_person
       FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.expiration_date >= ? AND c.expiration_date <= ? AND c.status != 'rejected'
         AND ${readAccess}
       ORDER BY c.expiration_date ASC`,
      [todayStr, horizonStr, req.user!.id, req.user!.id]
    )
    res.json({ alerts: await Promise.all(rows.map(publicCOI)), window_days: days })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.get('/:id', async (req: AuthRequest, res) => {
  try {
    const coi = await dbGet(
      `SELECT c.*, s.company_name, s.trade, s.phone, s.email, s.contact_person
       FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
       WHERE c.id = ? AND ${readAccess}`,
      [req.params.id, req.user!.id, req.user!.id]
    )
    if (!coi) return res.status(404).json({ error: 'COI not found' })
    const coverages = await coverageForGC(coi.id, req.user!.id)
    res.json({ coi: { ...await publicCOI(coi), coverages } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.post('/', upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    const { subcontractor_id, carrier, am_best_rating, policy_number, effective_date,
      expiration_date, status, reviewer_notes } = req.body || {}
    let subId = typeof subcontractor_id === 'string' && subcontractor_id.trim() ? subcontractor_id.trim() : null
    if (!subId) {
      const provisionalId = uuidv4()
      const nowProv = new Date().toISOString()
      await dbRun(
        'INSERT INTO subcontractors (id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [provisionalId, 'Pending document scan', 'Other', nowProv, nowProv],
      )
      await dbRun(
        'INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)',
        [req.user!.id, provisionalId, nowProv],
      )
      subId = provisionalId
    }
    const carrierVal = (typeof carrier === 'string' && carrier.trim()) || 'Not provided'
    const effVal = typeof effective_date === 'string' ? effective_date : ''
    const expVal = typeof expiration_date === 'string' ? expiration_date : ''
    if (effVal && expVal && effVal > expVal) {
      return res.status(400).json({ error: 'Effective date must be on or before expiration date' })
    }

    const sub = await dbGet(`SELECT s.id FROM subcontractors s WHERE s.id = ? AND EXISTS
      (SELECT 1 FROM gc_sub_connections g WHERE g.subcontractor_id = s.id AND g.gc_user_id = ?)`, [subId, req.user!.id])
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' })

    const file = req.file ? await prepareUploadFile(req.file) : undefined
    const stored = file ? await storeFile(file) : undefined
    const id = uuidv4()
    const now = new Date().toISOString()
    const inserted = await dbRun(
      `INSERT INTO cois (id, subcontractor_id, owner_gc_user_id, carrier, am_best_rating, policy_number, effective_date, expiration_date, status, reviewer_notes, certificate_url, certificate_key, certificate_name, certificate_size, certificate_mime, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM gc_sub_connections g JOIN subcontractors s ON s.id = g.subcontractor_id
          WHERE g.subcontractor_id = ? AND g.gc_user_id = ?)`,
      [id, subId, req.user!.id, carrierVal, am_best_rating || null, policy_number || null,
        effVal, expVal, status || 'pending_review', reviewer_notes || null,
        stored ? stored.url : null, stored ? stored.key : null, stored ? stored.filename : null,
        stored ? stored.size : null, stored ? stored.mime : null, now, now, subId, req.user!.id]
    )
    if (!inserted.changes) return res.status(404).json({ error: 'Subcontractor not found' })

    if (file?.buffer && stored) {
      try {
        const { tryAnalyzeCoiDocument, isTextractConfigured } = await import('../services/textract.ts')
        const { saveExtractedReview } = await import('../routes/coiFields.ts')
        const { normalizeImage, isTextractCompatible } = await import('../services/imageFormat.ts')
        if (isTextractConfigured()) {
          const norm = await normalizeImage(file.buffer, file.originalname)
          if (norm && isTextractCompatible(norm.mime)) {
            const r = await tryAnalyzeCoiDocument(norm.buffer)
            if (r.ok && r.fields) await saveExtractedReview(id, stored.key || null, r.fields, { overwrite: false, uploaderGcUserId: req.user!.id })
          }
        }
      } catch (e) { console.error('GC upload auto-extraction failed:', e) }
    }
    let coverages: any[] = []
    if (req.body.coverages) {
      try {
        const parsed = JSON.parse(req.body.coverages)
        if (Array.isArray(parsed)) coverages = parsed
      } catch {}
    }
    for (const cv of coverages) {
      const result = await dbRun(
        `INSERT INTO coi_coverages (id, coi_id, type, per_occurrence_limit, aggregate_limit, additional_insured, waiver_of_subrogation, notes)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
           (SELECT 1 FROM cois c WHERE c.id = ? AND ${writeAccess})`,
        [uuidv4(), id, cv.type || 'General Liability', cv.per_occurrence_limit || null,
          cv.aggregate_limit || null, cv.additional_insured ? 1 : 0, cv.waiver_of_subrogation ? 1 : 0,
          cv.notes || null, id, req.user!.id, req.user!.id]
      )
      if (!result.changes) return res.status(404).json({ error: 'COI not found' })
    }

    const created = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND ${writeAccess}`,
      [id, req.user!.id, req.user!.id])
    if (!created) return res.status(404).json({ error: 'COI not found' })
    res.status(201).json({ coi: await publicCOI(created) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id', upload.single('certificate'), async (req: AuthRequest, res) => {
  try {
    const existing = await dbGet(`SELECT c.id FROM cois c WHERE c.id = ? AND ${writeAccess}`,
      [req.params.id, req.user!.id, req.user!.id])
    if (!existing) return res.status(404).json({ error: 'COI not found' })

    const stored = req.file ? await storeFile(req.file) : undefined
    const body = req.body || {}
    const fields = ['carrier', 'am_best_rating', 'policy_number', 'effective_date', 'expiration_date', 'status', 'reviewer_notes']
    const updates: string[] = []
    const params: any[] = []
    for (const field of fields) {
      if (body[field] != null) {
        updates.push(`${field} = ?`)
        params.push(body[field])
      }
    }
    if (stored) {
      updates.push('certificate_url = ?', 'certificate_key = ?', 'certificate_name = ?', 'certificate_size = ?', 'certificate_mime = ?')
      params.push(stored.url, stored.key, stored.filename, stored.size, stored.mime)
    }
    updates.push('updated_at = ?')
    params.push(new Date().toISOString(), req.params.id, req.user!.id, req.user!.id)
    const result = await dbRun(`UPDATE cois SET ${updates.join(', ')} WHERE id = ? AND ${writeAccessForUpdate}`, params)
    if (!result.changes) return res.status(404).json({ error: 'COI not found' })
    const updated = await dbGet(`SELECT c.* FROM cois c WHERE c.id = ? AND ${writeAccess}`,
      [req.params.id, req.user!.id, req.user!.id])
    if (!updated) return res.status(404).json({ error: 'COI not found' })
    res.json({ coi: await publicCOI(updated) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

function parseAnyDate(s?: string | null): Date | null {
  if (!s) return null
  const t = s.trim()
  const m1 = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const m2 = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/)
  if (m2) {
    const y = m2[3].length === 2 ? Number(`20${m2[3]}`) : Number(m2[3])
    const d = new Date(y, Number(m2[1]) - 1, Number(m2[2]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

async function applyComplianceReview(coiId: string, gcUserId: string, status: string, notes?: string | null) {
  const target = await dbGet<any>(
    `SELECT c.* FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
     WHERE c.id = ? AND ${readAccess}`,
    [coiId, gcUserId, gcUserId],
  )
  if (!target) return { ok: false as const, status: 404, error: 'COI not found' }
  if (status === 'compliant') {
    const exp = parseAnyDate(target.expiration_date)
    if (exp && exp.getTime() < Date.now()) {
      return { ok: false as const, status: 400, error: 'This certificate has expired and cannot be validated' }
    }
  }
  const now = new Date().toISOString()
  await dbRun(
    `UPDATE cois SET status = ?, reviewer_notes = COALESCE(?, reviewer_notes), review_date = ?, updated_at = ?
     WHERE id = ?`,
    [status, notes ?? null, now, now, coiId],
  )
  if (status === 'compliant') {
    const rev = await dbGet<{ details_json: string }>('SELECT details_json FROM coi_field_reviews WHERE coi_id = ?', [coiId])
    if (rev?.details_json) {
      try {
        const d = JSON.parse(rev.details_json)
        if (d.source === 'ocr' || d.source === 'mixed') {
          d.source = 'manual'
          await dbRun('UPDATE coi_field_reviews SET details_json = ? WHERE coi_id = ?', [JSON.stringify(d), coiId])
          await dbRun(
            `INSERT INTO coi_field_review_versions (coi_id, revision) VALUES (?, ?)
             ON CONFLICT(coi_id) DO UPDATE SET revision = excluded.revision`,
            [coiId, randomUUID()],
          )
        }
      } catch {}
    }
  }
  const updated = await dbGet<any>(
    `SELECT c.* FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
     WHERE c.id = ? AND ${readAccess}`,
    [coiId, gcUserId, gcUserId],
  )
  if (!updated) return { ok: false as const, status: 404, error: 'COI not found' }
  return { ok: true as const, coi: await publicCOI(updated) }
}

coisRouter.post('/:id/validate', async (req: AuthRequest, res) => {
  try {
    const r = await applyComplianceReview(req.params.id, req.user!.id, 'compliant', req.body?.notes)
    if (!r.ok) return res.status(r.status).json({ error: r.error })
    res.json({ coi: r.coi })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.put('/:id/review', async (req: AuthRequest, res) => {
  try {
    const { status, reviewer_notes } = req.body || {}
    if (!status || !['compliant', 'needs_revision', 'rejected', 'pending_review'].includes(status)) {
      return res.status(400).json({ error: 'Valid status required: compliant, needs_revision, rejected, pending_review' })
    }
    const r = await applyComplianceReview(req.params.id, req.user!.id, status, reviewer_notes)
    if (!r.ok) return res.status(r.status).json({ error: r.error })
    res.json({ coi: r.coi })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

coisRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const deleted = await deleteOwnedGcCOI(req.params.id, req.user!.id)
    if (!deleted) return res.status(404).json({ error: 'COI not found' })
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
