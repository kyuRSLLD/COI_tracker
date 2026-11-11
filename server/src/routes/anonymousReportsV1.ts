// Deliberately disconnected from every application and startup path.
import { createHash, randomBytes } from 'node:crypto'
import express from 'express'
import type { ErrorRequestHandler, RequestHandler, Request } from 'express'
import type pg from 'pg'
import { z } from 'zod'
import { withOwnerV2Transaction, OwnerV2AuthError, OwnerV2RoleError } from '../services/ownerWrites.ts'

const scope = 'anonymous-report:v1'
const projectId = z.string().uuid()
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(s => {
  const b = Buffer.from(s, 'base64url')
  return b.length === 32 && b.toString('base64url') === s
})
const createSchema = z.object({ project_id: projectId, scope: z.literal(scope), ttl_seconds: z.number().int().min(60).max(604800) }).strict()
const revokeSchema = z.object({ project_id: projectId, scope: z.literal(scope), token }).strict()
const redeemSchema = z.object({ token }).strict()
const hash = (s: string) => createHash('sha256').update(s, 'ascii').digest()

type Principal = { subject: string; role: string; credential: string }
type PrincipalRequest = Request & { securePrincipal?: Principal }
const notFound = (res: express.Response) => res.status(404).json({ error: 'Not found' })
const invalid = (res: express.Response) => res.status(400).json({ error: 'Invalid request' })

/**
 * The authenticate dependency must verify the exact auth-v2 JWT and pin securePrincipal,
 * as documented by GC_OWNER_V2_ROUTER.md. No capability is an authentication credential.
 * A non-true enabled value makes every path return 404 without touching the pool.
 */
