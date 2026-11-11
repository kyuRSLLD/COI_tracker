// Synthetic integration harness ONLY. Never import from app.ts/index.ts or deploy.
// A test environment marker and URL checks are guardrails, not proof of isolation.
import express from 'express'
import type { Request, RequestHandler } from 'express'
import pg from 'pg'
import { createSecureV2App } from './secure-v2-app.ts'
import { createVerifiedPrincipalAdapter } from './verified-v2-principal.ts'
export { createVerifiedPrincipalAdapter } from './verified-v2-principal.ts'
import { createV2Auth } from './v2/auth.ts'
import type { V2AuthConfig, V2AuthContext } from './v2/auth.ts'
import { createV2Registration } from './v2/registration.ts'
import type { RegistrationRateLimiter } from './v2/registration.ts'
import { createSesRegistrationDelivery } from './v2/sesRegistrationDelivery.ts'
import { createGcOwnerV2Router } from './routes/gcOwnerV2.ts'
import { createGcSubConnectionsV2Router } from './routes/gcSubConnectionsV2.ts'
import { privateCertificatesRouter } from './routes/privateCertificates.ts'
import { createSelfReportedCoiMetadataV2Router } from './routes/selfReportedCoiMetadataV2.ts'
import { createSelfReportedPrivateFilesV2Router } from './routes/selfReportedPrivateFilesV2.ts'
import { gcSubConsentService } from './services/gcSubConsent.ts'
import { selfReportedCoiMetadataService } from './services/selfReportedCoiMetadata.ts'
import { selfReportedPrivateFileService } from './services/selfReportedPrivateFiles.ts'
import type { PrivateFileInspector, ImmutablePrivateStorage } from './services/selfReportedPrivateFiles.ts'
import { PrivateCertificateStorage } from './services/privateCertificateStorage.ts'
import type { PrivateS3Transport } from './services/privateCertificateStorage.ts'

type LimitInput = { scope: 'auth' | 'protected' | 'connections-router' | 'metadata-router' | 'files-router'; phase: 'preauth' | 'principal'; remoteAddress: string; subject?: string }
type Options = {
  pool: pg.Pool
  authConfig: V2AuthConfig
  // Test callback only; NOT an implementation of production rate limiting.
  testRateLimit?: (input: LimitInput) => Promise<boolean>
  // Both are explicit synthetic seams; absence of either disables registration.
  testRegistrationRateLimit?: RegistrationRateLimiter['allow']
  unsafeTestOnlyMockSes?: NonNullable<Parameters<typeof createSesRegistrationDelivery>[1]>
  // Unsafe opt-in is for controlled synthetic HTTP tests, never production.
  unsafeTestOnlyEnableConsent?: boolean
  unsafeTestOnlyEnableMetadata?: boolean
  testAuthorizeInviteRecipient?: (input: { gcSubject: string; profileId: string }) => Promise<boolean>
  unsafeTestOnlyMockS3?: PrivateS3Transport
  unsafeTestOnlyPrivateFiles?: { inspector: PrivateFileInspector; storage: ImmutablePrivateStorage; maxFileBytes: number; uploadDeadlineMs: number }
}
type PrincipalRequest = Request & { securePrincipal?: Readonly<V2AuthContext> }
const reject: RequestHandler = (_req, res) => { res.status(401).json({ error: 'Authentication required' }) }

function validatePool(pool: pg.Pool) {
  if (!(pool instanceof pg.Pool) || typeof pool.options.connectionString !== 'string') throw new Error('Synthetic loopback pool required')
  const u = new URL(pool.options.connectionString)
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || u.hostname !== '127.0.0.1' || !u.port || !/^\/secure_v2_test_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error('Explicit disposable loopback secure_v2_test_* database required')
  // pg options can override the URL; reject alternate host/database or TLS routing.
  const p = pool.options as pg.PoolConfig
  if ((p.host && p.host !== '127.0.0.1') || (p.database && p.database !== u.pathname.slice(1)) || (p.port && Number(p.port) !== Number(u.port)) || p.ssl) throw new Error('Conflicting pool options')
}
function withDeadline<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2000) })]).finally(() => clearTimeout(timer))
}

