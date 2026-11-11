// Deliberately disconnected: no route, startup, pool creation, or automatic migration.
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import type { PoolClient } from 'pg'

export const CONSENT_V1 = 'share-current-and-future-coi-v1' as const
export const QR_CONSENT_V1_TEXT = 'I consent to share my current and future verified subcontractor-owned COI information with whichever authenticated general contractor scans this one-time code, until I revoke access.'
export const INVITE_CONSENT_V1_TEXT = 'I consent to share my current and future verified subcontractor-owned COI information with the identified inviting general contractor until I revoke access.'
export const CONSENT_V2 = 'share-self-reported-profile-only-v2' as const
export const QR_CONSENT_V2_TEXT = 'I consent to share this application profile’s identifiers, email-control-only evidence type, and current and future self-reported company name and trade with whichever signed-in account with a general contractor role scans this one-time code, until I revoke access. Email control does not verify my company, authority, or insurance, and the general contractor role does not verify the recipient’s business. This consent does not share COIs or documents.'
export const INVITE_CONSENT_V2_TEXT = 'I consent to share this application profile’s identifiers, email-control-only evidence type, and current and future self-reported company name and trade with the identified inviting account with a general contractor role until I revoke access. Email control does not verify my company, authority, or insurance, and the general contractor role does not verify the recipient’s business. This consent does not share COIs or documents.'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const AUTH_TTL_SECONDS = 15 * 60