export function createAnonymousReportsV1Router(options: { enabled?: boolean; pool?: pg.Pool; authenticate?: RequestHandler } = {}): express.Router {
  const router = express.Router()
  router.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" })
    // Even harmless query strings are denied, to prohibit capability-in-query use.
    if (!options.enabled || req.originalUrl.includes('?')) { notFound(res); return }
    next()
  })
  if (options.enabled !== true) { router.use((_req, res) => { notFound(res) }); return router }
  const pool = options.pool, authenticate = options.authenticate
  if (!pool || typeof pool.connect !== 'function' || typeof authenticate !== 'function') throw new TypeError('A PostgreSQL pool and verified auth middleware are required')
  router.use((req, res, next) => {
    if (req.method !== 'POST' || !['/owner/create', '/owner/revoke', '/redeem'].includes(req.path)) { notFound(res); return }
    if (!req.is('application/json')) { res.status(415).json({ error: 'Invalid request' }); return }
    next()
  })
  router.use(express.json({ limit: '8kb', strict: true, inflate: false }))
  const auth: RequestHandler = (req, res, next) => {
    // A trusted verifier must authenticate correctly; this gate only prevents
    // Express control-flow escape and advancing after a response or twice.
    let called = false
    const safeNext: typeof next = (err?: any) => {
      if (called || res.headersSent) return
      called = true
      if (err === 'route' || err === 'router') next(new Error('Invalid middleware control flow'))
      else next(err)
    }
    try { Promise.resolve(authenticate(req, res, safeNext)).catch(safeNext) } catch (e) { safeNext(e) }
  }
  const owner: RequestHandler = (req, res, next) => {
    const p = (req as PrincipalRequest).securePrincipal
    if (!p || typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > 500 || typeof p.credential !== 'string' || !p.credential) {
      res.status(401).json({ error: 'Authentication required' }); return
    }
    if (p.role !== 'gc') { notFound(res); return }
    res.locals.reportPrincipal = Object.freeze({ subject: p.subject, credential: p.credential })
    next()
  }
  const ownerAction = (schema: z.ZodTypeAny, action: (c: pg.PoolClient, subject: string, data: any) => Promise<{ status: number; body?: unknown }>): RequestHandler => (req, res) => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) { invalid(res); return }
    void (async () => {
      let c: pg.PoolClient | undefined
      try {
        c = await pool.connect()
        const p = res.locals.reportPrincipal as Readonly<{ subject: string; credential: string }>
        const result = await withOwnerV2Transaction(c, p, async () => action(c!, p.subject, parsed.data))
        c.release(); c = undefined
        if (result.status === 204) res.status(204).end()
        else res.status(result.status).json(result.body)
      } catch (err) {
        if (err instanceof OwnerV2AuthError) res.status(401).json({ error: 'Authentication required' })
        else if (err instanceof OwnerV2RoleError) notFound(res)
        else res.status(503).json({ error: 'Service unavailable' })
        if (c) { try { c.release(true) } catch {} }
      }
    })()
  }
  const projectOwned = async (c: pg.PoolClient, subject: string, id: string, requireEnabled: boolean) => {
    const r = await c.query('SELECT enabled FROM report_v1_projects WHERE id=$1 AND owner_user_id=$2 FOR SHARE', [id, subject])
    return !!r.rowCount && (!requireEnabled || r.rows[0].enabled === true)
  }
  router.post('/owner/create', auth, owner, ownerAction(createSchema, async (c, subject, data) => {
    if (!await projectOwned(c, subject, data.project_id, true)) return { status: 404, body: { error: 'Not found' } }
    const secret = randomBytes(32).toString('base64url')
    const r = await c.query(`WITH t AS (SELECT clock_timestamp() AS now)
      INSERT INTO report_v1_capabilities(token_hash,project_id,scope,created_at,expires_at)
      SELECT $1,$2,$3,t.now,t.now + ($4 * interval '1 second') FROM t RETURNING expires_at`,
      [hash(secret), data.project_id, scope, data.ttl_seconds])
    return { status: 201, body: { token: secret, scope, expires_at: (r.rows[0].expires_at as Date).toISOString() } }
  }))
  router.post('/owner/revoke', auth, owner, ownerAction(revokeSchema, async (c, subject, data) => {
    if (!await projectOwned(c, subject, data.project_id, false)) return { status: 404, body: { error: 'Not found' } }
    const r = await c.query(`UPDATE report_v1_capabilities SET revoked_at=clock_timestamp()
      WHERE token_hash=$1 AND project_id=$2 AND scope=$3 AND revoked_at IS NULL RETURNING token_hash`, [hash(data.token), data.project_id, scope])
    return r.rowCount ? { status: 204 } : { status: 404, body: { error: 'Not found' } }
  }))
  router.post('/redeem', (req, res) => {
    const parsed = redeemSchema.safeParse(req.body)
    if (!parsed.success) { invalid(res); return }
    void (async () => {
      let c: pg.PoolClient | undefined, begun = false
      try {
        c = await pool.connect()
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); begun = true
        const h = hash(parsed.data.token)
        // Unlocked discovery is not authorization. Recheck all rows under locks below.
        const lookup = await c.query(`SELECT p.id,p.owner_user_id FROM report_v1_capabilities t
          JOIN report_v1_projects p ON p.id=t.project_id WHERE t.token_hash=$1`, [h])
        let allowed = false, members: { label: string; status: string }[] = []
        if (lookup.rowCount) {
          const { id, owner_user_id: subject } = lookup.rows[0]
          // Lock order: user, account, project, capability; same order as owner operations.
          const u = await c.query('SELECT role FROM users WHERE id=$1 FOR SHARE', [subject])
          const a = await c.query('SELECT enabled,email_verified_at FROM auth_v2_accounts WHERE user_id=$1 FOR SHARE', [subject])
          const p = await c.query('SELECT owner_user_id,enabled FROM report_v1_projects WHERE id=$1 FOR SHARE', [id])
          const t = await c.query('SELECT project_id,scope,revoked_at FROM report_v1_capabilities WHERE token_hash=$1 FOR SHARE', [h])
          allowed = !!u.rowCount && u.rows[0].role === 'gc' && !!a.rowCount && a.rows[0].enabled === true && !!a.rows[0].email_verified_at &&
            !!p.rowCount && p.rows[0].enabled === true && p.rows[0].owner_user_id === subject && !!t.rowCount &&
            t.rows[0].project_id === id && t.rows[0].scope === scope && t.rows[0].revoked_at === null
          if (allowed) {
            const rows = await c.query('SELECT label,status FROM report_v1_members WHERE project_id=$1 ORDER BY label LIMIT 501', [id])
            if (rows.rowCount! > 500) throw new Error('report capacity exceeded')
            // Explicitly project every nested field and validate DB values; never copy a row or object.
            members = rows.rows.map(row => {
              if (typeof row.label !== 'string' || !/^Member-[0-9a-f]{32}$/.test(row.label) || !['compliant','noncompliant','pending','unknown'].includes(row.status)) throw new Error('invalid report row')
              return { label: row.label, status: row.status }
            })
            const live = await c.query(`SELECT 1 FROM report_v1_capabilities WHERE token_hash=$1 AND project_id=$2
              AND scope=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [h, id, scope])
            allowed = !!live.rowCount
          }
        }
        await c.query('COMMIT'); begun = false
        c.release(); c = undefined
        if (!allowed) { notFound(res); return }
        res.json({ schema: 'anonymous-report-v1', members })
      } catch {
        if (c) { if (begun) { try { await c.query('ROLLBACK') } catch {} } try { c.release(true) } catch {} }
        if (!res.headersSent) res.status(503).json({ error: 'Service unavailable' })
      }
    })()
  })
  router.use((_req, res) => { notFound(res) })
  const errors: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) { next(err); return }
    if (err?.type === 'entity.too.large') res.status(413).json({ error: 'Invalid request' })
    else if (err?.type === 'entity.parse.failed') invalid(res)
    else if (err?.type === 'encoding.unsupported') res.status(415).json({ error: 'Invalid request' })
    else res.status(503).json({ error: 'Service unavailable' })
  }
  router.use(errors)
  return router
}
