import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { initDatabase, isPostgres } from './db/db.ts'
import { LOCAL_UPLOADS, isS3Configured } from './services/storage.ts'
import { authRouter } from './routes/auth.ts'
import { subcontractorsRouter } from './routes/subcontractors.ts'
import { coisRouter } from './routes/cois.ts'
import { projectsRouter } from './routes/projects.ts'
import { clientViewRouter } from './routes/clientView.ts'
import { uploadPortalRouter } from './routes/uploadPortal.ts'
import { statsRouter } from './routes/stats.ts'
import { emailsRouter } from './routes/emails.ts'
import { settingsRouter } from './routes/settings.ts'
import { adminRouter } from './routes/admin.ts'
import { subPortalRouter } from './routes/subPortal.ts'
import { subConnectionQrRouter } from './routes/subConnectionQr.ts'
import { localCertificatesRouter } from './routes/localCertificates.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Deployment switch. Set true and redeploy if protected routes must be paused.
// Changing this requires a code deployment; no environment variable can disable it.
export const MAINTENANCE_MODE = false

export async function createApp({ maintenanceMode = MAINTENANCE_MODE }: { maintenanceMode?: boolean } = {}) {
  // Existing initialization includes schema changes and a backfill. Do not run it
  // during maintenance; the health endpoint reports configuration, not DB readiness.
  if (!maintenanceMode) await initDatabase()

  const app = express()
  // Includes parser failures, 404s, and authentication errors on this path.
  app.use('/api/connection-qr', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use(cors({ origin: true, credentials: true, preflightContinue: maintenanceMode }))

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: isPostgres ? 'postgresql' : 'sqlite',
      storage: isS3Configured ? 's3' : 'local',
      time: new Date().toISOString(),
    })
  })

  if (maintenanceMode) {
    // Keep health preflight available, but reject preflights to protected paths.
    app.options('/api/health', cors({ origin: true, credentials: true }))
    app.use(['/api', '/uploads'], (_req, res) => {
      res.set('Cache-Control', 'no-store')
      res.status(503).json({ error: 'Service temporarily unavailable for maintenance.' })
    })
    // Preserve normal preflight behavior for public non-API paths.
    app.options('*', cors({ origin: true, credentials: true }))
  }

  app.use(express.json({ limit: '10mb' }))
  if (!maintenanceMode) fs.mkdirSync(LOCAL_UPLOADS, { recursive: true })
  // Even development storage contains private certificates. Never serve it statically.
  app.use('/uploads', localCertificatesRouter)

  app.use('/api/auth', authRouter)
  app.use('/api/subcontractors', subcontractorsRouter)
  app.use('/api/cois', coisRouter)
  app.use('/api/projects', projectsRouter)
  app.use('/api/client/share', clientViewRouter)
  app.use('/api/upload', uploadPortalRouter)
  app.use('/api/stats', statsRouter)
  app.use('/api/emails', emailsRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/staff', adminRouter)
  app.use('/api/sub', subPortalRouter)
  app.use('/api/connection-qr', subConnectionQrRouter)
  // Express's default 404 echoes the path, which may contain a pasted token.
  app.use('/api/connection-qr', (_req, res) => res.status(404).json({ error: 'Not found' }))

  const clientDist = path.resolve(__dirname, '../../client/dist')
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next()
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Body-parser errors can include the raw request body, including tokens.
    const errorPath = _req.path.toLowerCase()
    if (errorPath.startsWith('/api/sub/join') || errorPath === '/api/connection-qr' || errorPath.startsWith('/api/connection-qr/') ||
        errorPath === '/uploads' || errorPath.startsWith('/uploads/')) {
      const status = err?.status === 400 || err?.status === 413 ? err.status : 500
      return res.status(status).json({ error: status === 500 ? 'Unable to process request' : 'Invalid request' })
    }
    console.error('[error]', err)
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
  })

  return app
}