// One uniform failure is intentional: do not disclose whether a profile, grant, or token exists.
export class UnavailableError extends Error { constructor() { super('Unavailable'); this.name = 'UnavailableError' } }
function unavailable(): never { throw new UnavailableError() }
function validProfile(id: string) { if (typeof id !== 'string' || !ID.test(id)) unavailable() }
function digest(token: string): Buffer {
  if (typeof token !== 'string' || !TOKEN.test(token)) unavailable()
  return createHash('sha256').update(token, 'ascii').digest()
}
function consent(value: unknown) { if (value !== CONSENT_V2) unavailable() }

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
      const v = jwt.verify(credential, key, { algorithms: ['RS256'], issuer: config.issuer, audience: config.audience, maxAge: AUTH_TTL_SECONDS })
      if (typeof v === 'string' || v.iss !== config.issuer || v.aud !== config.audience || typeof v.sub !== 'string' || !v.sub || v.sub.length > 256 || v.sub.trim() !== v.sub || /[\u0000-\u001f\u007f]/.test(v.sub) || typeof v.exp !== 'number' || !Number.isSafeInteger(v.exp) || typeof v.iat !== 'number' || !Number.isSafeInteger(v.iat) || v.iat > Math.floor(Date.now() / 1000) || v.exp <= v.iat || v.exp - v.iat > AUTH_TTL_SECONDS || typeof v.jti !== 'string' || !TOKEN.test(v.jti)) return unavailable()
      return v.sub
    } catch { return unavailable() }
  }
  async function tx<T>(credential: string, user: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await fn(c)
      await currentSession(c, credential, user)
      await c.query('COMMIT')
      return result
    } catch (err) {
      try { await c.query('ROLLBACK') } catch { /* preserve error */ }
      throw err
    } finally { c.release() }
  }
  // Lock users in deterministic order, then account, session, profile and capability/grant.
  // Role updates and profile suspension are serialized with successful writes.
  async function lockActors(c: PoolClient, expected: Array<[string, 'gc' | 'sub']>) {
    if (new Set(expected.map(([id]) => id)).size !== expected.length) unavailable()
    const rows = await c.query('SELECT id, role FROM users WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE', [expected.map(x => x[0])])
    if (rows.rowCount !== expected.length || expected.some(([id, role]) => !rows.rows.some(r => r.id === id && r.role === role))) unavailable()
  }
  // Login/logout-all and change triggers lock users -> account -> sessions.
  // Single logout only locks the session, and never waits for earlier locks.
  async function lockSession(c: PoolClient, credential: string, user: string) {
    const account = await c.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE', [user])
    if (!account.rowCount) unavailable()
    const session = await c.query('SELECT token_hash FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE', [createHash('sha256').update(credential, 'ascii').digest(), user])
    if (!session.rowCount) unavailable()
  }
  async function lockOtherAccount(c: PoolClient, sub: string) {
    const r = await c.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=$1 AND enabled=true AND email_verified_at IS NOT NULL FOR SHARE', [sub])
    if (!r.rowCount) unavailable()
  }
  // Recheck after potentially blocking locks. Locks prevent state changes until
  // commit; expiry is evaluated at this authorization point, not at commit.
  async function currentSession(c: PoolClient, credential: string, user: string) {
    if (subject(credential) !== user) unavailable()
    const r = await c.query(`SELECT 1 FROM auth_v2_sessions s JOIN auth_v2_accounts a ON a.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND a.enabled=true AND a.email_verified_at IS NOT NULL`, [createHash('sha256').update(credential, 'ascii').digest(), user])
    if (!r.rowCount) unavailable()
  }
  async function profile(c: PoolClient, profileId: string) {
    const r = await c.query(`SELECT id, subcontractor_id, sub_user_id FROM gc_sub_profiles WHERE id=$1 AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM gc_sub_fresh_profile_evidence e WHERE e.profile_id=gc_sub_profiles.id AND e.evidence_type='fresh_self_asserted_email_control_v1') FOR UPDATE`, [profileId])
    if (!r.rowCount) unavailable()
    return r.rows[0] as { id: string; subcontractor_id: string; sub_user_id: string }
  }
  async function lookupProfile(c: PoolClient, id: string) {
    const r = await c.query(`SELECT sub_user_id FROM gc_sub_profiles WHERE id=$1 AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM gc_sub_fresh_profile_evidence e WHERE e.profile_id=gc_sub_profiles.id AND e.evidence_type='fresh_self_asserted_email_control_v1')`, [id])
    if (!r.rowCount) unavailable()
    return r.rows[0].sub_user_id as string
  }
  function makeToken() { const token = randomBytes(32).toString('base64url'); return { token, hash: digest(token) } }
  async function grant(c: PoolClient, p: { id: string; sub_user_id: string }, gc: string, action: 'granted_qr' | 'granted_invite', consentedAt: Date) {
    await c.query(`INSERT INTO gc_sub_grants(profile_id,gc_user_id,consent_version,consented_at,granted_at,revoked_at)
      VALUES ($1,$2,$3,$4,clock_timestamp(),NULL)
      ON CONFLICT(profile_id,gc_user_id) DO UPDATE SET consent_version=EXCLUDED.consent_version,
        consented_at=EXCLUDED.consented_at, granted_at=EXCLUDED.granted_at, revoked_at=NULL`, [p.id, gc, CONSENT_V2, consentedAt])
    await c.query(`INSERT INTO gc_sub_grant_events(profile_id,gc_user_id,sub_user_id,action,consent_version,consented_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [p.id, gc, p.sub_user_id, action, CONSENT_V2, consentedAt])
  }
  return {
    /** Discover only the caller's own active fresh profile. */
    async getOwnProfile(credential: string) {
      const sub = subject(credential)
      return tx(credential, sub, async c => {
        await lockActors(c, [[sub, 'sub']]); await lockSession(c, credential, sub)
        const r = await c.query(`SELECT p.id FROM gc_sub_profiles p JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id
          WHERE p.sub_user_id=$1 AND p.revoked_at IS NULL AND e.evidence_type='fresh_self_asserted_email_control_v1'`, [sub])
        if (r.rowCount !== 1) unavailable()
        const p = await profile(c, r.rows[0].id)
        if (p.sub_user_id !== sub) unavailable()
        return { profileId: p.id, evidenceType: 'fresh_self_asserted_email_control_v1' }
      })
    },
    /** Explicit pre-consent; raw code is returned once to the authenticated sub for QR encoding. */
    async issueSubQr(credential: string, profileId: string, affirmativeConsent: unknown) {
      const sub = subject(credential); validProfile(profileId); consent(affirmativeConsent)
      return tx(credential, sub, async c => {
        await lockActors(c, [[sub, 'sub']]); await lockSession(c, credential, sub); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        await currentSession(c, credential, sub)
        const { token, hash } = makeToken()
        const r = await c.query(`INSERT INTO gc_sub_capabilities(token_hash,kind,profile_id,consent_version,consented_at,created_at,expires_at)
          VALUES($1,'qr',$2,$3,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes') RETURNING expires_at`, [hash, p.id, CONSENT_V2])
        return { token, expiresAt: r.rows[0].expires_at as Date }
      })
    },
    /** An authenticated GC presents the scanned bearer code; consumption and grant are atomic. */
    async redeemSubQr(credential: string, token: string): Promise<void> {
      const gc = subject(credential); const hash = digest(token)
      return tx(credential, gc, async c => {
        const found = await c.query("SELECT profile_id FROM gc_sub_capabilities WHERE token_hash=$1 AND kind='qr'", [hash])
        if (!found.rowCount) unavailable()
        const id = found.rows[0].profile_id as string; const sub = await lookupProfile(c, id)
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); await lockSession(c, credential, gc); await lockOtherAccount(c, sub); const p = await profile(c, id)
        if (p.sub_user_id !== sub) unavailable()
        await currentSession(c, credential, gc)
        const used = await c.query(`UPDATE gc_sub_capabilities SET used_at=clock_timestamp()
          WHERE token_hash=$1 AND kind='qr' AND profile_id=$2 AND used_at IS NULL AND invalidated_at IS NULL
            AND expires_at > clock_timestamp() AND consent_version=$3 RETURNING consented_at`, [hash, id, CONSENT_V2])
        if (!used.rowCount) unavailable()
        await grant(c, p, gc, 'granted_qr', used.rows[0].consented_at)
      })
    },
    /** Invite is bound to one fresh profile and a current GC; it conveys no sharing consent. */
    async createGcInvite(credential: string, profileId: string) {
      const gc = subject(credential); validProfile(profileId)
      return tx(credential, gc, async c => {
        const sub = await lookupProfile(c, profileId)
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); await lockSession(c, credential, gc); await lockOtherAccount(c, sub); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        await currentSession(c, credential, gc)
        const { token, hash } = makeToken()
        const r = await c.query(`INSERT INTO gc_sub_capabilities(token_hash,kind,profile_id,gc_user_id,created_at,expires_at)
          VALUES($1,'invite',$2,$3,clock_timestamp(),clock_timestamp()+interval '7 days') RETURNING expires_at`, [hash, p.id, gc])
        return { token, expiresAt: r.rows[0].expires_at as Date }
      })
    },
    /** Identify the live inviting account to the profile owner before asking for consent. */
    async previewGcInvite(credential: string, token: string) {
      const sub = subject(credential); const hash = digest(token)
      return tx(credential, sub, async c => {
        await lockActors(c, [[sub, 'sub']]); await lockSession(c, credential, sub); await currentSession(c, credential, sub)
        const r = await c.query(`SELECT g.id AS gc_user_id, g.name AS gc_name, p.id AS profile_id, cap.expires_at
        FROM gc_sub_capabilities cap
        JOIN gc_sub_profiles p ON p.id=cap.profile_id AND p.revoked_at IS NULL AND p.sub_user_id=$2
        JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1'
        JOIN users s ON s.id=p.sub_user_id AND s.role='sub'
        JOIN users g ON g.id=cap.gc_user_id AND g.role='gc'
        JOIN auth_v2_accounts ga ON ga.user_id=g.id AND ga.enabled=true AND ga.email_verified_at IS NOT NULL
        WHERE cap.token_hash=$1 AND cap.kind='invite' AND cap.used_at IS NULL
          AND cap.invalidated_at IS NULL AND cap.expires_at > clock_timestamp()`, [hash, sub])
        if (!r.rowCount) unavailable()
        return r.rows[0]
      })
    },
    /** Only the email-control profile owner can accept, and only after affirmative consent. */
    async acceptGcInvite(credential: string, token: string, affirmativeConsent: unknown): Promise<void> {
      const sub = subject(credential); const hash = digest(token); consent(affirmativeConsent)
      return tx(credential, sub, async c => {
        const found = await c.query("SELECT profile_id,gc_user_id FROM gc_sub_capabilities WHERE token_hash=$1 AND kind='invite'", [hash])
        if (!found.rowCount) unavailable()
        const { profile_id: id, gc_user_id: gc } = found.rows[0] as { profile_id: string; gc_user_id: string }
        await lockActors(c, [[gc, 'gc'], [sub, 'sub']]); await lockSession(c, credential, sub); await lockOtherAccount(c, gc); const p = await profile(c, id)
        if (p.sub_user_id !== sub) unavailable()
        await currentSession(c, credential, sub)
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
      return tx(credential, sub, async c => {
        await lockActors(c, [[sub, 'sub']]); await lockSession(c, credential, sub); const p = await profile(c, profileId)
        if (p.sub_user_id !== sub) unavailable()
        await currentSession(c, credential, sub)
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
      return tx(credential, gc, async c => {
        await lockActors(c, [[gc, 'gc']]); await lockSession(c, credential, gc); await currentSession(c, credential, gc)
        const r = await c.query(`SELECT s.id, s.company_name, s.trade, p.id AS profile_id, e.evidence_type
        FROM gc_sub_grants g JOIN gc_sub_profiles p ON p.id=g.profile_id AND p.revoked_at IS NULL
        JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1'
        JOIN users su ON su.id=p.sub_user_id AND su.role='sub'
        JOIN auth_v2_accounts sa ON sa.user_id=su.id AND sa.enabled=true AND sa.email_verified_at IS NOT NULL
        JOIN users gu ON gu.id=g.gc_user_id AND gu.role='gc'
        JOIN subcontractors s ON s.id=p.subcontractor_id
        WHERE g.gc_user_id=$1 AND g.revoked_at IS NULL AND g.consent_version=$2 ORDER BY s.id`, [gc, CONSENT_V2])
        return r.rows
      })
    },
    async listGrantedCois(credential: string, profileId: string) {
      const gc = subject(credential); validProfile(profileId)
      return tx(credential, gc, async c => {
        await lockActors(c, [[gc, 'gc']]); await lockSession(c, credential, gc); await currentSession(c, credential, gc)
        // Profile-only v2 consent never authorizes COI metadata, even if a mapping exists.
        return []
      })
    },
  }
}
