// Composable only: intentionally not imported by app.ts or startup.
import express from 'express'
import type { Request, Response, RequestHandler, ErrorRequestHandler } from 'express'
import type pg from 'pg'
import { postgresOwnerConnection } from '../db/ownerConnection.ts'
import { ownerReads } from '../services/ownerReads.ts'
import { ownerWrites, OwnerWriteError } from '../services/ownerWrites.ts'

/** Established ONLY by the trusted, credential-verifying middleware, never request data. */
export type SecurePrincipal = Readonly<{
  subject: string
  role: 'gc' | 'sub' | 'admin'
  credential: string
}>
type PrincipalRequest = Request & { securePrincipal?: SecurePrincipal }

type RouterOptions = {
  pool: pg.Pool
  authenticate: RequestHandler
}
type Action = (req: Request, db: ReturnType<typeof postgresOwnerConnection>, subject: string) => Promise<{ status: number; body: unknown }>

const missing = () => ({ status: 404, body: { error: 'Not found' } })
const found = (value: unknown) => value === undefined ? missing() : { status: 200, body: value }
const created = (value: unknown) => value === undefined ? missing() : { status: 201, body: value }
const receipt = (value: { id: string } | undefined) => value && { id: value.id }

// Re-project even the already-minimal service result so future service additions
// cannot silently expose certificate locations, credentials, or client data.
function subView(s: Awaited<ReturnType<ReturnType<typeof ownerReads>['getSubcontractor']>>) {
  if (!s) return undefined
  return { id: s.id, company_name: s.company_name, trade: s.trade, contact_person: s.contact_person,
    phone: s.phone, email: s.email, status: s.status }
}
function coiView(c: Awaited<ReturnType<ReturnType<typeof ownerReads>['getCoi']>>) {
  if (!c) return undefined
  return { id: c.id, subcontractor_id: c.subcontractor_id, carrier: c.carrier,
    effective_date: c.effective_date, expiration_date: c.expiration_date, status: c.status }
}

/**
 * The trusted middleware MUST authenticate credentials and set an immutable
 * securePrincipal before next(). It must reject invalid credentials itself.
 * This factory cannot verify that middleware and does not implement sessions.
 */
export function createGcOwnerV2Router({ pool, authenticate }: RouterOptions): express.Router {
  if (!pool || typeof pool.connect !== 'function' || typeof authenticate !== 'function') {
    throw new TypeError('A PostgreSQL pool and trusted authentication middleware are required')
  }
  const router = express.Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(authenticate)
  // Capture immutable primitive values immediately. Neither a request ID nor an
  // owner/role supplied in a body, URL or header is an authentication source.
  router.use((req, res, next) => {
    const p = (req as PrincipalRequest).securePrincipal
    if (!p || typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > 500 ||
        typeof p.credential !== 'string' || !p.credential.trim() ||
        !['gc', 'sub', 'admin'].includes(p.role)) {
      res.status(401).json({ error: 'Authentication required' }); return
    }
    if (p.role !== 'gc') { res.status(404).json({ error: 'Not found' }); return }
    res.locals.gcOwnerSubject = p.subject
    next()
  })
  router.use(express.json({ limit: '64kb', strict: true }))

  const handle = (action: Action): RequestHandler => (req, res) => {
    void (async () => {
      let client: pg.PoolClient | undefined
      let destroy = false
      try {
        client = await pool.connect()
        const db = postgresOwnerConnection(client)
        const subject = res.locals.gcOwnerSubject as string
        // Needed to distinguish a revoked/unknown GC from an authorized empty
        // collection. Services independently re-check live role for each operation.
        const role = await db.query<{ id: string }>("SELECT id FROM users WHERE id = ? AND role = 'gc'", [subject])
        const result = role.length ? await action(req, db, subject) : missing()
        // Release before responding so a release failure cannot result in success.
        client.release(); client = undefined
        res.status(result.status).json(result.body)
      } catch (error) {
        destroy = true
        if (!res.headersSent) {
          if (error instanceof OwnerWriteError && error.code === 'INVALID_INPUT') {
            res.status(400).json({ error: 'Invalid input' })
          } else {
            res.status(503).json({ error: 'Service unavailable' })
          }
        }
      } finally {
        if (client) {
          // Any error, especially an uncertain write/rollback/commit, poisons the
          // session. Never return it to the pool or retry an uncertain operation.
          try { client.release(destroy) } catch { /* Do not reveal driver details. */ }
        }
      }
    })()
  }

  router.get('/subcontractors', handle(async (_req, db, subject) => ({
    status: 200, body: (await ownerReads(db, subject).listSubcontractors()).map(subView),
  })))
  router.get('/subcontractors/:id', handle(async (req, db, subject) => found(subView(await ownerReads(db, subject).getSubcontractor(req.params.id)))))
  router.post('/subcontractors', handle(async (req, db, subject) => created(receipt(await ownerWrites(db, subject).createSubcontractor(req.body)))))
  router.patch('/subcontractors/:id', handle(async (req, db, subject) => {
    if (!await ownerReads(db, subject).getSubcontractor(req.params.id)) return missing()
    return found(receipt(await ownerWrites(db, subject).updateSubcontractor(req.params.id, req.body)))
  }))
  router.get('/subcontractors/:id/cois', handle(async (req, db, subject) => {
    const reads = ownerReads(db, subject)
    if (!await reads.getSubcontractor(req.params.id)) return missing()
    return { status: 200, body: (await reads.listCois(req.params.id)).map(coiView) }
  }))
  router.post('/subcontractors/:id/cois', handle(async (req, db, subject) => {
    if (!await ownerReads(db, subject).getSubcontractor(req.params.id)) return missing()
    // Parent ID is exclusively the path value; do not let a body override it.
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.prototype.hasOwnProperty.call(req.body, 'subcontractor_id')) {
      throw new OwnerWriteError('INVALID_INPUT')
    }
    return created(receipt(await ownerWrites(db, subject).createCoi({ ...req.body, subcontractor_id: req.params.id })))
  }))
  router.get('/cois/:id', handle(async (req, db, subject) => found(coiView(await ownerReads(db, subject).getCoi(req.params.id)))))
  router.patch('/cois/:id', handle(async (req, db, subject) => {
    if (!await ownerReads(db, subject).getCoi(req.params.id)) return missing()
    return found(receipt(await ownerWrites(db, subject).updateCoi(req.params.id, req.body)))
  }))
  // Including DELETE: no global deletion, no fallthrough to another router.
  router.use((_req, res) => { res.status(404).json({ error: 'Not found' }) })

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { _next(error); return }
    // Never reflect middleware, parser, database, or driver error details.
    if (error?.type === 'entity.parse.failed') res.status(400).json({ error: 'Invalid input' })
    else if (error?.type === 'entity.too.large') res.status(413).json({ error: 'Invalid input' })
    else res.status(503).json({ error: 'Service unavailable' })
  }
  router.use(errors)
  return router
}
