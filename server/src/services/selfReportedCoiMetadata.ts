// Disconnected service: no legacy COI table, file storage, client route, or startup wiring.
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import type { PoolClient } from 'pg'
import { UnavailableError, CONSENT_V2 } from './gcSubConsent.ts'

export const METADATA_CONSENT_V1 = 'share-one-self-reported-coi-metadata-v1' as const
export const METADATA_CONSENT_V1_TEXT = 'I consent to share only the metadata of this specific self-reported COI record with the selected connected general contractor account. I can revoke this access; disconnection or loss of eligibility also ends sharing. The information is self-reported and has not been verified. This does not share a certificate document or provide client access. Future or replacement COIs are not included.'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const bad = (): never => { throw new UnavailableError() }
const userId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
const uuid = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const label = (v: unknown, max: number): v is string => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(v) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0,4)) < 1000) return false
  const d = new Date(v + 'T00:00:00.000Z'); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v
}
type Input = { carrier: string; effectiveDate: string; expirationDate: string; coverage: Array<{ type: string; limitCents: number }> }
function validate(v: unknown): Input {
  if (!exact(v, ['carrier','effectiveDate','expirationDate','coverage']) || !label(v.carrier,200) || !date(v.effectiveDate) || !date(v.expirationDate) || v.expirationDate < v.effectiveDate || !Array.isArray(v.coverage) || v.coverage.length < 1 || v.coverage.length > 12) return bad()
  const seen = new Set<string>()
  for (const x of v.coverage) {
    if (!exact(x,['type','limitCents']) || !label(x.type,100) || !Number.isSafeInteger(x.limitCents) || (x.limitCents as number) < 0 || (x.limitCents as number) > 1000000000000 || seen.has(x.type.toLowerCase())) return bad()
    seen.add(x.type.toLowerCase())
  }
  return v as Input
}
const hash = (credential: string) => createHash('sha256').update(credential, 'ascii').digest()
const projection = `m.id, m.profile_id, m.carrier, to_char(m.effective_date,'YYYY-MM-DD') AS effective_date,
  to_char(m.expiration_date,'YYYY-MM-DD') AS expiration_date,
  (SELECT jsonb_agg(jsonb_build_object('type',item->>'type','limitCents',item->'limitCents') ORDER BY ord)
    FROM jsonb_array_elements(m.coverage) WITH ORDINALITY AS coverage_items(item,ord)) AS coverage, m.created_at,
  'self_reported_unverified'::text AS reporting_status`

