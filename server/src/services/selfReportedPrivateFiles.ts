// Default-off composable service. No router, pool, cloud client, startup wiring or migration execution.
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import type { PoolClient } from 'pg'
import { CONSENT_V2, UnavailableError } from './gcSubConsent.ts'

export const FILE_CONSENT_V1 = 'share-one-private-coi-file-v1' as const
export const FILE_CONSENT_V1_TEXT = 'I consent to share this specific private file with the identified connected general contractor account until revoked. This does not share other files, future replacements, or provide client access. This document is self-reported and not verified. Profile and metadata consent alone do not share files.'
export type FileMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
type Evidence = { mime: FileMime; size: number; sha256: string }
// These dependencies are trusted server implementations, never request-controlled. The inspector
// must completely inspect exactly the provided bytes and fail on any incomplete scan. Storage must
// be private (no direct access, presigned/public URLs or other download paths), write-once and
// version-bound. A receipt must attest the committed bytes, not merely echo a caller-supplied hash.
export interface PrivateFileInspector { inspect(bytes: Uint8Array, mime: FileMime, signal?: AbortSignal): Promise<Evidence> }
export interface ImmutablePrivateStorage {
  putNew(key: string, bytes: Uint8Array, mime: FileMime, signal?: AbortSignal): Promise<Evidence & { version: string }>
  // Must enforce maxBytes while fetching, before buffering; reject redirects and oversized objects.
  getVersion(key: string, version: string, maxBytes: number): Promise<{ bytes: Uint8Array; version: string }>
}
const fail = (): never => { throw new UnavailableError() }
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256 && x.trim() === x && !/[\u0000-\u001f\u007f]/.test(x)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const authHash = (token: string) => createHash('sha256').update(token,'ascii').digest()
const validVersion = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 512 && x.trim() === x && x !== 'null' && !/[\u0000-\u001f\u007f]/.test(x)
const mimes = new Set(['application/pdf','image/jpeg','image/png','image/webp'])
function matches(e: Evidence | null | undefined, mime: FileMime, bytes: Buffer, digest: string) {
  return !!e && e.mime === mime && e.size === bytes.length && e.sha256 === digest
}

