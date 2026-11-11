// Disconnected, PostgreSQL-only composition. Do not import at application startup.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import pg from 'pg'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { hashV2Password } from './auth.ts'

/** Trusted server-side adapter only. Resolve only when the provider has accepted the message.
 * Never log token, message contents, or a verification URL. Client-supplied delivery is forbidden. */
export type RegistrationDelivery = { sendVerification(input: { email: string; token: string; expiresInSeconds: number }): Promise<void> }
/** Must enforce shared/global and trusted client-IP limits, plus an email-key limit for requests.
 * Any rejection, exception, missing limiter or value other than literal true denies the operation. */
export type RegistrationRateLimiter = { allow(input: { action: 'request' | 'confirm'; clientAddress: string; identityHash: string }): Promise<boolean> }
export type RegistrationDependencies = { delivery?: RegistrationDelivery; rateLimiter?: RegistrationRateLimiter }
const TTL = 10 * 60
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest()
const emailOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(email) ? email : null
}
const tokenOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').length === 32 && Buffer.from(v, 'base64url').toString('base64url') === v
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const personName = (v: unknown): v is string => text(v, 100) && Buffer.from(v, 'utf8').toString('utf8') === v
const usPhone = (v: unknown): string | null => {
  if (typeof v !== 'string' || v.length > 32 || /[^\x20-\x7e]/.test(v)) return null
  const input = v.trim()
  // Only complete national or +1 country-code numbers; never strip an extension,
  // extra digits, Unicode digits, or other unexpected input.
  if (!/^(?:\+1[ .-]?|1[ .-]?)?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ .-]?[2-9][0-9]{2}[ .-]?[0-9]{4}$/.test(input)) return null
  const number = parsePhoneNumberFromString(input, { defaultCountry: 'US', extract: false })
  if (!number || number.country !== 'US' || !number.isValid() || number.ext) return null
  return number.formatNational()
}
const keysOnly = (body: unknown, allowed: string[]) => !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => allowed.includes(k))
const genericRequest = (res: Response) => res.status(202).json({ message: 'If eligible, check your email for next steps.' })
const genericConfirm = (res: Response) => res.status(200).json({ message: 'If eligible, registration is complete. You may try signing in.' })
const unavailable = (res: Response) => res.status(503).json({ error: 'Registration unavailable' })

