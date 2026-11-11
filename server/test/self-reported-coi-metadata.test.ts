import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express from 'express'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { migrateGcSubConsentV1 } from '../src/db/migrations/002_gc_sub_consent.ts'
import { migrateAuthV2V1 } from '../src/db/migrations/003_auth_v2.ts'
import { migrateSelfReportedCoiMetadataV1 } from '../src/db/migrations/006_self_reported_coi_metadata.ts'
import { migrateFreshFixture, addFreshFixtureEvidence } from './fresh-profile-fixture.ts'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'
import { gcSubConsentService, CONSENT_V2 } from '../src/services/gcSubConsent.ts'
import { selfReportedCoiMetadataService, METADATA_CONSENT_V1, METADATA_CONSENT_V1_TEXT } from '../src/services/selfReportedCoiMetadata.ts'
import { createSelfReportedCoiMetadataV2Router } from '../src/routes/selfReportedCoiMetadataV2.ts'

const url = process.env.GC_SUB_TEST_PG_URL
if (!url) throw new Error('Explicit disposable loopback GC_SUB_TEST_PG_URL required')
const u = new URL(url)
if (!['postgres:','postgresql:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !/^\/gc_sub_test_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error('Disposable loopback gc_sub_test_* database required')
const keys = generateKeyPairSync('rsa',{modulusLength:2048})
const config = {privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),issuer:'metadata-test',audience:'metadata-test'}
const password = 'synthetic password 12345'
const data = {carrier:'Example Insurance',effectiveDate:'2026-01-01',expirationDate:'2027-01-01',coverage:[{type:'General liability',limitCents:100000000}]}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
async function waitForProfileWaiters(pool: pg.Pool, count: number) {
  for (let i=0; i<100; i++) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='metadata_synthetic_test' AND wait_event_type='Lock' AND query LIKE '%gc_sub_profiles%'`)
    if (r.rows[0].n >= count) return
    await sleep(20)
  }
  throw new Error('Expected synthetic lock wait did not occur')
}

test('fresh QR profile → separate per-record consent; revocations and expiry fail closed',async () => {
  const schema = `gc_sub_test_${randomUUID().replace(/-/g,'')}`
  const admin = new pg.Client({connectionString:url}); await admin.connect()
  let pool: pg.Pool | undefined, server: ReturnType<express.Express['listen']> | undefined
  try {
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS v")
    assert.ok(version.rows[0].v>=160000 && version.rows[0].v<170000)
    await admin.query(`CREATE SCHEMA ${schema}`)
    pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:12,application_name:'metadata_synthetic_test'})
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,name TEXT,password_hash TEXT);
      CREATE TABLE subcontractors(id TEXT PRIMARY KEY,company_name TEXT NOT NULL,trade TEXT NOT NULL,status TEXT,contact_person TEXT,phone TEXT,email TEXT);
      CREATE TABLE cois(id TEXT PRIMARY KEY,subcontractor_id TEXT NOT NULL,carrier TEXT NOT NULL,effective_date TEXT NOT NULL,expiration_date TEXT NOT NULL,status TEXT,certificate_key TEXT,certificate_url TEXT)`)
    const migration = await pool.connect()
    try {
      await migrateGcSubConsentV1(migration); await migrateAuthV2V1(migration); await migrateFreshFixture(migration)
      assert.equal(await migrateSelfReportedCoiMetadataV1(migration),'applied')
      assert.equal(await migrateSelfReportedCoiMetadataV1(migration),'already-applied')
      const checksum = (await migration.query('SELECT checksum FROM self_reported_coi_schema_migrations')).rows[0].checksum
      await migration.query("UPDATE self_reported_coi_schema_migrations SET checksum='tampered'")
      await assert.rejects(migrateSelfReportedCoiMetadataV1(migration),/changed metadata migration history/)
      await migration.query('UPDATE self_reported_coi_schema_migrations SET checksum=$1',[checksum])
      const prereq = (await migration.query('SELECT checksum FROM auth_v2_schema_migrations')).rows[0].checksum
      await migration.query("UPDATE auth_v2_schema_migrations SET checksum='tampered'")
      await assert.rejects(migrateSelfReportedCoiMetadataV1(migration),/prerequisite/)
      await migration.query('UPDATE auth_v2_schema_migrations SET checksum=$1',[prereq])
    } finally { migration.release() }
    const passhash = await hashV2Password(password)
    await pool.query(`INSERT INTO users(id,role,name,email) VALUES ('sub1','sub','Same','sub1@example.test'),('sub2','sub','Same','sub2@example.test'),('gc1','gc','Same','gc1@example.test'),('gc2','gc','Same','gc2@example.test'),('client','admin','Same','client@example.test');
      INSERT INTO subcontractors VALUES ('s1','Same','Trade','active','secret','secret','same@example.test'),('s2','Same','Trade','active','secret','secret','same@example.test');
      INSERT INTO cois VALUES ('legacy','s1','Legacy','2020','2030','active','SECRET_PRIVATE_KEY','https://private.test/SECRET_PRIVATE_URL')`)
    await pool.query(`INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) SELECT id,email,$1,clock_timestamp(),'synthetic',true FROM users`,[passhash])
    const p1=randomUUID(), p2=randomUUID()
    await pool.query(`INSERT INTO gc_sub_profiles(id,subcontractor_id,sub_user_id,verified_at,verification_reference) VALUES($1,'s1','sub1',now(),'email-control-only:synthetic1'),($2,'s2','sub2',now(),'email-control-only:synthetic2')`,[p1,p2])
    await addFreshFixtureEvidence(pool,p1); await addFreshFixtureEvidence(pool,p2)
    const consent = gcSubConsentService(pool,config), metadata = selfReportedCoiMetadataService(pool,config), auth = createV2Auth(pool,config)
    const app = express()
    app.use('/auth',auth.router)
    app.use('/metadata',createSelfReportedCoiMetadataV2Router({service:metadata,authenticate:auth.requireAuth,checkRateLimit:async () => true}))
    server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server!.once('listening',resolve))
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const login = async (id:string) => { const r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:`${id}@example.test`,password})}); assert.equal(r.status,200); return (await r.json()).token as string }
    const call = async (path:string,token:string,body?:unknown) => {
      const r=await fetch(base+'/metadata'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
      assert.match(r.headers.get('cache-control')||'',/no-store/); const text=await r.text(); return {status:r.status,body:text?JSON.parse(text):null,text}
    }
    let sub1=await login('sub1')
    const sub2=await login('sub2'),gc1=await login('gc1'),gc2=await login('gc2'),client=await login('client')
    assert.match(METADATA_CONSENT_V1_TEXT,/self-reported/); assert.match(METADATA_CONSENT_V1_TEXT,/certificate document/); assert.match(METADATA_CONSENT_V1_TEXT,/client access/)
    assert.deepEqual((await call('/consent',sub1)).body,{version:METADATA_CONSENT_V1,text:METADATA_CONSENT_V1_TEXT})
    const signedWithoutSession=jwt.sign({},keys.privateKey,{algorithm:'RS256',issuer:config.issuer,audience:config.audience,subject:'sub1',jwtid:randomBytes(32).toString('base64url'),expiresIn:'5m'})
    await assert.rejects(metadata.create(signedWithoutSession,data),/Unavailable/)
    const qr=await consent.issueSubQr(sub1,p1,CONSENT_V2); await consent.redeemSubQr(gc1,qr.token)
    assert.deepEqual((await call('/connected-gcs',sub1)).body.generalContractors,[{gc_user_id:'gc1',gc_name:'Same'}])
    for (const input of [ {...data,profileId:p2}, {...data,carrier:''}, {...data,effectiveDate:'2026-02-30'}, {...data,expirationDate:'2025-01-01'}, {...data,coverage:[]}, {...data,coverage:[{type:'x',limitCents:-1}]}, {...data,coverage:[{type:'x',limitCents:1,file:'secret'}]}, {...data,coverage:[{type:'x',limitCents:1},{type:'X',limitCents:2}]} ]) assert.equal((await call('/own',sub1,input)).status,404)
    const a=await call('/own',sub1,data); assert.equal(a.status,200); const id=a.body.id
    await assert.rejects(pool.query(`INSERT INTO self_reported_coi_metadata(id,profile_id,carrier,effective_date,expiration_date,coverage) VALUES($1,$2,'x','2026-01-01','2027-01-01',$3::jsonb)`,[randomUUID(),p1,JSON.stringify([{type:'x',limitCents:1,certificateKey:'private'}])]),/check constraint/)
    assert.deepEqual((await call('/granted',gc1)).body.records,[])
    assert.deepEqual((await call('/granted',gc2)).body.records,[])
    assert.deepEqual((await call('/own',sub2)).body.records,[])
    const own=(await call('/own',sub1)).body.records
    assert.equal(own.length,1); assert.deepEqual(Object.keys(own[0]).sort(),['carrier','coverage','created_at','effective_date','expiration_date','id','profile_id','reporting_status'].sort())
    assert.equal(own[0].reporting_status,'self_reported_unverified'); assert.equal(own[0].profile_id,p1)
    const grant={coiId:id,gcUserId:'gc1',consentVersion:METADATA_CONSENT_V1,affirmative:true}
    assert.equal((await call('/grant',sub2,grant)).status,404)
    assert.equal((await call('/grant',sub1,{...grant,gcUserId:'gc2'})).status,404)
    assert.equal((await call('/grant',sub1,{...grant,affirmative:false})).status,404)
    assert.equal((await call('/grant',sub1,{...grant,consentVersion:CONSENT_V2})).status,404)
    assert.equal((await call('/grant',sub1,{...grant,profileId:p2})).status,404)
    // Both GCs are now connected, but profile-only QR consent grants no metadata.
    const secondQr=await consent.issueSubQr(sub1,p1,CONSENT_V2); await consent.redeemSubQr(gc2,secondQr.token)
    assert.deepEqual((await call('/connected-gcs',sub1)).body.generalContractors.map((x:any) => x.gc_user_id),['gc1','gc2'])
    assert.deepEqual((await call('/granted',gc2)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    assert.deepEqual((await call('/granted',gc1)).body.records,own)
    assert.deepEqual((await call('/granted',gc2)).body.records,[])
    const b=await call('/own',sub1,{...data,carrier:'Replacement'}); assert.equal(b.status,200)
    assert.deepEqual((await call('/granted',gc1)).body.records.map((x:any)=>x.id),[id])
    assert.equal((await call('/granted',client)).status,401)
    assert.ok(!JSON.stringify((await call('/granted',gc1)).body).includes('SECRET_PRIVATE'))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gc_sub_coi_ownership')).rows[0].n,0)
    assert.deepEqual((await pool.query("SELECT id,carrier,certificate_key,certificate_url FROM cois WHERE id='legacy'")).rows,[{id:'legacy',carrier:'Legacy',certificate_key:'SECRET_PRIVATE_KEY',certificate_url:'https://private.test/SECRET_PRIVATE_URL'}])
    await assert.rejects(pool.query("UPDATE self_reported_coi_metadata SET carrier='tampered' WHERE id=$1",[id]),/immutable/)
    assert.equal((await call('/revoke',sub2,{coiId:id,gcUserId:'gc1'})).status,204)
    assert.equal((await call('/granted',gc1)).body.records.length,1)
    assert.equal((await call('/revoke',sub1,{coiId:id,gcUserId:'gc1'})).status,204)
    assert.deepEqual((await call('/granted',gc1)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    assert.equal((await call('/granted',gc1)).body.records.length,1)
    // Queue disconnect first and a competing grant second, both behind a profile lock.
    // The second operation must recheck parent eligibility after the first commits.
    const profileBlocker=await pool.connect(); await profileBlocker.query('BEGIN'); await profileBlocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE',[p1])
    const disconnect=consent.revoke(sub1,p1,'gc1')
    let competing: Promise<unknown> | undefined
    try {
      await waitForProfileWaiters(pool,1)
      competing=metadata.grant(sub1,id,'gc1',METADATA_CONSENT_V1,true).then(() => null, error => error)
      await waitForProfileWaiters(pool,2)
    } finally { await profileBlocker.query('ROLLBACK'); profileBlocker.release() }
    await disconnect; assert.match(String(await competing),/Unavailable/)
    assert.deepEqual((await call('/granted',gc1)).body.records,[])
    const qr2=await consent.issueSubQr(sub1,p1,CONSENT_V2); await consent.redeemSubQr(gc1,qr2.token)
    assert.deepEqual((await call('/granted',gc1)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    await pool.query("UPDATE users SET role='admin' WHERE id='gc1'")
    await pool.query("UPDATE users SET role='gc' WHERE id='gc1'")
    const gc1new=await login('gc1')
    assert.deepEqual((await call('/granted',gc1new)).body.records,[])
    const qr3=await consent.issueSubQr(sub1,p1,CONSENT_V2); await consent.redeemSubQr(gc1new,qr3.token)
    assert.deepEqual((await call('/granted',gc1new)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    await pool.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='gc1'")
    await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='gc1'")
    let gc1again=await login('gc1')
    assert.deepEqual((await call('/granted',gc1again)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    const account = (await pool.query("SELECT * FROM auth_v2_accounts WHERE user_id='gc1'")).rows[0]
    await pool.query("DELETE FROM auth_v2_accounts WHERE user_id='gc1'")
    await pool.query('INSERT INTO auth_v2_accounts(user_id,login_email,password_hash,email_verified_at,verification_reference,enabled) VALUES($1,$2,$3,$4,$5,$6)',[account.user_id,account.login_email,account.password_hash,account.email_verified_at,account.verification_reference,account.enabled])
    gc1again=await login('gc1')
    assert.deepEqual((await call('/granted',gc1again)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    await pool.query("UPDATE users SET role='admin' WHERE id='sub1'")
    await pool.query("UPDATE users SET role='sub' WHERE id='sub1'")
    assert.equal((await call('/own',sub1)).status,401)
    sub1=await login('sub1')
    assert.deepEqual((await call('/granted',gc1again)).body.records,[])
    const qr4=await consent.issueSubQr(sub1,p1,CONSENT_V2); await consent.redeemSubQr(gc1again,qr4.token)
    assert.deepEqual((await call('/granted',gc1again)).body.records,[])
    assert.equal((await call('/grant',sub1,grant)).status,204)
    await pool.query('UPDATE gc_sub_profiles SET revoked_at=clock_timestamp() WHERE id=$1',[p1])
    assert.deepEqual((await call('/granted',gc1again)).body.records,[])
    assert.equal((await call('/own',sub1)).status,404)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM self_reported_coi_grants WHERE revoked_at IS NULL')).rows[0].n,0)
    // A session that expires while waiting on a profile lock cannot commit a record.
    const sub2session=await login('sub2')
    await pool.query("UPDATE auth_v2_sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",[createHash('sha256').update(sub2session,'ascii').digest()])
    const blocker=await pool.connect(); await blocker.query('BEGIN'); await blocker.query('SELECT id FROM gc_sub_profiles WHERE id=$1 FOR UPDATE',[p2])
    const pending=metadata.create(sub2session,data)
    try { await waitForProfileWaiters(pool,1); await sleep(1300) } finally { await blocker.query('ROLLBACK'); blocker.release() }
    await assert.rejects(pending,/Unavailable/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM self_reported_coi_metadata WHERE profile_id=$1',[p2])).rows[0].n,0)
    assert.equal((await call('/own',sub2session)).status,401)
    const history=await pool.query('SELECT count(*)::int AS n FROM self_reported_coi_grants WHERE coi_id=$1 AND revoked_at IS NOT NULL',[id]); assert.ok(history.rows[0].n>=4)
  } finally {
    if (server) await new Promise<void>((resolve,reject)=>server!.close(err=>err?reject(err):resolve()))
    if (pool) await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.end() }
  }
})