export function selfReportedPrivateFileService(pool: pg.Pool, config: {publicKey:string;issuer:string;audience:string;maxFileBytes:number}, inspector: PrivateFileInspector, storage: ImmutablePrivateStorage) {
  if (!(pool instanceof pg.Pool) || !config || typeof config.issuer !== 'string' || !config.issuer.trim() || config.issuer !== config.issuer.trim() || typeof config.audience !== 'string' || !config.audience.trim() || config.audience !== config.audience.trim() || !Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1 || config.maxFileBytes > 10485760 || !inspector || typeof inspector.inspect !== 'function' || !storage || typeof storage.putNew !== 'function' || typeof storage.getVersion !== 'function') throw new Error('Invalid private file service configuration')
  if (typeof config.publicKey !== 'string' || !/^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/.test(config.publicKey)) throw new Error('Public RSA key required')
  const key = createPublicKey(config.publicKey)
  if (key.type !== 'public' || key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) throw new Error('Public RSA key required')
  const issuer = config.issuer, audience = config.audience, maxFileBytes = config.maxFileBytes
  function subject(token: string): string {
    try {
      if (typeof token !== 'string' || token.length > 8192) return fail()
      const v = jwt.verify(token,key,{algorithms:['RS256'],issuer,audience,maxAge:900})
      if (typeof v === 'string' || v.iss !== issuer || v.aud !== audience || !id(v.sub) || typeof v.exp !== 'number' || !Number.isSafeInteger(v.exp) || typeof v.iat !== 'number' || !Number.isSafeInteger(v.iat) || v.iat > Math.floor(Date.now()/1000) || v.exp <= v.iat || v.exp-v.iat > 900 || typeof v.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.jti)) return fail()
      return v.sub
    } catch { return fail() }
  }
  async function transaction<T>(token: string, fn: (c:PoolClient, actor:string) => Promise<T>, check: () => void = () => {}): Promise<T> {
    let c: PoolClient | undefined
    try {
      check(); const user=subject(token); c=await pool.connect(); await c.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const value=await fn(c,user)
      if (subject(token)!==user) fail()
      const valid=await c.query(`SELECT 1 FROM auth_v2_sessions s JOIN auth_v2_accounts a ON a.user_id=s.user_id WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.enabled=true AND a.email_verified_at IS NOT NULL`,[authHash(token),user])
      if (!valid.rowCount) fail()
      check(); await c.query('COMMIT'); return value
    } catch { if(c) try { await c.query('ROLLBACK') } catch {} return fail() } finally { c?.release() }
  }
  // Match connection service order: sorted users, sorted accounts, caller session, profile,
  // parent connection, then file grant. No external call holds locks during upload/inspection.
  async function actors(c:PoolClient, token:string, actor:string, expected:Array<[string,'gc'|'sub']>) {
    if (new Set(expected.map(x=>x[0])).size !== expected.length) fail()
    const ids=expected.map(x=>x[0])
    const users=await c.query('SELECT id,role FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE',[ids])
    if (users.rowCount!==expected.length || expected.some(([i,r])=>!users.rows.some(x=>x.id===i && x.role===r))) fail()
    const accounts=await c.query('SELECT user_id FROM auth_v2_accounts WHERE user_id=ANY($1::text[]) AND enabled=true AND email_verified_at IS NOT NULL ORDER BY user_id FOR SHARE',[ids])
    if (accounts.rowCount!==expected.length) fail()
    const sess=await c.query('SELECT 1 FROM auth_v2_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE',[authHash(token),actor])
    if (!sess.rowCount) fail()
  }
  async function profile(c:PoolClient, sub:string) {
    const p=await c.query(`SELECT p.id FROM gc_sub_profiles p JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1' WHERE p.sub_user_id=$1 AND p.revoked_at IS NULL FOR UPDATE OF p`,[sub])
    if (p.rowCount!==1) return fail()
    return p.rows[0].id as string
  }
  async function parent(c:PoolClient, p:string, gc:string) {
    const r=await c.query('SELECT 1 FROM gc_sub_grants WHERE profile_id=$1 AND gc_user_id=$2 AND revoked_at IS NULL AND consent_version=$3 FOR SHARE',[p,gc,CONSENT_V2])
    if (!r.rowCount) fail()
  }
  // Bounded result pages ordered by opaque file UUID; the client passes the last
  // UUID in a JSON body, never a query string. No storage internals are projected.
  const page = (rows: any[]) => ({files: rows.slice(0,100), nextCursor: rows.length > 100 ? rows[99].id : null})
  const projection = `f.id, f.coi_id AS "coiId", f.mime, f.size_bytes AS "sizeBytes", f.created_at AS "createdAt", 'self_reported_unverified'::text AS "reportingStatus"`
  async function readFile(row: any) {
    if (!row || !validVersion(row.storage_version) || !mimes.has(row.mime) || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > maxFileBytes || typeof row.sha256 !== 'string') return fail()
    const object=await storage.getVersion(row.storage_key,row.storage_version,row.size_bytes)
    if (!object || object.version!==row.storage_version || !(object.bytes instanceof Uint8Array) || object.bytes.byteLength!==row.size_bytes || object.bytes.byteLength>maxFileBytes) return fail()
    const snapshot=Buffer.from(object.bytes)
    if (sha(snapshot)!==row.sha256) return fail()
    return {bytes:snapshot,mime:row.mime as FileMime}
  }
  return {
    async listOwn(token:string, after:unknown = null) {
      if (after !== null && !uuid(after)) return fail()
      return transaction(token,async(c,sub)=>{
        await actors(c,token,sub,[[sub,'sub']]); const p=await profile(c,sub)
        const r=await c.query(`SELECT ${projection} FROM self_reported_private_files f WHERE f.profile_id=$1 AND f.state='ready' AND ($2::uuid IS NULL OR f.id>$2::uuid) ORDER BY f.id LIMIT 101`,[p,after])
        return page(r.rows)
      })
    },
    async listGranted(token:string, after:unknown = null) {
      if (after !== null && !uuid(after)) return fail()
      return transaction(token,async(c,gc)=>{
        // Candidate discovery is bounded and never returned. Revalidate every
        // candidate under the same ordered authorization locks as download.
        const candidates=await c.query(`SELECT f.id,p.id AS profile_id,p.sub_user_id FROM self_reported_private_file_grants g JOIN self_reported_private_files f ON f.id=g.file_id AND f.profile_id=g.profile_id JOIN gc_sub_profiles p ON p.id=g.profile_id WHERE g.gc_user_id=$1 AND g.revoked_at IS NULL AND f.state='ready' AND ($2::uuid IS NULL OR f.id>$2::uuid) ORDER BY f.id LIMIT 101`,[gc,after])
        const selected=candidates.rows.slice(0,100)
        const subs=[...new Set(selected.map(r=>r.sub_user_id as string))].sort()
        await actors(c,token,gc,[[gc,'gc'],...subs.map(s=>[s,'sub'] as [string,'sub'])])
        const profiles=[...new Set(selected.map(r=>r.profile_id as string))].sort()
        const ids=selected.map(r=>r.id as string)
        await c.query('SELECT id FROM gc_sub_profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[profiles])
        await c.query('SELECT profile_id FROM gc_sub_grants WHERE gc_user_id=$1 AND profile_id=ANY($2::uuid[]) ORDER BY profile_id FOR SHARE',[gc,profiles])
        await c.query('SELECT id FROM self_reported_private_file_grants WHERE gc_user_id=$1 AND file_id=ANY($2::uuid[]) ORDER BY file_id FOR SHARE',[gc,ids])
        const r=await c.query(`SELECT ${projection} FROM self_reported_private_files f JOIN self_reported_private_file_grants g ON g.file_id=f.id AND g.profile_id=f.profile_id JOIN gc_sub_profiles p ON p.id=f.profile_id AND p.revoked_at IS NULL JOIN gc_sub_fresh_profile_evidence e ON e.profile_id=p.id AND e.evidence_type='fresh_self_asserted_email_control_v1' JOIN gc_sub_grants parent ON parent.profile_id=p.id AND parent.gc_user_id=g.gc_user_id AND parent.revoked_at IS NULL AND parent.consent_version=$3 WHERE f.id=ANY($1::uuid[]) AND f.state='ready' AND g.gc_user_id=$2 AND g.revoked_at IS NULL AND g.consent_version=$4 ORDER BY f.id`,[ids,gc,CONSENT_V2,FILE_CONSENT_V1])
        return {files:r.rows, nextCursor:candidates.rows.length > 100 ? selected[99].id : null}
      })
    },
    async downloadOwn(token:string,fileId:unknown) {
      if (!uuid(fileId)) return fail()
      return transaction(token,async(c,sub)=>{
        await actors(c,token,sub,[[sub,'sub']]); const p=await profile(c,sub)
        const f=await c.query("SELECT storage_key,storage_version,mime,size_bytes,sha256 FROM self_reported_private_files WHERE id=$1 AND profile_id=$2 AND state='ready'",[fileId,p])
        return readFile(f.rows[0])
      })
    },
    // The snapshot is made synchronously, before the first await. The inspector and store each
    // receive independent copies; neither the caller nor an adapter can mutate this snapshot.
    async upload(token:string, coiId:unknown, input:Uint8Array, declaredMime:unknown, deadline?: {signal:AbortSignal; deadlineAt:number}) {
      let fileId: string | undefined
      try {
        if (!uuid(coiId) || !(input instanceof Uint8Array) || input.byteLength<1 || input.byteLength>maxFileBytes || typeof declaredMime!=='string' || !mimes.has(declaredMime)) return fail()
        if (deadline && (!(deadline.signal instanceof AbortSignal) || !Number.isSafeInteger(deadline.deadlineAt))) return fail()
        const check=()=>{if(deadline && (deadline.signal.aborted || Date.now()>=deadline.deadlineAt)) fail()}
        check()
        const bytes=Buffer.from(input), mime=declaredMime as FileMime, digest=sha(bytes)
        const newId=randomUUID(), keyName='private-coi/'+randomBytes(32).toString('hex')
        await transaction(token,async(c,sub)=>{
          await actors(c,token,sub,[[sub,'sub']]); const p=await profile(c,sub)
          const record=await c.query('SELECT 1 FROM self_reported_coi_metadata WHERE id=$1 AND profile_id=$2',[coiId,p]); if (!record.rowCount) fail()
          await c.query('INSERT INTO self_reported_private_files(id,coi_id,profile_id,storage_key,mime,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[newId,coiId,p,keyName,mime,bytes.length,digest])
        },check)
        fileId=newId // committed reservation exists before external side effects
        check(); const report=await inspector.inspect(Buffer.from(bytes),mime,deadline?.signal)
        check(); if (!matches(report,mime,bytes,digest)) fail()
        const receipt=await storage.putNew(keyName,Buffer.from(bytes),mime,deadline?.signal)
        check(); if (!matches(receipt,mime,bytes,digest) || !validVersion(receipt.version)) fail()
        const version=receipt.version
        await transaction(token,async(c,sub)=>{
          await actors(c,token,sub,[[sub,'sub']]); const p=await profile(c,sub)
          const r=await c.query("UPDATE self_reported_private_files SET state='ready',storage_version=$1 WHERE id=$2 AND profile_id=$3 AND state='pending' RETURNING id",[version,newId,p])
          if (!r.rowCount) fail()
        },check)
        return {id:newId}
      } catch {
        // If this update itself fails, the durable pending reservation still requires reconciliation.
        if (fileId) try { await pool.query("UPDATE self_reported_private_files SET state='orphan' WHERE id=$1 AND state='pending'",[fileId]) } catch {}
        return fail()
      }
    },
    async grant(token:string, fileId:unknown, gc:unknown, version:unknown, affirmative:unknown) {
      if (!uuid(fileId) || !id(gc) || version!==FILE_CONSENT_V1 || affirmative!==true) return fail()
      return transaction(token,async(c,sub)=>{
        await actors(c,token,sub,[[sub,'sub'],[gc,'gc']]); const p=await profile(c,sub); await parent(c,p,gc)
        const f=await c.query("SELECT 1 FROM self_reported_private_files WHERE id=$1 AND profile_id=$2 AND state='ready'",[fileId,p]); if (!f.rowCount) fail()
        await c.query(`INSERT INTO self_reported_private_file_grants(id,file_id,profile_id,gc_user_id,consent_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT(file_id,gc_user_id) WHERE revoked_at IS NULL DO NOTHING`,[randomUUID(),fileId,p,gc,FILE_CONSENT_V1])
      })
    },
    async revoke(token:string, fileId:unknown, gc:unknown) {
      if (!uuid(fileId) || !id(gc)) return fail()
      return transaction(token,async(c,sub)=>{
        await actors(c,token,sub,[[sub,'sub']]); const p=await profile(c,sub)
        await c.query('UPDATE self_reported_private_file_grants SET revoked_at=clock_timestamp() WHERE file_id=$1 AND profile_id=$2 AND gc_user_id=$3 AND revoked_at IS NULL',[fileId,p,gc])
      })
    },
    async download(token:string, fileId:unknown) {
      if (!uuid(fileId)) return fail()
      return transaction(token,async(c,gc)=>{
        // Discovery is internal only; every fact is revalidated under locks below.
        const candidate=await c.query('SELECT p.sub_user_id FROM self_reported_private_files f JOIN gc_sub_profiles p ON p.id=f.profile_id WHERE f.id=$1',[fileId])
        if (!candidate.rowCount) fail()
        const sub=candidate.rows[0].sub_user_id as string
        await actors(c,token,gc,[[gc,'gc'],[sub,'sub']]); const p=await profile(c,sub); await parent(c,p,gc)
        const grant=await c.query('SELECT 1 FROM self_reported_private_file_grants WHERE file_id=$1 AND profile_id=$2 AND gc_user_id=$3 AND revoked_at IS NULL AND consent_version=$4 FOR SHARE',[fileId,p,gc,FILE_CONSENT_V1])
        if (!grant.rowCount) fail()
        const f=await c.query("SELECT storage_key,storage_version,mime,size_bytes,sha256 FROM self_reported_private_files WHERE id=$1 AND profile_id=$2 AND state='ready'",[fileId,p])
        return readFile(f.rows[0])
      })
    }
  }
}
