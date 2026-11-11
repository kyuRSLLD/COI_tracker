import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import express from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migrateSelfReportedCoiMetadataV1 } from '../src/db/migrations/006_self_reported_coi_metadata.ts'
import { migrateSelfReportedPrivateFilesV1 } from '../src/db/migrations/007_self_reported_private_files.ts'
import { migrateFreshFixture, addFreshFixtureEvidence } from './fresh-profile-fixture.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { gcSubConsentService, CONSENT_V2 } from '../src/services/gcSubConsent.ts'
import { selfReportedCoiMetadataService, METADATA_CONSENT_V1 } from '../src/services/selfReportedCoiMetadata.ts'
import { selfReportedPrivateFileService, FILE_CONSENT_V1, type FileMime, type PrivateFileInspector } from '../src/services/selfReportedPrivateFiles.ts'
import { inspectPrivateFile } from '../src/services/privateFileInspection.ts'
import { createPrivateFileS3Storage, type PrivateFileS3Client } from '../src/services/privateFileS3Storage.ts'
import { mockScanner } from './mock-clamav-fixture.ts'

const url=process.env.GC_SUB_TEST_PG_URL
if (!url) throw new Error('Explicit disposable loopback GC_SUB_TEST_PG_URL required')
const u=new URL(url)
if (!['postgres:','postgresql:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !/^\/gc_sub_test_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error('Disposable loopback database required')
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function lockWaiters(pool:pg.Pool,n:number) {
  for(let i=0;i<150;i++) { const r=await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='file_test' AND wait_event_type='Lock' AND query LIKE '%gc_sub_profiles%'"); if(r.rows[0].n>=n) return; await pause(20) }
  throw new Error('Expected profile lock wait')
}
test('fresh self-reported file is scanned, version-bound and shared only on explicit file consent',async(t)=>{
  const schema='file_test_'+randomUUID().replaceAll('-','')
  const admin=new pg.Client({connectionString:url}); await admin.connect()
  let pool:pg.Pool|undefined, server:ReturnType<express.Express['listen']>|undefined
  try {
    const ver=await admin.query("SELECT current_setting('server_version_num')::int v"); assert.ok(ver.rows[0].v>=160000 && ver.rows[0].v<170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:12,application_name:'file_test'})
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,name TEXT,password_hash TEXT);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,company_name TEXT NOT NULL,trade TEXT NOT NULL,status TEXT,contact_person TEXT,phone TEXT,email TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,certificate_key TEXT,certificate_url TEXT)`)
    const c=await pool.connect()
    try {
      await migrateGcSubConsentV1(c); await migrateAuthV2V1(c); await migrateFreshFixture(c); await migrateSelfReportedCoiMetadataV1(c)
      assert.equal(await migrateSelfReportedPrivateFilesV1(c),'applied'); assert.equal(await migrateSelfReportedPrivateFilesV1(c),'already-applied')
      const old=(await c.query('SELECT checksum FROM self_reported_private_file_schema_migrations')).rows[0].checksum
      await c.query("UPDATE self_reported_private_file_schema_migrations SET checksum='changed'"); await assert.rejects(migrateSelfReportedPrivateFilesV1(c),/history/)
      await c.query('UPDATE self_reported_private_file_schema_migrations SET checksum=$1',[old])
      for (const ledger of ['gc_sub_schema_migrations','auth_v2_schema_migrations','registration_v2_schema_migrations','fresh_sub_profile_schema_migrations','self_reported_coi_schema_migrations']) {
        const prior=(await c.query(`SELECT checksum FROM ${ledger}`)).rows[0].checksum
        await c.query(`UPDATE ${ledger} SET checksum='changed'`); await assert.rejects(migrateSelfReportedPrivateFilesV1(c),/prerequisite/)
        await c.query(`UPDATE ${ledger} SET checksum=$1`,[prior])
      }
      assert.equal(await migrateSelfReportedPrivateFilesV1(c),'already-applied')
    } finally { c.release() }
    const keys=generateKeyPairSync('rsa',{modulusLength:2048})
    const config={privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),issuer:'file-test',audience:'file-test'}
    const password='synthetic password 12345', passhash=await hashV2Password(password)
    await pool.query(`INSERT INTO users(id,role,name,email) VALUES ('sub','sub','Sub','sub@example.test'),('sub2','sub','Other','sub2@example.test'),('gc1','gc','GC 1','gc1@example.test'),('gc2','gc','GC 2','gc2@example.test'),('client','admin','Client','client@example.test');
      INSERT INTO subcontractors VALUES ('s1','Sub','Trade','active','x','x','x'),('s2','Other','Trade','active','x','x','x');
      INSERT INTO cois VALUES ('legacy','s1','legacy','2020','2030','active','SECRET_LEGACY_KEY','SECRET_LEGACY_URL')`)
    await pool.query("INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) SELECT id,email,$1,now(),'synthetic',true FROM users",[passhash])
    const p=randomUUID(),p2=randomUUID()
    await pool.query("INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference) VALUES($1,'s1','sub',now(),'email-control-only:test'),($2,'s2','sub2',now(),'email-control-only:test2')",[p,p2])
    await addFreshFixtureEvidence(pool,p); await addFreshFixtureEvidence(pool,p2)
    const auth=createV2Auth(pool,config), app=express(); app.use('/auth',auth.router); server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server!.once('listening',r))
    const login=async(name:string)=>{ const r=await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:name+'@example.test',password})}); assert.equal(r.status,200); return (await r.json()).token as string }
    let sub=await login('sub'),gc1=await login('gc1'); const sub2=await login('sub2'),gc2=await login('gc2'),client=await login('client')
    const connections=gcSubConsentService(pool,config), meta=selfReportedCoiMetadataService(pool,config)
    const connect=async(gc:string)=>{const q=await connections.issueSubQr(sub,p,CONSENT_V2); await connections.redeemSubQr(gc,q.token)}
    await connect(gc1); await connect(gc2)
    const coi=await meta.create(sub,{carrier:'Synthetic',effectiveDate:'2026-01-01',expirationDate:'2027-01-01',coverage:[{type:'General liability',limitCents:1}]})
    await meta.grant(sub,coi.id,'gc1',METADATA_CONSENT_V1,true)
    const data=Buffer.from('%PDF-synthetic-clean'), alternate=Buffer.from('%PDF-different-content')
    let scanMode='ok', storageMode='ok', inspectStarted:(()=>void)|undefined, inspectRelease:(()=>void)|undefined, gate:Promise<void>|undefined
    let getStarted:(()=>void)|undefined, getGate:Promise<void>|undefined
    const store=new Map<string,{bytes:Buffer,version:string}>()
    let puts=0, gets=0
    const inspector={async inspect(b:Uint8Array,mime:FileMime) {
      if (inspectStarted) inspectStarted(); if(gate) await gate
      if(scanMode==='throw' || Buffer.from(b).toString()==='malformed') throw new Error('private scanner details')
      const evidence={mime,size:b.length,sha256:digest(b)}
      if(scanMode==='bad-digest') evidence.sha256='0'.repeat(64)
      if(scanMode==='bad-size') evidence.size++
      if(scanMode==='bad-mime') evidence.mime='image/png'
      if(scanMode==='mutate') b[0]=0
      return evidence
    }}
    const storage={async putNew(k:string,b:Uint8Array,mime:FileMime) {
      puts++; if (store.has(k)) throw new Error('overwrite')
      if(storageMode==='throw-before') throw new Error('secret storage failure')
      const version=randomBytes(16).toString('hex'), copy=Buffer.from(b)
      store.set(k,{bytes:copy,version})
      if(storageMode==='throw-after') throw new Error('ambiguous write failure')
      return {mime,size:copy.length,sha256:storageMode==='bad-digest'?'0'.repeat(64):digest(copy),version:storageMode==='no-version'?'':storageMode==='null-version'?'null':version}
    },async getVersion(k:string,v:string,maxBytes:number){ gets++; if(getStarted) getStarted(); if(getGate) await getGate; const r=store.get(k); if(!r || r.version!==v || r.bytes.length>maxBytes || storageMode==='read-fail') throw new Error('secret storage error'); return {bytes:Buffer.from(r.bytes),version:storageMode==='wrong-version'?'wrong':r.version} }}
    const files=selfReportedPrivateFileService(pool,{...config,maxFileBytes:1024},inspector,storage)
    const unavailable=async(f:Promise<unknown>)=>assert.rejects(f,(e:any)=>e.message==='Unavailable')
    assert.throws(() => selfReportedPrivateFileService(pool!, {...config,maxFileBytes:1024}, null as any, storage), /configuration/)
    assert.throws(() => selfReportedPrivateFileService(pool!, {...config,maxFileBytes:1024}, {} as any, storage), /configuration/)
    assert.throws(() => selfReportedPrivateFileService(pool!, {...config,maxFileBytes:1024}, inspector, {} as any), /configuration/)
    const signed=jwt.sign({},keys.privateKey,{algorithm:'RS256',issuer:config.issuer,audience:config.audience,subject:'sub',jwtid:randomBytes(32).toString('base64url'),expiresIn:'5m'})
    await unavailable(files.upload(signed,coi.id,data,'application/pdf')); await unavailable(files.upload(client,coi.id,data,'application/pdf')); await unavailable(files.upload(sub2,coi.id,data,'application/pdf'))
    await unavailable(files.upload(sub,coi.id,data,'text/plain')); await unavailable(files.upload(sub,coi.id,Buffer.alloc(0),'application/pdf')); await unavailable(files.upload(sub,coi.id,Buffer.alloc(1025),'application/pdf'))
    for (const mode of ['throw','bad-digest','bad-size','bad-mime']) { scanMode=mode; const before=puts; await unavailable(files.upload(sub,coi.id,data,'application/pdf')); assert.equal(puts,before) }
    for (const bad of [null, undefined, {}, {mime:'application/pdf',size:data.length,sha256:digest(data).toUpperCase()}]) {
      const invalid=selfReportedPrivateFileService(pool,{...config,maxFileBytes:1024},{inspect:async()=>bad as any},storage)
      const before=puts; await unavailable(invalid.upload(sub,coi.id,data,'application/pdf')); assert.equal(puts,before)
    }
    scanMode='ok'; { const before=puts; await unavailable(files.upload(sub,coi.id,Buffer.from('malformed'),'application/pdf')); assert.equal(puts,before) }
    for (const mode of ['throw-before','throw-after','bad-digest','no-version','null-version']) {storageMode=mode; await unavailable(files.upload(sub,coi.id,data,'application/pdf'))}
    storageMode='ok'
    let started!:()=>void; const startedP=new Promise<void>(r=>started=r); inspectStarted=started; gate=new Promise<void>(r=>inspectRelease=r)
    const mutable=Buffer.from(data), uploading=files.upload(sub,coi.id,mutable,'application/pdf')
    await startedP; mutable.fill(0); inspectRelease!(); const file=await uploading; gate=undefined; inspectStarted=undefined
    assert.deepEqual(Object.keys(file),['id'])
    // Snapshot, storage ID and authorization are per upload, even for identical bytes.
    const duplicate=await files.upload(sub,coi.id,data,'application/pdf'); assert.notEqual(duplicate.id,file.id)
    for (const [mime,sample] of [['image/jpeg','jpeg'],['image/png','png'],['image/webp','webp']] as const) {
      const other=await files.upload(sub,coi.id,Buffer.from(sample),mime); assert.ok(other.id); await unavailable(files.download(gc1,other.id))
    }
    await unavailable(files.download(gc1,file.id)); await unavailable(files.download(gc2,file.id)); await unavailable(files.download(client,file.id)); await unavailable(files.download(sub,file.id))
    assert.equal(gets,0) // No unauthorized request reaches private storage.
    await unavailable(files.grant(sub,file.id,'gc1',METADATA_CONSENT_V1,true)); await unavailable(files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,false)); await unavailable(files.grant(sub2,file.id,'gc1',FILE_CONSENT_V1,true))
    await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true); const download=await files.download(gc1,file.id); assert.deepEqual(download.bytes,data); assert.equal(download.mime,'application/pdf'); assert.deepEqual(Object.keys(download).sort(),['bytes','mime'])
    await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    assert.equal((await pool.query('SELECT count(*)::int n FROM self_reported_private_file_grants WHERE file_id=$1 AND revoked_at IS NULL',[file.id])).rows[0].n,1)
    await unavailable(files.revoke(gc2,file.id,'gc1')); await unavailable(files.revoke(client,file.id,'gc1'))
    // A different valid sub receives no ownership information and cannot change this grant.
    await files.revoke(sub2,file.id,'gc1'); assert.deepEqual((await files.download(gc1,file.id)).bytes,data)
    await unavailable(files.download(gc2,file.id)); await unavailable(files.download(client,file.id)); await unavailable(files.download(gc1,duplicate.id))
    await t.test('file service with isolated S3 adapter and synthetic SDK transport', async () => {
      const objects=new Map<string,{bytes:Buffer; mime:string; sha:string; version:string}>()
      const operations:string[]=[]
      let stall=false, entered!:()=>void, release!:()=>void
      const gate=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r)
      const sdk={async send(command:any, options:{abortSignal:AbortSignal}) {
        operations.push(command.constructor.name)
        const i=command.input
        if(command instanceof PutObjectCommand) {
          assert.equal(i.IfNoneMatch,'*'); assert.equal(objects.has(i.Key),false)
          if(stall) { entered(); await gate }
          const bytes=Buffer.from(i.Body), sha=createHash('sha256').update(bytes).digest('base64')
          assert.equal(i.ChecksumSHA256,sha)
          objects.set(i.Key,{bytes,mime:i.ContentType,sha,version:'synthetic-version'})
          return {VersionId:'synthetic-version'}
        }
        const obj=objects.get(i.Key); assert.ok(obj); assert.equal(i.VersionId,obj.version)
        assert.equal(i.ChecksumMode,'ENABLED')
        const headers={VersionId:obj.version,ContentLength:obj.bytes.length,ContentType:obj.mime,ChecksumSHA256:obj.sha,ChecksumType:'FULL_OBJECT'}
        if(command instanceof HeadObjectCommand) return headers
        assert.ok(command instanceof GetObjectCommand)
        return {...headers,Body:Readable.from([obj.bytes])}
      }}
      const s3=createPrivateFileS3Storage({bucket:'private-example-bucket',expectedBucketOwner:'123456789012',maxFileBytes:1024,deadlineMs:5000},sdk as unknown as PrivateFileS3Client)
      const integrated=selfReportedPrivateFileService(pool!,{...config,maxFileBytes:1024},inspector,s3)
      const controller=new AbortController()
      const uploaded=await integrated.upload(sub,coi.id,data,'application/pdf',{signal:controller.signal,deadlineAt:Date.now()+5000})
      await unavailable(integrated.download(gc1,uploaded.id))
      assert.deepEqual((await integrated.downloadOwn(sub,uploaded.id)).bytes,data)
      await integrated.grant(sub,uploaded.id,'gc1',FILE_CONSENT_V1,true)
      assert.deepEqual((await integrated.download(gc1,uploaded.id)).bytes,data)
      await integrated.revoke(sub,uploaded.id,'gc1'); await unavailable(integrated.download(gc1,uploaded.id))
      assert.deepEqual(operations,['PutObjectCommand','HeadObjectCommand','GetObjectCommand','GetObjectCommand'])
      stall=true
      const cancellation=new AbortController()
      const pending=integrated.upload(sub,coi.id,data,'application/pdf',{signal:cancellation.signal,deadlineAt:Date.now()+5000})
      await started; cancellation.abort(); await unavailable(pending)
      const operationCount=operations.length
      release(); await pause(20)
      assert.equal(operations.length,operationCount) // no HEAD after cancelled PUT, even if it commits late
      assert.equal(objects.size,2) // ambiguous object requires reconciliation
    })
    await t.test('actual parser adapter, mock ClamAV and version-bound synthetic storage', { skip: !process.env.PRIVATE_INSPECTION_TEST_PYTHON && 'Set PRIVATE_INSPECTION_TEST_PYTHON to run real-parser composition' }, async () => {
      const python = process.env.PRIVATE_INSPECTION_TEST_PYTHON!
      assert.ok(python.startsWith('/'))
      let reply='stream: OK\0'
      const scanner=await mockScanner(socket => socket.end(reply))
      try {
        const cfg={socketPath:scanner.path,maxFileBytes:1024*1024,scannerDeadlineMs:3000,parserDeadlineMs:5000,pythonPath:python,prlimitPath:'/usr/bin/prlimit',pdfRendererPath:'/usr/bin/pdftoppm',parserMemoryBytes:512*1024*1024,parserCpuSeconds:10}
        const adapter: PrivateFileInspector={inspect:(bytes,mime)=>inspectPrivateFile(bytes,mime,cfg)}
        const real=selfReportedPrivateFileService(pool!,{...config,maxFileBytes:cfg.maxFileBytes},adapter,storage)
        const png=await readFile(new URL('./fixtures/private-inspection/sample.png',import.meta.url))
        const before=puts, image=await real.upload(sub,coi.id,png,'image/png')
        assert.equal(puts,before+1); assert.deepEqual(scanner.received,[png])
        const storedRow=(await pool!.query('SELECT storage_key,storage_version,mime,size_bytes,sha256 FROM self_reported_private_files WHERE id=$1',[image.id])).rows[0]
        assert.equal(storedRow.mime,'image/png'); assert.equal(storedRow.size_bytes,png.length); assert.equal(storedRow.sha256,digest(png))
        assert.deepEqual(store.get(storedRow.storage_key)?.bytes,png); assert.equal(store.get(storedRow.storage_key)?.version,storedRow.storage_version)
        await unavailable(real.download(gc1,image.id)); await unavailable(real.download(gc2,image.id)); await unavailable(real.download(client,image.id))
        await unavailable(real.grant(sub,image.id,'gc1',METADATA_CONSENT_V1,true))
        await real.grant(sub,image.id,'gc1',FILE_CONSENT_V1,true); assert.deepEqual((await real.download(gc1,image.id)).bytes,png)
        await unavailable(real.download(gc2,image.id)); await unavailable(real.download(client,image.id))
        await real.revoke(sub,image.id,'gc1'); await unavailable(real.download(gc1,image.id))
        const after=puts; await unavailable(real.upload(sub,coi.id,Buffer.concat([png,Buffer.from('junk')]),'image/png')); assert.equal(puts,after)
        reply='stream: Synthetic-Test FOUND\0'; await unavailable(real.upload(sub,coi.id,png,'image/png')); assert.equal(puts,after)
        assert.equal(scanner.count,2)
      } finally { await scanner.close() }
    })
    scanMode='mutate'; const second=await files.upload(sub,coi.id,alternate,'application/pdf'); scanMode='ok'; await unavailable(files.download(gc1,second.id))
    for (const mode of ['read-fail','wrong-version']) {storageMode=mode; await unavailable(files.download(gc1,file.id))} storageMode='ok'
    const row=(await pool.query('SELECT storage_key FROM self_reported_private_files WHERE id=$1',[file.id])).rows[0]; const stored=store.get(row.storage_key)!; stored.bytes[0]=0; await unavailable(files.download(gc1,file.id)); stored.bytes=Buffer.from(data)
    // An in-flight download holds authorization locks; revoke is serialized, and every later
    // download fails. Bytes already handed off after authorization cannot be recalled.
    let releaseGet!:()=>void, beganGet!:()=>void
    const beganGetPromise=new Promise<void>(r=>beganGet=r); getStarted=beganGet; getGate=new Promise<void>(r=>releaseGet=r)
    const inFlight=files.download(gc1,file.id); await beganGetPromise
    const concurrentRevoke=files.revoke(sub,file.id,'gc1'); await lockWaiters(pool,1)
    releaseGet(); assert.deepEqual((await inFlight).bytes,data); await concurrentRevoke; getStarted=undefined; getGate=undefined
    await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    await files.revoke(sub,file.id,'gc1'); await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true); assert.deepEqual((await files.download(gc1,file.id)).bytes,data)
    // Disconnect precedes a competing grant while both wait on the same profile lock.
    const blocker=await pool.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE',[p])
    const disconnect=connections.revoke(sub,p,'gc1'); let competing:Promise<unknown>|undefined
    try {await lockWaiters(pool,1); competing=files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true).then(()=>null,e=>e); await lockWaiters(pool,2)} finally {await blocker.query('ROLLBACK'); blocker.release()}
    await disconnect; assert.equal((await competing as Error).message,'Unavailable'); await unavailable(files.download(gc1,file.id))
    await connect(gc1); await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    await pool.query("UPDATE users SET role='admin' WHERE id='gc1'"); await pool.query("UPDATE users SET role='gc' WHERE id='gc1'"); gc1=await login('gc1'); await unavailable(files.download(gc1,file.id)); await connect(gc1); await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    await pool.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc1'"); await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc1'"); gc1=await login('gc1'); await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    await pool.query("UPDATE auth_v2_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",[createHash('sha256').update(gc1,'ascii').digest()])
    let expiredReadStart!:()=>void, expiredReadRelease!:()=>void; const expiredReadStarted=new Promise<void>(r=>expiredReadStart=r)
    getStarted=expiredReadStart; getGate=new Promise<void>(r=>expiredReadRelease=r)
    const expiredDownload=files.download(gc1,file.id); await expiredReadStarted; await pause(1300); expiredReadRelease(); await unavailable(expiredDownload)
    getStarted=undefined; getGate=undefined; gc1=await login('gc1'); assert.deepEqual((await files.download(gc1,file.id)).bytes,data)
    await pool.query("UPDATE users SET role='admin' WHERE id='sub'"); await pool.query("UPDATE users SET role='sub' WHERE id='sub'"); await unavailable(files.download(gc1,file.id)); await unavailable(files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)); sub=await login('sub'); await connect(gc1); await unavailable(files.download(gc1,file.id)); await files.grant(sub,file.id,'gc1',FILE_CONSENT_V1,true)
    // A session expiring while inspection is in progress cannot promote its uploaded object.
    let beginExpired!:()=>void; const beganExpired=new Promise<void>(r=>beginExpired=r); inspectStarted=beginExpired; gate=new Promise<void>(r=>inspectRelease=r)
    const expiresDuringUpload=files.upload(sub,coi.id,data,'application/pdf'); await beganExpired
    await pool.query('UPDATE auth_v2_sessions SET expires_at=clock_timestamp() WHERE token_hash=$1',[createHash('sha256').update(sub,'ascii').digest()])
    inspectRelease!(); await unavailable(expiresDuringUpload); inspectStarted=undefined; gate=undefined; sub=await login('sub')
    await pool.query('UPDATE gc_sub_profiles SET revoked_at=now() WHERE id=$1',[p]); await unavailable(files.download(gc1,file.id)); await unavailable(files.upload(sub,coi.id,data,'application/pdf'))
    const events=await pool.query('SELECT action FROM self_reported_private_file_grant_events ORDER BY id'); assert.ok(events.rows.filter(r=>r.action==='granted').length>=4); assert.ok(events.rows.filter(r=>r.action==='revoked').length>=4)
    assert.ok((await pool.query("SELECT count(*)::int n FROM self_reported_private_files WHERE state='orphan'")).rows[0].n>=8)
    await assert.rejects(pool.query('UPDATE self_reported_private_files SET sha256=$2 WHERE id=$1',[file.id,'0'.repeat(64)]),/immutable/)
    await assert.rejects(pool.query('UPDATE self_reported_private_file_grant_events SET action=action'),/immutable/)
    assert.equal((await pool.query('SELECT count(*)::int n FROM gc_sub_coi_ownership')).rows[0].n,0)
    assert.deepEqual((await pool.query("SELECT certificate_key,certificate_url FROM cois WHERE id='legacy'")).rows,[{certificate_key:'SECRET_LEGACY_KEY',certificate_url:'SECRET_LEGACY_URL'}])
    assert.ok(gets>0)
  } finally { if(server) await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve())); if(pool) await pool.end(); try {await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)} finally {await admin.end()} }
})
