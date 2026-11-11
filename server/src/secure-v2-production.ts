// Unmounted composition only. This module does not listen, migrate, seed or contact services.
// Injected components are trusted application code, not verified by this interface.
import express from 'express'
import type { RequestHandler } from 'express'
import pg from 'pg'
import { createSecureV2App } from './secure-v2-app.ts'
import { createVerifiedPrincipalAdapter } from './verified-v2-principal.ts'
import { createV2Auth } from './v2/auth.ts'
import type { V2AuthContext } from './v2/auth.ts'
import { createV2Registration } from './v2/registration.ts'
import type { RegistrationRateLimiter } from './v2/registration.ts'
import { createSesRegistrationDelivery } from './v2/sesRegistrationDelivery.ts'
import { createGcOwnerV2Router } from './routes/gcOwnerV2.ts'
import { createGcSubConnectionsV2Router } from './routes/gcSubConnectionsV2.ts'
import { createSelfReportedCoiMetadataV2Router } from './routes/selfReportedCoiMetadataV2.ts'
import { createSelfReportedPrivateFilesV2Router } from './routes/selfReportedPrivateFilesV2.ts'
import { gcSubConsentService } from './services/gcSubConsent.ts'
import { selfReportedCoiMetadataService } from './services/selfReportedCoiMetadata.ts'
import { selfReportedPrivateFileService } from './services/selfReportedPrivateFiles.ts'
import type { PrivateFileInspector } from './services/selfReportedPrivateFiles.ts'
import { createPrivateFileS3Storage, privateFileS3ConfigFromEnv } from './services/privateFileS3Storage.ts'
import type { PrivateFileS3Client } from './services/privateFileS3Storage.ts'

// Values come from a trusted runtime secret/configuration provider, never a request.
// Optional at the boundary only so missing values can be rejected at runtime.
export interface SecureV2Env {
  readonly [key: string]: string | undefined
  readonly SECURE_V2_CONFIG_VERSION?: string
  readonly SECURE_V2_DB_HOST?: string
  readonly SECURE_V2_DB_PORT?: string
  readonly SECURE_V2_DB_NAME?: string
  readonly SECURE_V2_DB_USER?: string
  readonly SECURE_V2_DB_PASSWORD?: string
  readonly SECURE_V2_JWT_PRIVATE_KEY_PEM?: string
  readonly SECURE_V2_JWT_PUBLIC_KEY_PEM?: string
  readonly SECURE_V2_JWT_ISSUER?: string
  readonly SECURE_V2_JWT_AUDIENCE?: string
  readonly SECURE_V2_SES_REGION?: string
  readonly SECURE_V2_SES_FROM?: string
  readonly SECURE_V2_SES_TIMEOUT_MS?: string
  readonly SECURE_V2_METADATA?: string
  readonly SECURE_V2_FILES?: string
  readonly SECURE_V2_FILE_S3_BUCKET?: string
  readonly SECURE_V2_FILE_S3_EXPECTED_OWNER?: string
  readonly SECURE_V2_FILE_MAX_BYTES?: string
  readonly SECURE_V2_FILE_S3_DEADLINE_MS?: string
  readonly SECURE_V2_FILE_UPLOAD_DEADLINE_MS?: string
}
export type SecureV2LimitInput = { scope: 'auth' | 'protected' | 'connections-router' | 'metadata-router' | 'files-router'; phase: 'preauth' | 'principal'; remoteAddress: string; subject?: string }
export interface SecureV2ProductionDependencies {
  env: SecureV2Env
  pool: pg.Pool
  // Must be shared, atomic, bounded and fail-closed across every instance.
  limiter: { allow(input: SecureV2LimitInput): Promise<boolean>; allowRegistration: RegistrationRateLimiter['allow'] }
  ses: NonNullable<Parameters<typeof createSesRegistrationDelivery>[1]>
  authorizeRegistrationEmail(input: { email: string }): Promise<boolean>
  authorizeInviteRecipient(input: { gcSubject: string; profileId: string }): Promise<boolean>
  files?: { inspector: PrivateFileInspector; s3: PrivateFileS3Client }
}

