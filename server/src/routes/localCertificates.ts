import express from 'express'
import fs from 'fs'
import path from 'path'
import { dbGet } from '../db/db.ts'
import { requireAuth, type AuthRequest } from '../middleware/auth.ts'
import { isS3Configured, LOCAL_UPLOADS } from '../services/storage.ts'

// This endpoint is never a fallback for production or S3. The local filename
// is an identifier, not a bearer capability: every read rechecks current access.
export const localCertificatesRouter = express.Router()
localCertificatesRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store')
  res.set('X-Content-Type-Options', 'nosniff')
  next()
})
localCertificatesRouter.use((_req, res, next) => {
  if (process.env.NODE_ENV === 'production' || isS3Configured) return res.status(404).json({ error: 'Not found' })
  next()
})
localCertificatesRouter.get('/:key', requireAuth, async (req: AuthRequest, res) => {
  const key = req.params.key
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key) || key.length > 255) {
    return res.status(404).json({ error: 'Not found' })
  }

  try {
    const user = req.user!
    let row: unknown
    if (user.role === 'gc') {
      // Match the GC COI read policy: a connection, and either the GC owns
      // the record or the currently linked sub user owns it.
      row = await dbGet(`SELECT c.id FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
        WHERE c.certificate_key = ? AND EXISTS (SELECT 1 FROM gc_sub_connections g
          WHERE g.subcontractor_id = c.subcontractor_id AND g.gc_user_id = ?)
        AND (c.owner_gc_user_id = ? OR (c.owner_gc_user_id IS NULL
          AND s.user_id IS NOT NULL AND c.owner_sub_user_id = s.user_id)) LIMIT 1`, [key, user.id, user.id])
    } else if (user.role === 'sub') {
      // Match /api/sub/my, including its deterministic primary profile.
      row = await dbGet(`SELECT c.id FROM cois c JOIN subcontractors s ON s.id = c.subcontractor_id
        WHERE c.certificate_key = ? AND s.id = (SELECT id FROM subcontractors
          WHERE user_id = ? ORDER BY created_at, id LIMIT 1)
        AND ((c.owner_gc_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM gc_sub_connections g
          WHERE g.gc_user_id = c.owner_gc_user_id AND g.subcontractor_id = c.subcontractor_id))
          OR (c.owner_gc_user_id IS NULL AND c.owner_sub_user_id = ?)) LIMIT 1`, [key, user.id, user.id])
    }
    if (!row) return res.status(404).json({ error: 'Not found' })

    // Refuse symlinks, non-files, and path traversal. Open once so authorization
    // is followed by streaming the same descriptor, never a later pathname.
    const file = await fs.promises.open(path.join(LOCAL_UPLOADS, key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let regular = false
    try { regular = (await file.stat()).isFile() } catch { /* handled below */ }
    if (!regular) {
      await file.close()
      return res.status(404).json({ error: 'Not found' })
    }
    res.set('Content-Type', 'application/octet-stream')
    res.set('Content-Disposition', 'attachment')
    res.set('Content-Security-Policy', "default-src 'none'; sandbox")
    const stream = file.createReadStream()
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ error: 'Not found' })
      else res.destroy()
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch {
    // Do not log keys, paths, SQL, tokens, or driver errors.
    if (!res.headersSent) res.status(404).json({ error: 'Not found' })
    else res.destroy()
  }
})
localCertificatesRouter.use((_req, res) => res.status(404).json({ error: 'Not found' }))