/** Constructs but never listens, initializes a database, reads production config or contacts S3. */
export function createSecureV2SyntheticTestApp(options: Options) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Synthetic test harness requires NODE_ENV=test')
  validatePool(options.pool)
  const auth = createV2Auth(options.pool, options.authConfig)
  const adapter = createVerifiedPrincipalAdapter(auth.requireAuth)
  const limit = async (input: LimitInput) => options.testRateLimit ? await withDeadline(() => options.testRateLimit!(input)) : false
  const middlewareLimit = (scope: LimitInput['scope'], phase: LimitInput['phase']): RequestHandler => (req, res, next) => {
    const remoteAddress = req.socket.remoteAddress
    const subject = phase === 'principal' ? (res.locals.authV2 as V2AuthContext | undefined)?.subject : undefined
    if (!remoteAddress || (phase === 'principal' && !subject) || !options.testRateLimit) { res.status(503).json({ error: 'Unavailable' }); return }
    limit({ scope, phase, remoteAddress, ...(subject ? { subject } : {}) }).then(allowed => {
      if (allowed === true) next(); else res.status(429).json({ error: 'Unavailable' })
    }, () => { res.status(503).json({ error: 'Unavailable' }) })
  }
  const authRouter = express.Router()
  const delivery = options.unsafeTestOnlyMockSes
    ? createSesRegistrationDelivery({ region: 'us-east-1', fromEmailAddress: 'verify@example.test', timeoutMs: 1000 }, options.unsafeTestOnlyMockSes)
    : undefined
  const registration = createV2Registration(options.pool, {
    delivery,
    rateLimiter: options.testRegistrationRateLimit
      ? { allow: input => withDeadline(() => options.testRegistrationRateLimit!(input)) }
      : undefined,
  })
  authRouter.use(middlewareLimit('auth', 'preauth'))
  // Scope the registration parser and handlers to the two canonical paths only;
  // the auth router still owns login, logout and its disabled /register placeholder.
  authRouter.use((req, res, next) => {
    if (req.method === 'POST' && (req.path === '/register/request' || req.path === '/register/confirm')) return registration(req, res, next)
    next()
  })
  authRouter.use(auth.router)
  const gcRouter = createGcOwnerV2Router({ pool: options.pool, authenticate: adapter })
  // Default off, synthetic-only: transactional consent session enforcement does
  // not resolve the remaining owner/file and production-readiness blockers.
  const connectionsRouter = options.unsafeTestOnlyEnableConsent === true
    ? createGcSubConnectionsV2Router({
      service: gcSubConsentService(options.pool, { publicKey: options.authConfig.publicKey, issuer: options.authConfig.issuer, audience: options.authConfig.audience }),
      authenticate: adapter,
      checkRateLimit: input => limit({ scope: 'connections-router', ...input }),
      authorizeInviteRecipient: options.testAuthorizeInviteRecipient ?? (async () => false),
    }) : undefined
  const certificatesRouter = options.unsafeTestOnlyMockS3
    ? privateCertificatesRouter({ enabled: true, pool: options.pool, verifiedMiddleware: adapter,
      makeStorage: ({ records, authorize }) => new PrivateCertificateStorage({ enabled: true, bucket: 'synthetic-private-test', records, authorize, s3: options.unsafeTestOnlyMockS3! }) })
    : privateCertificatesRouter()
  // Independent unsafe opt-in: profile consent does not grant metadata or files.
  const selfReportedCoiMetadataRouter = options.unsafeTestOnlyEnableMetadata === true
    ? createSelfReportedCoiMetadataV2Router({
      service: selfReportedCoiMetadataService(options.pool, { publicKey: options.authConfig.publicKey, issuer: options.authConfig.issuer, audience: options.authConfig.audience }),
      authenticate: auth.requireAuth,
      checkRateLimit: input => limit({ scope: 'metadata-router', ...input }),
    }) : undefined
  const fileOptions = options.unsafeTestOnlyPrivateFiles
  const selfReportedPrivateFilesRouter = fileOptions ? createSelfReportedPrivateFilesV2Router({
    service: selfReportedPrivateFileService(options.pool, { publicKey: options.authConfig.publicKey, issuer: options.authConfig.issuer, audience: options.authConfig.audience, maxFileBytes: fileOptions.maxFileBytes }, fileOptions.inspector, fileOptions.storage),
    authenticate: auth.requireAuth,
    checkRateLimit: input => limit({scope:'files-router',...input}),
    maxFileBytes: fileOptions.maxFileBytes,
    uploadDeadlineMs: fileOptions.uploadDeadlineMs,
  }) : undefined
  // The outer gate never creates a principal, so the certificate router can
  // safely clear a prior principal before the adapter's fresh verification.
  const outerAuthentication: RequestHandler = (req, res, next) => {
    if ('securePrincipal' in (req as PrincipalRequest)) return reject(req, res, next)
    return auth.requireAuth(req, res, err => {
      if (err) return next(err)
      middlewareLimit('protected', 'principal')(req, res, next)
    })
  }
  return createSecureV2App({ authRouter, gcRouter, connectionsRouter, certificatesRouter, selfReportedCoiMetadataRouter, selfReportedPrivateFilesRouter,
    authenticate: outerAuthentication, beforeProtected: middlewareLimit('protected', 'preauth'), routersOwnBodyParsing: true })
}