export function selfReportedCoiMetadataService(pool: pg.Pool, config: { publicKey: string; issuer: string; audience: string }) {
  if (!(pool instanceof pg.Pool)) throw new Error('PostgreSQL pg.Pool required')
  if (!config.issuer?.trim() || !config.audience?.trim()) throw new Error('Issuer and audience required')
  const key = createPublicKey(config.publicKey)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('An RSA public key of at least 2048 bits is required')
  function subject(credential: string): string {
    try {
      if (typeof credential !== 'string' || credential.length > 8192) return bad()
      const v = jwt.verify(credential,key,{ algorithms:['RS256'],issuer:config.issuer,audience:config.audience,maxAge:900 })
      if (typeof v === 'string' || v.iss !== config.issuer || v.aud !== config.audience || !userId(v.sub) || typeof v.exp !== 'number' || !Number.isSafeInteger(v.exp) || typeof v.iat !== 'number' || !Number.isSafeInteger(v.iat) || v.iat > Math.floor(Date.now()/1000) || v.exp <= v.iat || v.exp-v.iat > 900 || typeof v.jti !== 'string' || !TOKEN.test(v.jti)) return bad()
      return v.sub
    } catch { return bad() }
  }
  async function tx<T>(credential: string, fn: (c: PoolClient, user: string) => Promise<T>): Promise<T> {
    const user = subject(credential), c = await pool.connect()
    try {
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await fn(c,user)
      if (subject(credential) !== user) bad()
      const now = await c.query(`SELECT 1 FROM auth_v2_sessions s JOIN auth_v2_accounts a ON a.user_id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.enabled=true AND a.email_verified_at IS NOT NULL`, [hash(credential),user])
      if (!now.rowCount) bad()
      await c.query('COMMIT'); return result
    } catch (error) { try { await c.query('ROLLBACK') } catch {} throw error } finally { c.release() }
  }
  // Same ordering as connection consent: users, accounts, session, profile, grants.
  async function actors(c: PoolClient, actor: string, role: 'sub'|'gc', others: string[] = []) {
    const ids = [...new Set([actor,...others])]
    const users = await c.query('SELECT id,role FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[ids])
    if (!users.rows.some(r => r.id === actor && r.role === role)) bad()
    const accounts = await c.query('SELECT user_id,enabled,email_verified_at FROM auth_v2_accounts WHERE user_id=ANY($1::text[]) ORDER BY user_id FOR SHARE',[ids])
    if (!accounts.rows.some(r => r.user_id === actor && r.enabled && r.email_verified_at)) bad()
    return { users: users.rows, accounts: accounts.rows }
  }
  async function session(c: PoolClient, credential: string, user: string) {
    const s = await c.query('SELECT 1 FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE',[hash(credential),user])
    if (!s.rowCount) bad()
  }
  async function ownProfile(c: PoolClient, user: string) {
    const r = await c.query(`SELECT p.id FROM gc_sub_profiles p JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1' WHERE p.sub_user_id=$1 AND p.revoked_at IS NULL FOR UPDATE OF p`,[user])
    if (r.rowCount !== 1) return bad()
    return r.rows[0].id as string
  }
  return {
    async create(credential: string, input: unknown) {
      const v = validate(input)
      return tx(credential,async (c,sub) => {
        await actors(c,sub,'sub'); await session(c,credential,sub); const profile = await ownProfile(c,sub)
        const r = await c.query(`INSERT INTO self_reported_coi_metadata(id,profile_id,carrier,effective_date,expiration_date,coverage) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,[randomUUID(),profile,v.carrier,v.effectiveDate,v.expirationDate,JSON.stringify(v.coverage)])
        return { id: r.rows[0].id }
      })
    },
    async listOwn(credential: string) {
      return tx(credential,async (c,sub) => {
        await actors(c,sub,'sub'); await session(c,credential,sub); const profile = await ownProfile(c,sub)
        const r = await c.query(`SELECT ${projection} FROM self_reported_coi_metadata m WHERE m.profile_id=$1 ORDER BY m.created_at,m.id`,[profile])
        return r.rows
      })
    },
    async listConnectedGcs(credential: string) {
      return tx(credential,async (c,sub) => {
        await actors(c,sub,'sub'); await session(c,credential,sub); const profile = await ownProfile(c,sub)
        const r = await c.query(`SELECT u.id AS gc_user_id,u.name AS gc_name FROM gc_sub_grants g JOIN users u ON u.id=g.gc_user_id AND u.role='gc' JOIN auth_v2_accounts a ON a.user_id=u.id AND a.enabled=true AND a.email_verified_at IS NOT NULL WHERE g.profile_id=$1 AND g.revoked_at IS NULL AND g.consent_version=$2 ORDER BY u.id`,[profile,CONSENT_V2])
        return r.rows
      })
    },
    async grant(credential: string, coiId: unknown, gcId: unknown, consentVersion: unknown, affirmative: unknown) {
      if (!uuid(coiId) || !userId(gcId) || consentVersion !== METADATA_CONSENT_V1 || affirmative !== true) return bad()
      return tx(credential,async (c,sub) => {
        if (gcId === sub) bad()
        const a = await actors(c,sub,'sub',[gcId]); await session(c,credential,sub)
        if (!a.users.some(r => r.id===gcId && r.role==='gc') || !a.accounts.some(r => r.user_id===gcId && r.enabled && r.email_verified_at)) bad()
        const profile = await ownProfile(c,sub)
        const parent = await c.query('SELECT 1 FROM gc_sub_grants WHERE profile_id=$1 AND gc_user_id=$2 AND revoked_at IS NULL AND consent_version=$3 FOR SHARE',[profile,gcId,CONSENT_V2])
        if (!parent.rowCount) bad()
        const record = await c.query('SELECT 1 FROM self_reported_coi_metadata WHERE id=$1 AND profile_id=$2',[coiId,profile])
        if (!record.rowCount) bad()
        // Repeated affirmative action is idempotent; revoked history is never restored.
        await c.query(`INSERT INTO self_reported_coi_grants(id,coi_id,profile_id,gc_user_id,consent_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT (coi_id,gc_user_id) WHERE revoked_at IS NULL DO NOTHING`,[randomUUID(),coiId,profile,gcId,METADATA_CONSENT_V1])
      })
    },
    async revoke(credential: string, coiId: unknown, gcId: unknown) {
      if (!uuid(coiId) || !userId(gcId)) return bad()
      return tx(credential,async (c,sub) => {
        await actors(c,sub,'sub'); await session(c,credential,sub); const profile = await ownProfile(c,sub)
        await c.query(`UPDATE self_reported_coi_grants SET revoked_at=clock_timestamp() WHERE profile_id=$1 AND coi_id=$2 AND gc_user_id=$3 AND revoked_at IS NULL`,[profile,coiId,gcId])
      })
    },
    async listGranted(credential: string) {
      return tx(credential,async (c,gc) => {
        // Candidate discovery is internal; locks and final predicate revalidate everything.
        const candidates = await c.query(`SELECT DISTINCT p.id,p.sub_user_id FROM self_reported_coi_grants g JOIN gc_sub_profiles p ON p.id=g.profile_id WHERE g.gc_user_id=$1 AND g.revoked_at IS NULL`,[gc])
        const ids = candidates.rows.map(r => r.sub_user_id as string), profiles = candidates.rows.map(r => r.id as string)
        await actors(c,gc,'gc',ids); await session(c,credential,gc)
        await c.query('SELECT id FROM gc_sub_profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[profiles])
        await c.query('SELECT profile_id FROM gc_sub_grants WHERE gc_user_id=$1 AND profile_id=ANY($2::uuid[]) ORDER BY profile_id FOR SHARE',[gc,profiles])
        const r = await c.query(`SELECT ${projection} FROM self_reported_coi_grants g
          JOIN self_reported_coi_metadata m ON m.id=g.coi_id AND m.profile_id=g.profile_id
          JOIN gc_sub_profiles p ON p.id=g.profile_id AND p.revoked_at IS NULL
          JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1'
          JOIN users su ON su.id=p.sub_user_id AND su.role='sub'
          JOIN auth_v2_accounts sa ON sa.user_id=su.id AND sa.enabled=true AND sa.email_verified_at IS NOT NULL
          JOIN gc_sub_grants parent ON parent.profile_id=g.profile_id AND parent.gc_user_id=g.gc_user_id AND parent.revoked_at IS NULL AND parent.consent_version=$3
          WHERE g.gc_user_id=$1 AND g.profile_id=ANY($2::uuid[]) AND g.revoked_at IS NULL AND g.consent_version=$4 ORDER BY m.created_at,m.id`,[gc,profiles,CONSENT_V2,METADATA_CONSENT_V1])
        return r.rows
      })
    },
  }
}
