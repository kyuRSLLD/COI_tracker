// Optional, unmounted shared limiter. Manually provision the schema in a reviewed
// environment; never automatically create tables or connect at app startup.
import { createHash } from 'node:crypto'
import pg from 'pg'
import type { PoolClient } from 'pg'

const ddl = `CREATE TABLE private_files_rate_limit_v1 (
  bucket_hash BYTEA PRIMARY KEY CHECK (octet_length(bucket_hash)=32),
  hits INTEGER NOT NULL CHECK (hits>0), expires_at TIMESTAMPTZ NOT NULL
)`
const checksum=createHash('sha256').update(ddl).digest('hex')
/** Explicit manual migration only, on a dedicated idle connection. */
export async function migratePrivateFilesRateLimitV1(c: PoolClient): Promise<'applied'|'already-applied'> {
  await c.query('BEGIN')
  try {
    await c.query('SELECT pg_advisory_xact_lock(1129273683,8)')
    await c.query('CREATE TABLE IF NOT EXISTS private_files_rate_limit_schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL)')
    const history=await c.query('SELECT version,checksum FROM private_files_rate_limit_schema_migrations')
    if (history.rows.some(r=>r.version!==1 || r.checksum!==checksum)) throw new Error('Unknown rate limit migration')
    if(history.rowCount) {await c.query('COMMIT'); return 'already-applied'}
    await c.query(ddl)
    await c.query('INSERT INTO private_files_rate_limit_schema_migrations(version,checksum) VALUES(1,$1)',[checksum])
    await c.query('COMMIT'); return 'applied'
  } catch(e) {try {await c.query('ROLLBACK')} catch {} throw e}
}
/** All instances must use the same database, namespace, window and limits. */
export function createPrivateFilesPostgresLimiter(pool:pg.Pool, config:{windowSeconds:number; preauthMax:number; principalMax:number}) {
  if (!(pool instanceof pg.Pool) || !config || !Number.isSafeInteger(config.windowSeconds) || config.windowSeconds<1 || config.windowSeconds>86400 || !Number.isSafeInteger(config.preauthMax) || config.preauthMax<1 || config.preauthMax>1000000 || !Number.isSafeInteger(config.principalMax) || config.principalMax<1 || config.principalMax>1000000) throw new Error('Invalid shared limiter configuration')
  return async (input:{phase:'preauth'|'principal'; remoteAddress:string; subject?:string}): Promise<boolean> => {
    if (!input || !['preauth','principal'].includes(input.phase) || typeof input.remoteAddress!=='string' || !input.remoteAddress || input.remoteAddress.length>128) return false
    const identity=input.phase==='preauth' ? input.remoteAddress : input.subject
    if (typeof identity!=='string' || !identity || identity.length>256 || /[\u0000-\u001f\u007f]/.test(identity)) return false
    const key=createHash('sha256').update('private-files-v1\0'+input.phase+'\0'+identity,'utf8').digest()
    const max=input.phase==='preauth' ? config.preauthMax : config.principalMax
    // One atomic UPSERT; contention is serialized by the unique row lock.
    // Errors propagate to the router, which fails closed. All instances need
    // one authoritative writable database, not read replicas or process memory.
    const result=await pool.query(`INSERT INTO private_files_rate_limit_v1(bucket_hash,hits,expires_at)
      VALUES($1,1,clock_timestamp()+make_interval(secs=>$2))
      ON CONFLICT(bucket_hash) DO UPDATE SET
        hits=CASE WHEN private_files_rate_limit_v1.expires_at<=clock_timestamp() THEN 1 ELSE private_files_rate_limit_v1.hits+1 END,
        expires_at=CASE WHEN private_files_rate_limit_v1.expires_at<=clock_timestamp() THEN clock_timestamp()+make_interval(secs=>$2) ELSE private_files_rate_limit_v1.expires_at END
      WHERE private_files_rate_limit_v1.expires_at<=clock_timestamp() OR private_files_rate_limit_v1.hits<$3
      RETURNING hits`,[key,config.windowSeconds,max])
    return result.rowCount===1
  }
}
