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

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Deployment switch: keep true until an approved security fix is ready.
// Changing this requires a code deployment; no environment variable can disable it.
export const MAINTENANCE_MODE = true

export async function createApp({ maintenanceMode = MAINTENANCE_MODE }: { maintenanceMode?: boolean } = {}) {
  // Existing initialization includes schema changes and a backfill. Do not run it
  // during maintenance; the health endpoint reports configuration, not DB readiness.
  if (!maintenanceMode) await initDatabase()

  const app = express()
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
  app.use('/uploads', express.static(LOCAL_UPLOADS))

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

  const clientDist = path.resolve(__dirname, '../../client/dist')
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next()
      res.sendFile(path.join(clientDist, 'index.html'))
    })
  }

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err)
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
  })

  return app
}
