import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import type pg from 'pg'
import type { SecureV2LimitInput } from './secure-v2-production.ts'
import type { RegistrationRateLimiter } from './v2/registration.ts'

type Budget = readonly [number, number, number]
// Per minute, fixed windows: global / socket peer / subject or identity.
// A window boundary can admit twice the budget in a short burst.
const budgets: Record<string, Budget> = Object.freeze({
  front: [180, 90, 0], login: [60, 30, 5], confirm: [40, 20, 5],
  'auth:preauth': [120, 60, 0], 'auth:principal': [120, 60, 30],
  'protected:preauth': [300, 150, 0], 'protected:principal': [240, 120, 60],
  'connections-router:preauth': [180, 90, 0], 'connections-router:principal': [120, 60, 30],
  'metadata-router:preauth': [30, 15, 0], 'metadata-router:principal': [30, 15, 10],
  'files-router:preauth': [30, 15, 0], 'files-router:principal': [30, 15, 10],
  'registration:request': [30, 15, 3], 'registration:confirm': [30, 15, 5],
})

// All rows in a budget are acquired in global -> peer -> identity order. The
// global row serializes the budget across workers; every decision is one SQL
// statement and committed before it returns. Denials consume global capacity.
// Delete a bounded number of old rows on each call; fresh global limits bound
// new keyed rows. DB errors or uncertain commits are never retried or allowed.
const sql = `WITH now_bucket AS MATERIALIZED (
  SELECT floor(extract(epoch from statement_timestamp()) / 60)::bigint AS m
  FROM public.pilot_rate_config_v1 WHERE singleton = true AND key_check = $7::bytea
), gc AS (
  DELETE FROM public.pilot_rate_buckets_v1 WHERE ctid IN (
    SELECT b.ctid FROM public.pilot_rate_buckets_v1 b, now_bucket n
    WHERE b.minute < n.m - 2 ORDER BY b.minute LIMIT 10 FOR UPDATE OF b SKIP LOCKED
  ) RETURNING 1
), g AS (
  INSERT INTO public.pilot_rate_buckets_v1(bucket_key, minute, hits)
  SELECT $1::bytea, n.m, 1 FROM now_bucket n CROSS JOIN (SELECT count(*) FROM gc) x
  ON CONFLICT (bucket_key, minute) DO UPDATE SET hits=LEAST(public.pilot_rate_buckets_v1.hits+1, 1000000)
  RETURNING hits
), p AS (
  INSERT INTO public.pilot_rate_buckets_v1(bucket_key, minute, hits)
  SELECT $2::bytea, n.m, 1 FROM now_bucket n, g WHERE g.hits <= $4::integer
  ON CONFLICT (bucket_key, minute) DO UPDATE SET hits=LEAST(public.pilot_rate_buckets_v1.hits+1, 1000000)
  RETURNING hits
), i AS (
  INSERT INTO public.pilot_rate_buckets_v1(bucket_key, minute, hits)
  SELECT $3::bytea, n.m, 1 FROM now_bucket n, p WHERE $3::bytea IS NOT NULL AND p.hits <= $5::integer
  ON CONFLICT (bucket_key, minute) DO UPDATE SET hits=LEAST(public.pilot_rate_buckets_v1.hits+1, 1000000)
  RETURNING hits
)
SELECT COALESCE((SELECT hits <= $4::integer FROM g), false)
 AND COALESCE((SELECT hits <= $5::integer FROM p), false)
 AND CASE WHEN $3::bytea IS NULL THEN true ELSE COALESCE((SELECT hits <= $6::integer FROM i), false) END AS allowed`

export function pilotLimiterKeyCheck(secret: Buffer) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('Invalid pilot configuration')
  return createHmac('sha256', secret).update('pilot-rate-key-check-v1', 'utf8').digest()
}
export function createPilotLimiter(pool: pg.Pool, secret: Buffer) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('Invalid pilot configuration')
  const key = Buffer.from(secret)
  const keyCheck = pilotLimiterKeyCheck(key)
  let pending = 0
  const bucket = (scope: string, kind: string, value: string) => createHmac('sha256', key).update(JSON.stringify([scope, kind, value])).digest()
  async function take(scope: string, peer: string, identity?: string): Promise<boolean> {
    const limits = budgets[scope]
    if (!limits || typeof peer !== 'string' || !isIP(peer) || (limits[2] > 0 && (typeof identity !== 'string' || !identity || identity.length > 256 || /[\u0000-\u001f\u007f]/.test(identity))) || (limits[2] === 0 && identity !== undefined)) return false
    if (pending >= 64) return false
    pending++
    try {
      const result = await pool.query(sql, [bucket(scope, 'global', '*'), bucket(scope, 'peer', peer), identity === undefined ? null : bucket(scope, 'identity', identity), ...limits, keyCheck])
      return result.rows.length === 1 && result.rows[0].allowed === true
    } catch { return false } finally { pending-- }
  }
  return {
    async verify() {
      try {
        const r = await pool.query('SELECT 1 FROM public.pilot_rate_config_v1 WHERE singleton = true AND key_check = $1::bytea', [keyCheck])
        return r.rowCount === 1
      } catch { return false }
    },
    front: (peer: string) => take('front', peer),
    login: (peer: string, normalizedEmail: string) => take('login', peer, normalizedEmail),
    confirm: (peer: string, tokenHash: string) => /^[0-9a-f]{64}$/.test(tokenHash) ? take('confirm', peer, tokenHash) : Promise.resolve(false),
    allow(input: SecureV2LimitInput) {
      if (!input || (input.phase !== 'preauth' && input.phase !== 'principal')) return Promise.resolve(false)
      return take(`${input.scope}:${input.phase}`, input.remoteAddress, input.phase === 'principal' ? input.subject : undefined)
    },
    allowRegistration(input: Parameters<RegistrationRateLimiter['allow']>[0]) {
      if (!input || !['request', 'confirm'].includes(input.action) || !/^[0-9a-f]{64}$/.test(input.identityHash)) return Promise.resolve(false)
      return take(`registration:${input.action}`, input.clientAddress, input.identityHash)
    },
  }
}