const invalid = (): never => { throw new Error('Invalid secure-v2 configuration or dependencies') }
function value(env: SecureV2Env, key: string): string {
  const v = env[key]
  if (typeof v !== 'string' || !v || v !== v.trim() || /[\u0000-\u001f\u007f]/.test(v) || v.length > 512) return invalid()
  return v
}
function positive(v: string, max: number): number {
  if (!/^[1-9][0-9]*$/.test(v)) return invalid()
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n > max) return invalid()
  return n
}
function flag(env: SecureV2Env, key: string): boolean {
  const v = value(env, key)
  if (v !== 'enabled' && v !== 'disabled') return invalid()
  return v === 'enabled'
}
function validatePool(pool: pg.Pool, env: SecureV2Env) {
  const host = value(env, 'SECURE_V2_DB_HOST'), database = value(env, 'SECURE_V2_DB_NAME')
  const user = value(env, 'SECURE_V2_DB_USER'), password = value(env, 'SECURE_V2_DB_PASSWORD')
  const port = positive(value(env, 'SECURE_V2_DB_PORT'), 65535)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host) || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(database) || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(user)) return invalid()
  if (!(pool instanceof pg.Pool) || pool.totalCount !== 0 || typeof pool.query !== 'function' || typeof pool.connect !== 'function') return invalid()
  const p = pool.options
  // Do not accept connectionString, custom clients/streams or pg logger; URL overrides
  // and defaults otherwise obscure the actual target. A dedicated, fresh pool is required.
  if (p.connectionString || (p as any).Client || (p as any).stream || (p as any).log || p.host !== host || p.database !== database || p.user !== user || p.password !== password || p.port !== port || p.options !== '-c search_path=public') return invalid()
  if (!(typeof p.ssl === 'object' && p.ssl !== null && p.ssl.rejectUnauthorized === true && Object.keys(p.ssl).every(k => ['rejectUnauthorized', 'ca'].includes(k)) && (p.ssl.ca === undefined || (typeof p.ssl.ca === 'string' && p.ssl.ca.length > 0)))) return invalid()
  const bounded = (n: unknown, min: number, max: number) => Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max
  if (!bounded(p.max, 1, 100) || !bounded(p.connectionTimeoutMillis, 1000, 60000) || !bounded(p.statement_timeout, 1, 120000) || !bounded(p.lock_timeout, 1, 120000) || !bounded(p.idle_in_transaction_session_timeout, 1, 120000) || (p.lock_timeout as number) > (p.statement_timeout as number)) return invalid()
}
async function deadline<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Unavailable')), 2000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

