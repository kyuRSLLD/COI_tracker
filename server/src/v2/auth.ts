// Disconnected foundation. Nothing imports or mounts this module at application startup.
import { createHash, createPrivateKey, createPublicKey, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import express from 'express'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import pg from 'pg'

export type V2Role = 'gc' | 'sub' | 'admin'
export type V2AuthContext = { subject: string; role: V2Role; credential: string }
export type V2AuthConfig = { privateKey: string; publicKey: string; issuer: string; audience: string }
const TTL_SECONDS = 15 * 60
const params = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const scrypt = (password: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => {
  scryptCallback(password, salt, 32, params, (err, key) => err ? reject(err) : resolve(key))
})
const DUMMY = `scrypt-v1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`
const HASH = /^scrypt-v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/
const roles = new Set(['gc', 'sub', 'admin'])

function passwordInput(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256
}
/** For trusted, separately verified account provisioning only. Never log passwords or hashes. */
export async function hashV2Password(password: string): Promise<string> {
  if (!passwordInput(password) || [...password].length < 12) throw new Error('Password must contain at least 12 characters and at most 256 UTF-8 bytes')
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt)
  return `scrypt-v1$${salt.toString('base64url')}$${derived.toString('base64url')}`
}
async function checkPassword(password: string, stored: unknown): Promise<boolean> {
  const valid = typeof stored === 'string' && HASH.test(stored)
  const match = (valid ? stored as string : DUMMY).match(HASH)!
  const salt = Buffer.from(match[1], 'base64url'), expected = Buffer.from(match[2], 'base64url')
  // Require canonical encoding; malformed records still perform the expensive operation.
  const canonical = salt.length === 16 && expected.length === 32 && salt.toString('base64url') === match[1] && expected.toString('base64url') === match[2]
  const actual = await scrypt(password, canonical ? salt : Buffer.alloc(16))
  return !!valid && canonical && timingSafeEqual(actual, canonical ? expected : Buffer.alloc(32))
}
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  // Intentionally conservative ASCII login identifier, not proof of ownership.
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : null
}
function digest(token: string) { return createHash('sha256').update(token, 'ascii').digest() }
function credential(req: Request): string | null {
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'authorization') count++
  if (count !== 1) return null
  const h = req.headers.authorization
  const match = typeof h === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(h)
  return match && match[1].length <= 8192 ? match[1] : null
}
function reject(res: Response) { res.status(401).json({ error: 'Authentication required' }) }
function configKey(config: V2AuthConfig) {
  if (!config || typeof config.issuer !== 'string' || !config.issuer.trim() || config.issuer !== config.issuer.trim() || typeof config.audience !== 'string' || !config.audience.trim() || config.audience !== config.audience.trim()) throw new Error('Exact issuer and audience are required')
  if (typeof config.publicKey !== 'string' || !/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(config.publicKey)) throw new Error('A public-only PEM key is required')
  const privateKey = createPrivateKey(config.privateKey)
  const publicKey = createPublicKey(config.publicKey)
  if (privateKey.asymmetricKeyType !== 'rsa' || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048 || (publicKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('RSA keys of at least 2048 bits are required')
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const supplied = publicKey.export({ type: 'spki', format: 'der' })
  if (!derived.equals(supplied)) throw new Error('Signing and verification keys do not match')
  return { privateKey, publicKey }
}

/**
 * Inject a server-owned PostgreSQL pool and key configuration. Mount router explicitly at
 * /api/v2/auth; use requireAuth on every future v2 route, including before consent calls.
 * Successful middleware sets res.locals.authV2 to {subject, role, credential}.
 */
export function createV2Auth(pool: pg.Pool, config: V2AuthConfig): { router: express.Router; requireAuth: RequestHandler } {
  if (!(pool instanceof pg.Pool)) throw new Error('PostgreSQL pg.Pool required')
  const { privateKey, publicKey } = configKey(config)
  const { issuer, audience } = config
  const router = express.Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next() })
  router.use(express.json({ limit: '8kb', strict: true }))
  const verified = (token: string): string | null => {
    try {
      const v = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer, audience, maxAge: TTL_SECONDS })
      if (typeof v === 'string' || v.iss !== issuer || v.aud !== audience || typeof v.sub !== 'string' || !v.sub || v.sub.length > 256 || v.sub.trim() !== v.sub || /[\u0000-\u001f\u007f]/.test(v.sub) || typeof v.exp !== 'number' || !Number.isSafeInteger(v.exp) || typeof v.iat !== 'number' || !Number.isSafeInteger(v.iat) || v.iat > Math.floor(Date.now() / 1000) || v.exp <= v.iat || v.exp - v.iat > TTL_SECONDS || typeof v.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.jti)) return null
      return v.sub
    } catch { return null }
  }
  const requireAuth: RequestHandler = async (req, res, next) => {
    // Do not preserve any previously populated context across authentication attempts.
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
    delete res.locals.authV2
    const token = credential(req)
    const subject = token && verified(token)
    if (!token || !subject) { reject(res); return }
    try {
      const r = await pool.query(`SELECT u.role FROM auth_v2_sessions s
        JOIN users u ON u.id=s.user_id JOIN auth_v2_accounts a ON a.user_id=u.id
        WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
          AND a.enabled=true AND a.email_verified_at IS NOT NULL AND u.role IN ('gc','sub','admin')`, [digest(token), subject])
      if (!r.rowCount || !roles.has(r.rows[0].role)) { reject(res); return }
      res.locals.authV2 = { subject, role: r.rows[0].role as V2Role, credential: token } satisfies V2AuthContext
      next()
    } catch { res.status(503).json({ error: 'Authentication unavailable' }) }
  }
  router.post('/register', (req, res) => {
    // No unverified account, user, profile, or legacy record is created.
    if (req.body?.role !== undefined && req.body.role !== 'gc' && req.body.role !== 'sub') {
      res.status(400).json({ error: 'Invalid registration request' }); return
    }
    res.status(503).json({ error: 'Registration unavailable' })
  })
  router.post('/login', async (req, res) => {
    const email = normalizeEmail(req.body?.email), password = req.body?.password
    if (!email || !passwordInput(password)) { res.status(400).json({ error: 'Invalid request' }); return }
    try {
      const found = await pool.query(`SELECT a.user_id,a.password_hash FROM auth_v2_accounts a WHERE a.login_email=$1`, [email])
      const account = found.rows[0]
      const ok = await checkPassword(password, account?.password_hash)
      if (!ok || !account) { res.status(401).json({ error: 'Invalid credentials' }); return }
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        // User first, then account: role/credential updates serialize with issuance.
        const u = await c.query(`SELECT role FROM users WHERE id=$1 AND role IN ('gc','sub','admin') FOR SHARE`, [account.user_id])
        const a = await c.query(`SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND login_email=$2 AND password_hash=$3 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE`, [account.user_id, email, account.password_hash])
        if (!u.rowCount || !a.rowCount) { await c.query('ROLLBACK'); res.status(401).json({ error: 'Invalid credentials' }); return }
        const token = jwt.sign({}, privateKey, { algorithm: 'RS256', issuer, audience, subject: account.user_id, jwtid: randomBytes(32).toString('base64url'), expiresIn: TTL_SECONDS })
        const payload = jwt.decode(token) as jwt.JwtPayload
        await c.query('INSERT INTO auth_v2_sessions(token_hash,user_id,expires_at) VALUES($1,$2,to_timestamp($3))', [digest(token), account.user_id, payload.exp])
        await c.query('COMMIT')
        res.json({ token, token_type: 'Bearer', expires_in: TTL_SECONDS })
      } catch (err) { try { await c.query('ROLLBACK') } catch {} throw err } finally { c.release() }
    } catch { res.status(503).json({ error: 'Authentication unavailable' }) }
  })
  router.get('/me', requireAuth, (_req, res) => {
    const { subject, role } = res.locals.authV2 as V2AuthContext
    res.json({ subject, role })
  })
  router.post('/logout', requireAuth, async (_req, res) => {
    try {
      const a = res.locals.authV2 as V2AuthContext
      await pool.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL', [digest(a.credential), a.subject])
      res.status(204).end()
    } catch { res.status(503).json({ error: 'Authentication unavailable' }) }
  })
  router.post('/logout-all', requireAuth, async (_req, res) => {
    try {
      const a = res.locals.authV2 as V2AuthContext
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        // Serialize with login, which takes a share lock on the same user row.
        const u = await c.query("SELECT id FROM users WHERE id=$1 AND role IN ('gc','sub','admin') FOR UPDATE", [a.subject])
        const account = await c.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE', [a.subject])
        const session = await c.query('SELECT token_hash FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE', [digest(a.credential), a.subject])
        if (!u.rowCount || !account.rowCount || !session.rowCount || !verified(a.credential)) { await c.query('ROLLBACK'); reject(res); return }
        await c.query('UPDATE auth_v2_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [a.subject])
        await c.query('COMMIT')
        res.status(204).end()
      } catch (err) { try { await c.query('ROLLBACK') } catch {} throw err } finally { c.release() }
    } catch { res.status(503).json({ error: 'Authentication unavailable' }) }
  })
  // Parser errors are generic; do not return raw exception text.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status((err as { status?: number })?.status === 413 ? 413 : 400).json({ error: 'Invalid request' }) })
  return { router, requireAuth }
}
