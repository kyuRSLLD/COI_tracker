// Deliberately disconnected: no route, startup, pool creation, or automatic migration.
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import type { PoolClient } from 'pg'

export const CONSENT_V1 = 'share-current-and-future-coi-v1' as const
export const QR_CONSENT_V1_TEXT = 'I consent to share my current and future verified subcontractor-owned COI information with whichever authenticated general contractor scans this one-time code, until I revoke access.'
export const INVITE_CONSENT_V1_TEXT = 'I consent to share my current and future verified subcontractor-owned COI information with the identified inviting general contractor until I revoke access.'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/

// One uniform failure is intentional: do not disclose whether a profile, grant, or token exists.
export class UnavailableError extends Error { constructor() { super('Unavailable'); this.name = 'UnavailableError' } }
function unavailable(): never { throw new UnavailableError() }
function validProfile(id: string) { if (typeof id !== 'string' || !ID.test(id)) unavailable() }
function digest(token: string): Buffer {
  if (typeof token !== 'string' || !TOKEN.test(token)) unavailable()
  return createHash('sha256').update(token, 'ascii').digest()
}
function consent(value: unknown) { if (value !== CONSENT_V1) unavailable() }

/** Configuration must be controlled by the server, not the request. No symmetric or fallback key. */
export function gcSubConsentService(pool: pg.Pool, config: { publicKey: string; issuer: string; audience: string }) {
  if (!(pool instanceof pg.Pool)) throw new Error('PostgreSQL pg.Pool required')
  if (!config.issuer?.trim() || !config.audience?.trim()) throw new Error('Issuer and audience required')
  const key = createPublicKey(config.publicKey)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
    throw new Error('An RSA public key of at least 2048 bits is required')
  }
  function subject(credential: string): string {
    try {
      if (typeof credential !== 'string' || credential.length > 8192) return unavailable()
      const v = jwt.verify(credential, key, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience })
      if (typeof v === 'string' || typeof v.sub !== 'string' || !v.sub || v.sub.length > 256 || v.sub.trim() !== v.sub || /[\u0000-\u001f\u007f]/.test(v.sub) || typeof v.exp !== 'number' || !Number.isFinite(v.exp)) return unavailable()
      return v.sub
    } catch { return unavailable() }
  }
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const result = await fn(c)
      await c.query('COMMIT')
      return result
    } catch (err) {
      try { await c.query('ROLLBACK') } catch { /* preserve error */ }
      throw err
    } finally { c.release() }
  }
  // Lock users first in deterministic order, then profile, then capability/grant.
  // Role updates and profile suspension are serialized with successful writes.
  async function lockActors(c: PoolClient, expected: Array<[string, 'gc' | 'sub']>) {
    if (new Set(expected.map(([id]) => id)).size !== expected.length) unavailable()
    const rows = await c.query('SELECT id, role FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [expected.map(x => x[0])])
    if (rows.rowCount !== expected.length || expected.some(([id, role]) => !rows.rows.some(r => r.id === id && r.role === role))) unavailable()
  }
  async function profile(c: PoolClient, profileId: string) {
    const r = await c.query('SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [profileId])
    if (!r.rowCount) unavailable()
    return r.rows[0] as { id: string; subcontractor_id: string; sub_user_id: string }
  }
  async function lookupProfile(c: PoolClient, id: string) {
    const r = await c.query('SELECT sub_user_id FROM gc_sub_profiles WHERE id=$1 AND revoked_at IS NULL', [id])
    if (!r.rowCount) unavailable()
    return r.rows[0].sub_user_id as string
  }
  function makeToken() { const token = randomBytes(32).toString('base64url'); return { token, hash: digest(token) } }
  async function grant(c: PoolClient, p: { id: string; sub_user_id: string }, gc: string, action: 'granted_qr' | 'granted_invite', consentedAt: Date) {
    await c.query(`INSERT INTO gc_sub_grants(profile_id,gc_user_id,consent_version,consented_at,granted_at,revoked_at)
      VALUES ($1,$2,$3,$4,clock_timestamp(),NULL)
      ON CONFLICT(profile_id,gc_user_id) DO UPDATE SET consent_version=EXCLUDED.consent_version,
        consented_at=EXCLUDED.consented_at, granted_at=EXCLUDED.granted_at, revoked_at=NULL`, [p.id, gc, CONSENT_V1, consentedAt])
    await c.query(`INSERT INTO gc_sub_grant_events(profile_id,gc_user_id,sub_user_id,action,consent_version,consented_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [p.id, gc, p.sub_user_id, action, CONSENT_V1, consentedAt])
  }
  return {
    /** Explicit pre-consent; raw code is returned once to the authenticated sub for QR encoding. */
    async issueSubQr(credential: string, profileId: string, affirmativeConsent: unknown) {
      const sub = subject(credential); validProfile(profileId); consent(affirmativeConsent)
      return tx(async c => {
        await lockActors(c, [[sub, 'sub']]); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        const { token, hash } = makeToken()
        const r = await c.query(`INSERT INTO gc_sub_capabilities(token_hash,kind,profile_id,consent_version,consented_at,created_at,expires_at)
          VALUES($1,'qr',$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes') RETURNING expires_at`, [hash, p.id, CONSENT_V1])
        return { token, expiresAt: r.rows[0].expires_at as Date }
      })
    },
    /** An authenticated GC presents the scanned bearer code; consumption and grant are atomic. */
    async redeemSubQr(credential: string, token: string): Promise<void> {
      const gc = subject(credential); const hash = digest(token)
      return tx(async c => {
        const found = await c.query("SELECT profile_id FROM gc_sub_capabilities WHERE token_hash=$1 AND kind='qr'", [hash])
        if (!found.rowCount) unavailable()
        const id = found.rows[0].profile_id as string; const sub = await lookupProfile(c, id)
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); const p = await profile(c, id)
        if (p.sub_user_id !== sub) unavailable()
        const used = await c.query(`UPDATE gc_sub_capabilities SET used_at=clock_timestamp()
          WHERE token_hash=$1 AND kind='qr' AND profile_id=$2 AND used_at IS NULL AND invalidated_at IS NULL
            AND expires_at > clock_timestamp() AND consent_version=$3 RETURNING consented_at`, [hash, id, CONSENT_V1])
        if (!used.rowCount) unavailable()
        await grant(c, p, gc, 'granted_qr', used.rows[0].consented_at)
      })
    },
    /** Invite is bound to one verified profile and a current GC; it conveys no sharing consent. */
    async createGcInvite(credential: string, profileId: string) {
      const gc = subject(credential); validProfile(profileId)
      return tx(async c => {
        const sub = await lookupProfile(c, profileId)
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        const { token, hash } = makeToken()
        const r = await c.query(`INSERT INTO gc_sub_capabilities(token_hash,kind,profile_id,gc_user_id,created_at,expires_at)
          VALUES($1,'invite',$2,$3,clock_timestamp(),clock_timestamp()+interval '7 days') RETURNING expires_at`, [hash, p.id, gc])
        return { token, expiresAt: r.rows[0].expires_at as Date }
      })
    },
    /** Identify the live inviting GC to the verified sub before asking for consent. */
    async previewGcInvite(credential: string, token: string) {
      const sub = subject(credential); const hash = digest(token)
      const r = await pool.query(`SELECT g.id AS gc_user_id, g.name AS gc_name, p.id AS profile_id, cap.expires_at
        FROM gc_sub_capabilities cap
        JOIN gc_sub_profiles p ON p.id=cap.profile_id AND p.revoked_at IS NULL AND p.sub_user_id=$2
        JOIN users s ON s.id=p.sub_user_id AND s.role='sub'
        JOIN users g ON g.id=cap.gc_user_id AND g.role='gc'
        WHERE cap.token_hash=$1 AND cap.kind='invite' AND cap.used_at IS NULL
          AND cap.invalidated_at IS NULL AND cap.expires_at > clock_timestamp()`, [hash, sub])
      if (!r.rowCount) unavailable()
      return r.rows[0]
    },
    /** Only the verified profile owner can accept, and only after affirmative consent. */
    async acceptGcInvite(credential: string, token: string, affirmativeConsent: unknown): Promise<void> {
      const sub = subject(credential); const hash = digest(token); consent(affirmativeConsent)
      return tx(async c => {
        const found = await c.query("SELECT profile_id,gc_user_id FROM gc_sub_capabilities WHERE token_hash=$1 AND kind='invite'", [hash])
        if (!found.rowCount) unavailable()
        const { profile_id: id, gc_user_id: gc } = found.rows[0] as { profile_id: string; gc_user_id: string }
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); const p = await profile(c, id)
        if (p.sub_user_id !== sub) unavailable()
        const used = await c.query(`UPDATE gc_sub_capabilities SET used_at=clock_timestamp()
          WHERE token_hash=$1 AND kind='invite' AND profile_id=$2 AND gc_user_id=$3 AND used_at IS NULL
          AND invalidated_at IS NULL AND expires_at > clock_timestamp() RETURNING used_at`, [hash, id, gc])
        if (!used.rowCount) unavailable()
        await grant(c, p, gc, 'granted_invite', used.rows[0].used_at)
      })
    },
    /** Invalidates all unspent QRs for the profile and pending invitations from this GC. */
    async revoke(credential: string, profileId: string, gcUserId: string): Promise<boolean> {
      const sub = subject(credential); validProfile(profileId)
      if (typeof gcUserId !== 'string' || !gcUserId || gcUserId.length > 256) unavailable()
      return tx(async c => {
        await lockActors(c, [[sub, 'sub']]); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        await c.query(`UPDATE gc_sub_capabilities SET invalidated_at=clock_timestamp()
          WHERE profile_id=$1 AND used_at IS NULL AND invalidated_at IS NULL AND (kind='qr' OR (kind='invite' AND gc_user_id=$2))`, [p.id, gcUserId])
        const r = await c.query('UPDATE gc_sub_grants SET revoked_at=clock_timestamp() WHERE profile_id=$1 AND gc_user_id=$2 AND revoked_at IS NULL RETURNING consent_version,consented_at', [p.id, gcUserId])
        if (r.rowCount) await c.query(`INSERT INTO gc_sub_grant_events(profile_id,gc_user_id,sub_user_id,action,consent_version,consented_at)
          VALUES($1,$2,$3,'revoked',$4,$5)`, [p.id, gcUserId, sub, r.rows[0].consent_version, r.rows[0].consented_at])
        return !!r.rowCount
      })
    },
    /** Projections intentionally exclude document URLs/keys, coverage, notes and contact details. */
    async listGrantedSubs(credential: string) {
      const gc = subject(credential)
      const r = await pool.query(`SELECT s.id, s.company_name, s.trade, s.status, p.id AS profile_id
        FROM gc_sub_grants g JOIN gc_sub_profiles p ON p.id=g.profile_id AND p.revoked_at IS NULL
        JOIN users su ON su.id=p.sub_user_id AND su.role='sub'
        JOIN users gu ON gu.id=g.gc_user_id AND gu.role='gc'
        JOIN subcontractors s ON s.id=p.subcontractor_id
        WHERE g.gc_user_id=$1 AND g.revoked_at IS NULL ORDER BY s.id`, [gc])
      return r.rows
    },
    async listGrantedCois(credential: string, profileId: string) {
      const gc = subject(credential); validProfile(profileId)
      const r = await pool.query(`SELECT c.id, c.subcontractor_id, c.carrier, c.effective_date, c.expiration_date, c.status
        FROM gc_sub_grants g JOIN gc_sub_profiles p ON p.id=g.profile_id AND p.revoked_at IS NULL
        JOIN users su ON su.id=p.sub_user_id AND su.role='sub'
        JOIN users gu ON gu.id=g.gc_user_id AND gu.role='gc'
        JOIN gc_sub_coi_ownership o ON o.profile_id=p.id AND o.subcontractor_id=p.subcontractor_id
        JOIN cois c ON c.id=o.coi_id AND c.subcontractor_id=o.subcontractor_id
        WHERE g.gc_user_id=$1 AND g.profile_id=$2 AND g.revoked_at IS NULL ORDER BY c.id`, [gc, profileId])
      return r.rows
    },
  }
}
