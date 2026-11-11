import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dbExec, initDatabase, isPostgres } from './db/db.ts'
import { LOCAL_UPLOADS, isS3Configured } from './services/storage.ts'
import { privateCertificateEnvironmentSafe } from './services/privateCertificatePrototype.ts'
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
import { stagedInvitationsRouter } from './routes/stagedInvitations.ts'
import { relationshipPrototypeRouter } from './routes/relationshipPrototype.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function createApp() {
  await initDatabase()
  if (privateCertificateEnvironmentSafe()) await dbExec(`
    CREATE TABLE IF NOT EXISTS prototype_certificate_grants (
      gc_user_id TEXT NOT NULL, sub_user_id TEXT NOT NULL, sub_profile_id TEXT NOT NULL,
      relationship_source_id TEXT NOT NULL, consent_version TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)), granted_at TEXT NOT NULL, revoked_at TEXT,
      PRIMARY KEY (gc_user_id, sub_user_id)
    )
  `)

  const app = express()
  app.use(cors({ origin: true, credentials: true }))
  // Parse invitation bodies separately: never log parser errors containing
  // raw bearer capabilities, and bound unauthenticated request sizes.
  app.use('/api/invitations', express.json({ limit: '4kb' }), (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.set('Cache-Control', 'no-store').status(err.status === 413 ? 413 : 400).json({ error: 'Invalid request body' })
  })
  app.use('/api/relationship-prototype', express.json({ limit: '4kb' }), (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.set('Cache-Control', 'no-store').status(err.status === 413 ? 413 : 400).json({ error: 'Invalid request body' })
  })
  app.use(express.json({ limit: '10mb' }))

  fs.mkdirSync(LOCAL_UPLOADS, { recursive: true })
  app.use('/uploads', express.static(LOCAL_UPLOADS))

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: isPostgres ? 'postgresql' : 'sqlite',
      storage: isS3Configured ? 's3' : 'local',
      time: new Date().toISOString(),
    })
  })

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
  app.use('/api/invitations', stagedInvitationsRouter)
  app.use('/api/relationship-prototype', relationshipPrototypeRouter)

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