export function createV2Registration(pool: pg.Pool, deps: RegistrationDependencies = {}): express.Router {
  if (!(pool instanceof pg.Pool)) throw new Error('PostgreSQL pg.Pool required')
  const router = express.Router()
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next() })
  router.use(express.json({ limit: '8kb', strict: true }))
  const permitted = async (req: Request, action: 'request' | 'confirm', identity: string) => {
    if (typeof deps.delivery?.sendVerification !== 'function' || typeof deps.rateLimiter?.allow !== 'function') return false
    try { return (await deps.rateLimiter.allow({ action, clientAddress: req.ip || '', identityHash: hash(identity).toString('hex') })) === true } catch { return false }
  }
  router.post('/register/request', async (req, res) => {
    const email = emailOf(req.body?.email)
    if (!keysOnly(req.body, ['email']) || !email) { res.status(400).json({ error: 'Invalid request' }); return }
    if (!await permitted(req, 'request', email)) { unavailable(res); return }
    const token = randomBytes(32).toString('base64url'), tokenHash = hash(token)
    try {
      await pool.query(`INSERT INTO auth_v2_registration_challenges(token_hash,email,expires_at)
        VALUES($1,$2,clock_timestamp()+($3 * interval '1 second'))`, [tokenHash, email, TTL])
      // Delivery is server-configured, never selected by request input. Until it resolves,
      // confirmation remains disabled, including if it fails or its outcome is ambiguous.
      try {
        await deps.delivery!.sendVerification({ email, token, expiresInSeconds: TTL })
        const armed = await pool.query(`UPDATE auth_v2_registration_challenges SET delivered_at=clock_timestamp()
          WHERE token_hash=$1 AND used_at IS NULL AND expires_at>clock_timestamp()`, [tokenHash])
        if (armed.rowCount !== 1) throw new Error('Challenge unavailable')
      } catch {
        try { await pool.query('DELETE FROM auth_v2_registration_challenges WHERE token_hash=$1 AND delivered_at IS NULL', [tokenHash]) } catch { /* remain unarmed */ }
        unavailable(res); return
      }
      genericRequest(res)
    } catch { unavailable(res) }
  })
  router.post('/register/confirm', async (req, res) => {
    const b = req.body
    const phone = usPhone(b?.phone)
    if (!keysOnly(b, ['token', 'role', 'password', 'first_name', 'last_name', 'phone', 'company_name', 'trade']) || !tokenOk(b?.token) || !['gc', 'sub'].includes(b?.role) ||
      !personName(b?.first_name) || !personName(b?.last_name) || !phone || typeof b?.password !== 'string' || [...b.password].length < 12 || Buffer.byteLength(b.password, 'utf8') > 256 ||
      (b.role === 'sub' && (!text(b.company_name, 200) || !text(b.trade, 200))) ||
      (b.role === 'gc' && (b.company_name !== undefined || b.trade !== undefined))) {
      res.status(400).json({ error: 'Invalid request' }); return
    }
    if (!await permitted(req, 'confirm', b.token)) { unavailable(res); return }
    const tokenHash = hash(b.token)
    try {
      const candidate = await pool.query(`SELECT 1 FROM auth_v2_registration_challenges WHERE token_hash=$1
        AND delivered_at IS NOT NULL AND used_at IS NULL AND expires_at>clock_timestamp()`, [tokenHash])
      if (!candidate.rowCount) { genericConfirm(res); return }
      // Password and profile data come from the email holder, NOT the challenge requester.
      const passwordHash = await hashV2Password(b.password)
      const c = await pool.connect()
      let email: string | undefined
      try {
        await c.query('BEGIN')
        const challenge = await c.query(`SELECT email FROM auth_v2_registration_challenges WHERE token_hash=$1
          AND delivered_at IS NOT NULL AND used_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [tokenHash])
        if (!challenge.rowCount) { await c.query('ROLLBACK'); genericConfirm(res); return }
        email = challenge.rows[0].email as string
        const existing = await c.query(`SELECT 1 FROM users WHERE lower(email COLLATE "C")=$1
          UNION ALL SELECT 1 FROM auth_v2_accounts WHERE login_email=$1 LIMIT 1`, [email])
        if (existing.rowCount) {
          await c.query('UPDATE auth_v2_registration_challenges SET used_at=clock_timestamp() WHERE token_hash=$1', [tokenHash])
          await c.query('COMMIT'); genericConfirm(res); return
        }
        const user = randomUUID(), sub = b.role === 'sub' ? randomUUID() : null, now = new Date().toISOString()
        const firstName = b.first_name.trim(), lastName = b.last_name.trim(), name = `${firstName} ${lastName}`
        // The legacy field is deliberately not a usable bcrypt credential.
        await c.query(`INSERT INTO users(id,email,password_hash,name,first_name,last_name,phone,company_name,role,subcontractor_id,created_at)
          VALUES($1,$2,'!v2-only!',$3,$4,$5,$6,$7,$8,$9,$10)`, [user, email, name, firstName, lastName, phone, sub ? b.company_name.trim() : null, b.role, sub, now])
        await c.query(`INSERT INTO user_phones(id,user_id,phone,label,is_primary,created_at)
          VALUES($1,$2,$3,'mobile',1,$4)`, [randomUUID(), user, phone, now])
        const reference = `email-control-only:${randomUUID()}`
        await c.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled)
          VALUES($1,$2,$3,clock_timestamp(),$4,true)`, [user, email, passwordHash, reference])
        if (sub) {
          await c.query(`INSERT INTO subcontractors(id,user_id,company_name,trade,contact_person,email,status,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,'pending_review',$7,$7)`, [sub, user, b.company_name.trim(), b.trade.trim(), name, email, now])
          // Only a brand-new application profile, never a claim to an existing business or COI.
          const profile = randomUUID()
          await c.query(`INSERT INTO auth_v2_sub_profiles(id,subcontractor_id,sub_user_id,email_verified_at,verification_reference)
            VALUES($1,$2,$3,clock_timestamp(),$4)`, [profile, sub, user, reference])
          await c.query(`INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference)
            VALUES($1,$2,$3,clock_timestamp(),$4)`, [profile, sub, user, reference])
          await c.query(`INSERT INTO gc_sub_fresh_profile_evidence(profile_id,subcontractor_id,sub_user_id,evidence_type,verification_reference,registration_challenge_hash)
            VALUES($1,$2,$3,'fresh_self_asserted_email_control_v1',$4,$5)`, [profile, sub, user, reference, tokenHash])
        }
        const used = await c.query(`UPDATE auth_v2_registration_challenges SET used_at=clock_timestamp()
          WHERE token_hash=$1 AND used_at IS NULL AND delivered_at IS NOT NULL AND expires_at>clock_timestamp()`, [tokenHash])
        if (used.rowCount !== 1) { await c.query('ROLLBACK'); genericConfirm(res); return }
        await c.query('COMMIT')
        genericConfirm(res)
      } catch (err) {
        try { await c.query('ROLLBACK') } catch { /* preserve original error */ }
        // Only an actual concurrently created account is a generic email collision;
        // unrelated uniqueness failures (e.g. user_phones) must not look successful.
        if ((err as { code?: string }).code === '23505' && email) {
          const existing = await c.query(`SELECT 1 FROM users WHERE lower(email COLLATE "C")=$1
            UNION ALL SELECT 1 FROM auth_v2_accounts WHERE login_email=$1 LIMIT 1`, [email])
          if (existing.rowCount) { genericConfirm(res); return }
        }
        throw err
      } finally { c.release() }
    } catch { unavailable(res) }
  })
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status((err as { status?: number })?.status === 413 ? 413 : 400).json({ error: 'Invalid request' }) })
  return router
}