/** Constructs a fresh API app. Never reads process.env implicitly or returns secrets. */
export function createSecureV2ProductionApp(deps: SecureV2ProductionDependencies) {
  try { return compose(deps) } catch { return invalid() }
}
function compose(deps: SecureV2ProductionDependencies) {
  if (!deps || !deps.env || typeof deps.env !== 'object') return invalid()
  const env = deps.env
  if (value(env, 'SECURE_V2_CONFIG_VERSION') !== '1') return invalid()
  validatePool(deps.pool, env)
  if (typeof deps.limiter?.allow !== 'function' || typeof deps.limiter?.allowRegistration !== 'function' || typeof deps.ses?.send !== 'function' || typeof deps.authorizeRegistrationEmail !== 'function' || typeof deps.authorizeInviteRecipient !== 'function') return invalid()
  // These are the only JWT settings consulted. PEM values are not normalized or logged.
  const privateKey = env.SECURE_V2_JWT_PRIVATE_KEY_PEM, publicKey = env.SECURE_V2_JWT_PUBLIC_KEY_PEM
  if (typeof privateKey !== 'string' || privateKey.length > 16384 || typeof publicKey !== 'string' || publicKey.length > 16384) return invalid()
  const config = { privateKey, publicKey, issuer: value(env, 'SECURE_V2_JWT_ISSUER'), audience: value(env, 'SECURE_V2_JWT_AUDIENCE') }
  const metadataEnabled = flag(env, 'SECURE_V2_METADATA'), filesEnabled = flag(env, 'SECURE_V2_FILES')
  if (filesEnabled && !metadataEnabled) return invalid()
  const auth = createV2Auth(deps.pool, config) // Validates RSA type, strength and matching keypair.
  const adapter = createVerifiedPrincipalAdapter(auth.requireAuth)
  const verification = { publicKey: config.publicKey, issuer: config.issuer, audience: config.audience }
  const ses = createSesRegistrationDelivery({ region: value(env, 'SECURE_V2_SES_REGION'), fromEmailAddress: value(env, 'SECURE_V2_SES_FROM'), timeoutMs: positive(value(env, 'SECURE_V2_SES_TIMEOUT_MS'), 15000) }, deps.ses)
  const delivery = { async sendVerification(input: { email: string; token: string; expiresInSeconds: number }) {
    // The policy sees the recipient, not the verification code; denial never sends.
    if (await deadline(() => deps.authorizeRegistrationEmail({ email: input.email })) !== true) throw new Error('Unavailable')
    await ses.sendVerification(input)
  } }
  const registration = createV2Registration(deps.pool, { delivery, rateLimiter: { allow: input => deadline(() => deps.limiter.allowRegistration(input)) } })
  const limit = (input: SecureV2LimitInput) => deadline(() => deps.limiter.allow(input))
  const middlewareLimit = (scope: SecureV2LimitInput['scope'], phase: SecureV2LimitInput['phase']): RequestHandler => (req, res, next) => {
    const remoteAddress = req.socket.remoteAddress
    const subject = phase === 'principal' ? (res.locals.authV2 as V2AuthContext | undefined)?.subject : undefined
    if (!remoteAddress || (phase === 'principal' && !subject)) { res.status(503).json({ error: 'Unavailable' }); return }
    limit({ scope, phase, remoteAddress, ...(subject ? { subject } : {}) }).then(ok => {
      if (ok === true) next(); else res.status(429).json({ error: 'Unavailable' })
    }, () => { res.status(503).json({ error: 'Unavailable' }) })
  }
  const authRouter = express.Router()
  authRouter.use(middlewareLimit('auth', 'preauth'))
  authRouter.use((req, res, next) => {
    if (req.method === 'POST' && (req.path === '/register/request' || req.path === '/register/confirm')) return registration(req, res, next)
    next()
  })
  authRouter.use(auth.router)
  const connectionsRouter = createGcSubConnectionsV2Router({ service: gcSubConsentService(deps.pool, verification), authenticate: adapter,
    checkRateLimit: input => limit({ scope: 'connections-router', ...input }), authorizeInviteRecipient: input => deadline(() => deps.authorizeInviteRecipient(input)) })
  const metadataRouter = metadataEnabled ? createSelfReportedCoiMetadataV2Router({ service: selfReportedCoiMetadataService(deps.pool, verification), authenticate: auth.requireAuth,
    checkRateLimit: input => limit({ scope: 'metadata-router', ...input }) }) : undefined
  let filesRouter: ReturnType<typeof createSelfReportedPrivateFilesV2Router> | undefined
  if (filesEnabled) {
    if (typeof deps.files?.inspector?.inspect !== 'function' || typeof deps.files?.s3?.send !== 'function') return invalid()
    const storageConfig = privateFileS3ConfigFromEnv({ PRIVATE_FILE_S3_BUCKET: env.SECURE_V2_FILE_S3_BUCKET, PRIVATE_FILE_S3_EXPECTED_BUCKET_OWNER: env.SECURE_V2_FILE_S3_EXPECTED_OWNER,
      PRIVATE_FILE_S3_MAX_BYTES: env.SECURE_V2_FILE_MAX_BYTES, PRIVATE_FILE_S3_DEADLINE_MS: env.SECURE_V2_FILE_S3_DEADLINE_MS })
    const uploadDeadlineMs = positive(value(env, 'SECURE_V2_FILE_UPLOAD_DEADLINE_MS'), 60000)
    const storage = createPrivateFileS3Storage(storageConfig, deps.files.s3)
    filesRouter = createSelfReportedPrivateFilesV2Router({ service: selfReportedPrivateFileService(deps.pool, { ...verification, maxFileBytes: storageConfig.maxFileBytes }, deps.files.inspector, storage), authenticate: auth.requireAuth,
      checkRateLimit: input => limit({ scope: 'files-router', ...input }), maxFileBytes: storageConfig.maxFileBytes, uploadDeadlineMs })
  }
  const outerAuthentication: RequestHandler = (req, res, next) => {
    if ('securePrincipal' in req) { res.status(401).json({ error: 'Authentication required' }); return }
    return auth.requireAuth(req, res, err => {
      if (err) return next(err)
      middlewareLimit('protected', 'principal')(req, res, next)
    })
  }
  return createSecureV2App({ authRouter, gcRouter: createGcOwnerV2Router({ pool: deps.pool, authenticate: adapter }), connectionsRouter,
    selfReportedCoiMetadataRouter: metadataRouter, selfReportedPrivateFilesRouter: filesRouter,
    authenticate: outerAuthentication, beforeProtected: middlewareLimit('protected', 'preauth'), routersOwnBodyParsing: true, liveness: true })
}
