// Production-unmounted; the synthetic harness opts in explicitly. Callers must
// supply real createV2Auth.requireAuth and a shared fail-closed limiter.
import express from 'express'
import type { Request, RequestHandler } from 'express'
import type { V2AuthContext } from '../v2/auth.ts'
import { UnavailableError } from '../services/gcSubConsent.ts'
import { METADATA_CONSENT_V1, METADATA_CONSENT_V1_TEXT } from '../services/selfReportedCoiMetadata.ts'
import type { selfReportedCoiMetadataService } from '../services/selfReportedCoiMetadata.ts'

type Service = ReturnType<typeof selfReportedCoiMetadataService>
type Options = { service: Service; authenticate: RequestHandler; checkRateLimit: (input: { phase: 'preauth'|'principal'; remoteAddress: string; subject?: string }) => Promise<boolean> }
const bad = (): never => { throw new UnavailableError() }
const exact = (v: unknown, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k))
const failure = (res: express.Response, status = 404) => res.status(status).json({ error: 'Unavailable' })
function principal(res: express.Response): V2AuthContext | undefined {
  const p = res.locals.authV2 as V2AuthContext | undefined
  return p && typeof p.subject === 'string' && p.subject.length > 0 && p.subject.length <= 256 && p.subject === p.subject.trim() && !/[\u0000-\u001f\u007f]/.test(p.subject) && (p.role === 'gc' || p.role === 'sub') && typeof p.credential === 'string' && p.credential.length > 0 && p.credential.length <= 8192 ? p : undefined
}
async function deadline<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('timeout')),2000) })]) } finally { if (timer) clearTimeout(timer) }
}
export function createSelfReportedCoiMetadataV2Router(options: Options): express.Router {
  if (!options?.service || typeof options.authenticate !== 'function' || typeof options.checkRateLimit !== 'function') throw new Error('Service, auth-v2 authentication and shared rate limiter required')
  const router = express.Router()
  router.use((_req,res,next) => { res.set('Cache-Control','no-store, private'); res.set('Pragma','no-cache'); res.set('Referrer-Policy','no-referrer'); res.set('X-Content-Type-Options','nosniff'); next() })
  const limit = (phase: 'preauth'|'principal'): RequestHandler => (req,res,next) => {
    const remoteAddress = req.socket.remoteAddress, p = principal(res)
    if (!remoteAddress || (phase==='principal' && !p)) { failure(res,503); return }
    deadline(() => options.checkRateLimit({phase,remoteAddress,...(phase==='principal' ? {subject:p!.subject} : {})})).then(ok => { if (ok === true) next(); else failure(res,429) }, () => { failure(res,503) })
  }
  router.use(limit('preauth'))
  router.use((req,res,next) => { if (req.url.includes('?')) { failure(res); return } next() })
  router.use((req,res,next) => {
    delete res.locals.authV2
    try { const result = options.authenticate(req,res,next) as unknown; if (result && typeof (result as Promise<unknown>).then === 'function') Promise.resolve(result).catch(next) } catch (e) { next(e) }
  })
  router.use((_req,res,next) => { if (!principal(res)) { failure(res,401); return } next() })
  router.use(limit('principal'))
  router.use(express.json({limit:'4kb',strict:true,type:'application/json'}))
  const route = (role: 'sub'|'gc'|'either', fn: (req: Request,p: V2AuthContext) => Promise<unknown>): RequestHandler => (req,res) => {
    const p = principal(res)!
    if (role !== 'either' && p.role !== role) { failure(res); return }
    Promise.resolve().then(() => fn(req,p)).then(value => { if (value === undefined) res.status(204).end(); else res.json(value) }, err => { failure(res,err instanceof UnavailableError ? 404 : 503) })
  }
  router.get('/consent',route('either',async () => ({version:METADATA_CONSENT_V1,text:METADATA_CONSENT_V1_TEXT})))
  router.get('/own',route('sub',async (_req,p) => ({records:await options.service.listOwn(p.credential)})))
  router.get('/connected-gcs',route('sub',async (_req,p) => ({generalContractors:await options.service.listConnectedGcs(p.credential)})))
  router.post('/own',route('sub',async (req,p) => options.service.create(p.credential,req.body)))
  router.post('/grant',route('sub',async (req,p) => {
    if (!exact(req.body,['coiId','gcUserId','consentVersion','affirmative'])) return bad()
    await options.service.grant(p.credential,req.body.coiId,req.body.gcUserId,req.body.consentVersion,req.body.affirmative)
  }))
  router.post('/revoke',route('sub',async (req,p) => {
    if (!exact(req.body,['coiId','gcUserId'])) return bad()
    await options.service.revoke(p.credential,req.body.coiId,req.body.gcUserId)
  }))
  router.get('/granted',route('gc',async (_req,p) => ({records:await options.service.listGranted(p.credential)})))
  router.use((_err: unknown,_req: Request,res: express.Response,next: express.NextFunction) => { if (res.headersSent) { next(_err); return } failure(res,503) })
  router.use((_req,res) => { failure(res) })
  return router
}
