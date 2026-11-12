import express from 'express'
import type { ErrorRequestHandler, RequestHandler } from 'express'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { createSecureContext } from 'node:tls'
import { Agent } from 'node:https'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { createSecureV2ProductionApp } from './secure-v2-production.ts'
import { createPilotLimiter } from './pilot-limiter.ts'

const invalid = (): never => { throw new Error('Invalid pilot configuration') }
const required = (env: NodeJS.ProcessEnv, name: string) => {
  const v = env[name]
  if (!v || v !== v.trim() || /[\x00-\x1f\x7f]/.test(v) || v.length > 512) return invalid()
  return v
}
const positive = (s: string, max: number) => {
  if (!/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) > max) return invalid()
  return Number(s)
}
const mailbox = (s: unknown): string | null => {
  if (typeof s !== 'string') return null
  const v = s.trim().toLowerCase()
  return v.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(v) ? v : null
}
const deliveryMailbox = (v: string) => {
  if (mailbox(v) !== v) return false
  const [local, domain] = v.split('@')
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') && domain.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}
const exact = new Set(['/api/v2/auth/login', '/api/v2/auth/logout', '/api/v2/auth/logout-all', '/api/v2/auth/me', '/api/v2/auth/register/request', '/api/v2/auth/register/confirm', '/api/v2/connections/consent', '/api/v2/connections/profile', '/api/v2/connections/general-contractors', '/api/v2/connections/qr', '/api/v2/connections/qr/redeem', '/api/v2/connections/revoke', '/api/v2/connections/subcontractors'])

/** Does not listen, connect, migrate, seed, or send messages during construction. */
export function createPilot(env: NodeJS.ProcessEnv) {
  try {
    // These process-wide settings can replace trust roots or bypass TLS checks.
    for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'AWS_CA_BUNDLE', 'NODE_OPTIONS']) {
      if (env[name] !== undefined || process.env[name] !== undefined) return invalid()
    }
    if (required(env, 'SECURE_V2_CONFIG_VERSION') !== '1' || required(env, 'SECURE_V2_METADATA') !== 'disabled' || required(env, 'SECURE_V2_FILES') !== 'disabled') return invalid()
    const host = required(env, 'SECURE_V2_DB_HOST'), database = required(env, 'SECURE_V2_DB_NAME'), user = required(env, 'SECURE_V2_DB_USER'), password = required(env, 'SECURE_V2_DB_PASSWORD')
    const port = positive(required(env, 'SECURE_V2_DB_PORT'), 65535)
    const secretText = required(env, 'PILOT_LIMITER_HMAC_KEY')
    if (!/^[A-Za-z0-9_-]{43}$/.test(secretText)) return invalid()
    const secret = Buffer.from(secretText, 'base64url')
    if (secret.length !== 32 || secret.toString('base64url') !== secretText) return invalid()
    const entries = required(env, 'PILOT_REGISTRATION_MAILBOXES').split(',')
    if (!entries.length || entries.length > 20 || entries.some(v => !v || v !== v.trim() || !deliveryMailbox(v)) || new Set(entries).size !== entries.length) return invalid()
    const permitted = new Set(entries)
    const ca = env.PILOT_DB_CA_PEM
    if (ca !== undefined) {
      if (!ca || ca.length > 32768 || !/-----BEGIN CERTIFICATE-----/.test(ca)) return invalid()
      createSecureContext({ ca })
    }
    const region = required(env, 'SECURE_V2_SES_REGION')
    const pool = new pg.Pool({ host, port, database, user, password, ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      options: '-c search_path=public', max: 10, connectionTimeoutMillis: 1000, statement_timeout: 1200, lock_timeout: 400, idle_in_transaction_session_timeout: 2000 })
    // No SDK custom endpoint, transport injection, test mail or command logging.
    const httpsAgent = new Agent({ keepAlive: true, maxSockets: 4 })
    const ses = new SESv2Client({ region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true, useFipsEndpoint: false, useDualstackEndpoint: false,
      requestHandler: { httpsAgent, connectionTimeout: 1000, socketTimeout: 5000 } })
    let inFlight = 0
    const transport: NonNullable<Parameters<typeof createSecureV2ProductionApp>[0]['ses']> = {
      async send(command, options) {
        if (inFlight >= 4) throw new Error('Unavailable')
        inFlight++
        try { return await ses.send(command, options) } finally { inFlight-- }
      },
    }
    const limiter = createPilotLimiter(pool, secret)
    // Pass only this integration's explicitly selected factory settings; unrelated
    // optional settings cannot silently alter the composition.
    const factoryEnv = Object.fromEntries(['SECURE_V2_CONFIG_VERSION', 'SECURE_V2_DB_HOST', 'SECURE_V2_DB_PORT', 'SECURE_V2_DB_NAME', 'SECURE_V2_DB_USER', 'SECURE_V2_DB_PASSWORD', 'SECURE_V2_JWT_PRIVATE_KEY_PEM', 'SECURE_V2_JWT_PUBLIC_KEY_PEM', 'SECURE_V2_JWT_ISSUER', 'SECURE_V2_JWT_AUDIENCE', 'SECURE_V2_SES_REGION', 'SECURE_V2_SES_FROM', 'SECURE_V2_SES_TIMEOUT_MS', 'SECURE_V2_METADATA', 'SECURE_V2_FILES'].map(k => [k, env[k]]))
    const inner = createSecureV2ProductionApp({ env: factoryEnv, pool, limiter, ses: transport,
      authorizeRegistrationEmail: async ({ email }) => permitted.has(email), authorizeInviteRecipient: async () => false })
    const app = express()
    app.disable('x-powered-by'); app.disable('etag'); app.enable('case sensitive routing'); app.enable('strict routing')
    app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }); next() })
    app.use((req, res, next) => {
      if (req.url === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return next()
      // Reject queries, encodings, paths outside the explicit connection-only surface.
      if (!exact.has(req.url)) { res.status(404).json({ error: 'Not found' }); return }
      const peer = req.socket.remoteAddress
      if (!peer) { res.status(503).json({ error: 'Unavailable' }); return }
      void limiter.front(peer).then(ok => { if (ok) next(); else res.status(503).json({ error: 'Unavailable' }) }, () => res.status(503).json({ error: 'Unavailable' }))
    })
    const parse = express.json({ limit: '8kb', strict: true, inflate: false, type: 'application/json' })
    const gate: RequestHandler = (req, res, next) => {
      const peer = req.socket.remoteAddress || ''
      void (async () => {
        if (req.url === '/api/v2/auth/login') {
          const email = mailbox(req.body?.email)
          if (!email || !await limiter.login(peer, email)) return false
        } else if (req.url === '/api/v2/auth/register/request') {
          const email = mailbox(req.body?.email)
          if (!email || !permitted.has(email)) return false
        } else {
          const token = req.body?.token
          if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return false
          const digest = createHash('sha256').update(token, 'utf8').digest()
          if (!await limiter.confirm(peer, digest.toString('hex'))) return false
          const result = await pool.query(`SELECT 1 FROM public.auth_v2_registration_challenges WHERE token_hash=$1 AND email=ANY($2::text[]) AND delivered_at IS NOT NULL AND used_at IS NULL AND expires_at>clock_timestamp()`, [digest, entries])
          if (result.rowCount !== 1) return false
        }
        return true
      })().then(ok => { if (ok) next(); else res.status(503).json({ error: 'Unavailable' }) }, () => res.status(503).json({ error: 'Unavailable' }))
    }
    app.use((req, res, next) => {
      if (req.method === 'POST' && ['/api/v2/auth/login', '/api/v2/auth/register/request', '/api/v2/auth/register/confirm'].includes(req.url)) return parse(req, res, err => err ? next(err) : gate(req, res, next))
      next()
    })
    app.use(inner)
    const errors: ErrorRequestHandler = (_err, _req, res, _next) => { if (res.headersSent) { res.destroy(); return } res.status(400).json({ error: 'Invalid request' }) }
    app.use(errors)
    return { app, pool, ses, httpsAgent, limiter }
  } catch { return invalid() }
}
