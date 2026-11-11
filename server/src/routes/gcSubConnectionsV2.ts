// Disconnected: callers must explicitly mount this router and supply trusted policies.
import express from 'express'
import type { Request, RequestHandler } from 'express'
import { CONSENT_V2, QR_CONSENT_V2_TEXT, INVITE_CONSENT_V2_TEXT, UnavailableError } from '../services/gcSubConsent.ts'
import type { gcSubConsentService } from '../services/gcSubConsent.ts'

type Principal = { subject: string; role: 'gc' | 'sub'; credential: string }
type Service = ReturnType<typeof gcSubConsentService>
type LimitedRequest = Request & { securePrincipal?: Principal }
export type ConnectionsV2Options = {
  service: Service
  // Must authenticate and bind subject, role and credential to the same verified identity.
  authenticate: RequestHandler
  // Shared, atomic limiter. Return exactly true to allow; false denies; throws fail closed.
  checkRateLimit: (input: { phase: 'preauth' | 'principal'; remoteAddress: string; subject?: string }) => Promise<boolean>
  // Independently authorizes the GC to target this known recipient; not UUID secrecy or name matching.
  authorizeInviteRecipient: (input: { gcSubject: string; profileId: string }) => Promise<boolean>
}

const unavailable = (res: express.Response) => res.status(404).json({ error: 'Unavailable' })
const fault = (res: express.Response) => res.status(503).json({ error: 'Unavailable' })
const validId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const validToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)
const validUser = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v)
function bodyHas(req: Request, fields: string[]): boolean {
  const b = req.body
  return b !== null && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === fields.length && fields.every(k => Object.hasOwn(b, k))
}
function principal(req: Request): Principal | undefined {
  const p = (req as LimitedRequest).securePrincipal
  return p && validUser(p.subject) && (p.role === 'gc' || p.role === 'sub') && typeof p.credential === 'string' && p.credential.length > 0 && p.credential.length <= 8192 ? p : undefined
}
async function deadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Policy timeout')), 2000) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export function createGcSubConnectionsV2Router(options: ConnectionsV2Options): express.Router {
  if (!options || !options.service || typeof options.authenticate !== 'function' || typeof options.checkRateLimit !== 'function' || typeof options.authorizeInviteRecipient !== 'function') throw new Error('Service, verified authentication, rate limiter and invitation recipient policy are required')
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, private')
    res.set('Pragma', 'no-cache')
    res.set('Referrer-Policy', 'no-referrer')
    res.set('X-Content-Type-Options', 'nosniff')
    next()
  })
  const limit = (phase: 'preauth' | 'principal'): RequestHandler => (req, res, next) => {
    const address = req.socket.remoteAddress
    const p = principal(req)
    if (!address || (phase === 'principal' && !p)) { fault(res); return }
    deadline(() => options.checkRateLimit({ phase, remoteAddress: address, ...(phase === 'principal' ? { subject: p!.subject } : {}) }))
      .then(ok => { if (ok === true) next(); else res.status(429).json({ error: 'Unavailable' }) }, () => { fault(res) })
  }
  router.use(limit('preauth'))
  // The API has no query parameters. Capabilities belong only in protected JSON bodies.
  router.use((req, res, next) => { if (req.url.includes('?')) { unavailable(res); return } next() })
  // Express 4 does not automatically catch rejected middleware promises.
  router.use((req, res, next) => {
    try {
      const result = options.authenticate(req, res, next) as unknown
      if (result && typeof (result as Promise<unknown>).then === 'function') Promise.resolve(result).catch(next)
    } catch (error) { next(error) }
  })
  router.use((req, res, next) => { if (!principal(req)) { res.status(401).json({ error: 'Unavailable' }); return } next() })
  router.use(limit('principal'))
  router.use(express.json({ limit: '4kb', strict: true, type: 'application/json' }))
  const route = (role: Principal['role'] | 'either', fn: (req: Request, p: Principal) => Promise<unknown>): RequestHandler => (req, res) => {
    const p = principal(req)!
    if (role !== 'either' && p.role !== role) { unavailable(res); return }
    Promise.resolve().then(() => fn(req, p)).then(result => {
      if (result === undefined) res.status(204).end()
      else res.status(200).json(result)
    }, error => { if (error instanceof UnavailableError) unavailable(res); else fault(res) })
  }
  const bad = (): never => { throw new UnavailableError() }

  router.get('/consent', route('either', async () => ({ version: CONSENT_V2, qrText: QR_CONSENT_V2_TEXT, invitationText: INVITE_CONSENT_V2_TEXT })))
  router.get('/profile', route('sub', async (_req, p) => options.service.getOwnProfile(p.credential)))
  router.post('/qr', route('sub', async (req, p) => {
    if (!bodyHas(req, ['profileId', 'consentVersion', 'affirmative']) || !validId(req.body.profileId) || req.body.consentVersion !== CONSENT_V2 || req.body.affirmative !== true) return bad()
    return options.service.issueSubQr(p.credential, req.body.profileId, req.body.consentVersion)
  }))
  router.post('/qr/redeem', route('gc', async (req, p) => {
    if (!bodyHas(req, ['token']) || !validToken(req.body.token)) return bad()
    await options.service.redeemSubQr(p.credential, req.body.token)
  }))
  router.post('/invitations', route('gc', async (req, p) => {
    if (!bodyHas(req, ['profileId']) || !validId(req.body.profileId)) return bad()
    if (await deadline(() => options.authorizeInviteRecipient({ gcSubject: p.subject, profileId: req.body.profileId })) !== true) return bad()
    return options.service.createGcInvite(p.credential, req.body.profileId)
  }))
  router.post('/invitations/preview', route('sub', async (req, p) => {
    if (!bodyHas(req, ['token']) || !validToken(req.body.token)) return bad()
    const invitation = await options.service.previewGcInvite(p.credential, req.body.token)
    return { invitation, consent: { version: CONSENT_V2, text: INVITE_CONSENT_V2_TEXT } }
  }))
  router.post('/invitations/accept', route('sub', async (req, p) => {
    if (!bodyHas(req, ['token', 'consentVersion', 'affirmative']) || !validToken(req.body.token) || req.body.consentVersion !== CONSENT_V2 || req.body.affirmative !== true) return bad()
    await options.service.acceptGcInvite(p.credential, req.body.token, req.body.consentVersion)
  }))
  router.post('/revoke', route('sub', async (req, p) => {
    if (!bodyHas(req, ['profileId', 'gcUserId']) || !validId(req.body.profileId) || !validUser(req.body.gcUserId)) return bad()
    await options.service.revoke(p.credential, req.body.profileId, req.body.gcUserId)
  }))
  router.get('/subcontractors', route('gc', async (_req, p) => ({ subcontractors: await options.service.listGrantedSubs(p.credential) })))
  router.post('/cois', route('gc', async (req, p) => {
    if (!bodyHas(req, ['profileId']) || !validId(req.body.profileId)) return bad()
    return { cois: await options.service.listGrantedCois(p.credential, req.body.profileId) }
  }))
  // Don't pass parser/auth errors or internals to callers; never log request data here.
  router.use((err: unknown, _req: Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) { next(err); return }
    fault(res)
  })
  router.use((_req, res) => { unavailable(res) })
  return router
}
