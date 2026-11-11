import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import type { RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { migrateAnonymousReportsV1 } from '../src/db/migrations/006_anonymous_client_reports.ts'
import { createAnonymousReportsV1Router } from '../src/routes/anonymousReportsV1.ts'

function safeUrl() {
  const value = process.env.REPORT_TEST_PG_URL
  if (!value) throw new Error('REPORT_TEST_PG_URL must be an explicitly disposable loopback database')
  const u = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(u.protocol) || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !/^\/report_test_[a-z0-9_]+$/.test(u.pathname) || u.search || u.hash) throw new Error('Unsafe test database URL')
  return value
}
const digest = (s: string) => createHash('sha256').update(s, 'ascii').digest()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('synthetic isolated report API, projection, authorization and races', async () => {
  const url = safeUrl(), schema = 'report_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Client({ connectionString: url }); await admin.connect()
  let pool: pg.Pool | undefined, server: ReturnType<express.Express['listen']> | undefined, made = false
  try {
    await admin.query(`CREATE SCHEMA ${schema}`); made = true
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 10 })
    await pool.query(`CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL);
      CREATE TABLE auth_v2_accounts(user_id TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL,email_verified_at TIMESTAMPTZ);
      CREATE TABLE auth_v2_sessions(token_hash BYTEA PRIMARY KEY,user_id TEXT NOT NULL,revoked_at TIMESTAMPTZ,expires_at TIMESTAMPTZ NOT NULL);
      INSERT INTO users VALUES ('owner-a','gc'),('owner-b','gc'),('sub','sub');
      INSERT INTO auth_v2_accounts VALUES ('owner-a',true,now()),('owner-b',true,now()),('sub',true,now())`)
    const migrationClient = await pool.connect()
    try { assert.equal(await migrateAnonymousReportsV1(migrationClient), 'applied'); assert.equal(await migrateAnonymousReportsV1(migrationClient), 'already-applied') } finally { migrationClient.release() }
    const p1 = randomUUID(), p2 = randomUUID(), disabled = randomUUID(), unmapped = randomUUID()
    // These are deliberately new, isolated report projects; no legacy project is mapped.
    await pool.query('INSERT INTO report_v1_projects(id,owner_user_id,enabled) VALUES($1,$3,true),($2,$4,true),($5,$3,false)', [p1,p2,'owner-a','owner-b',disabled])
    const poison = 'ACME Legal person phone 555-5555 contact@example.test carrier SECRET-POLICY-987 https://bad.invalid/document key-id notes'
    await pool.query('ALTER TABLE report_v1_members ADD COLUMN extra JSONB; ALTER TABLE report_v1_projects ADD COLUMN extra JSONB')
    await pool.query('UPDATE report_v1_projects SET extra=$1', [JSON.stringify({ names: [poison, { inner: poison }] })])
    const inserted = await pool.query(`INSERT INTO report_v1_members(project_id,source_ref,status,extra) VALUES
      ($1,$3,'compliant',$4),($1,'other','pending',$4),($2,$3,'unknown',$4) RETURNING label`, [p1,p2,poison,JSON.stringify({ nested: [{ name: poison, email: poison, carrier: poison, policy: poison, url: poison, id: poison, notes: poison }] })])
    const [l1,l2,l3] = inserted.rows.map(row => row.label)
    assert.notEqual(l1,l2); assert.notEqual(l1,l3); assert.match(l1,/^Member-[0-9a-f]{32}$/)
    await pool.query("UPDATE report_v1_members SET status='pending' WHERE project_id=$1 AND source_ref=$2",[p1,poison])
    const unchanged = await pool.query("UPDATE report_v1_members SET status='compliant' WHERE project_id=$1 AND source_ref=$2 RETURNING label",[p1,poison])
    assert.equal(unchanged.rows[0].label,l1)
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), tokens: Record<string,string> = {}
    for (const subject of ['owner-a','owner-b','sub']) {
      const t = jwt.sign({},keys.privateKey,{algorithm:'RS256',issuer:'test',audience:'test',subject,jwtid:randomBytes(32).toString('base64url'),expiresIn:900})
      tokens[subject] = t
      await pool.query("INSERT INTO auth_v2_sessions VALUES($1,$2,NULL,now()+interval '15 minutes')", [digest(t),subject])
    }
    const auth: RequestHandler = (req,res,next) => {
      const t = req.get('authorization')?.replace(/^Bearer /,'')
      try {
        const v = jwt.verify(t || '',keys.publicKey,{algorithms:['RS256'],issuer:'test',audience:'test',maxAge:900}) as jwt.JwtPayload
        const role = v.sub === 'sub' ? 'sub' : 'gc'
        Object.defineProperty(req,'securePrincipal',{value:Object.freeze({subject:v.sub,role,credential:t}),writable:false,configurable:false}); next()
      } catch { res.status(401).json({error:'Authentication required'}) }
    }
    const app = express()
    app.use('/off',createAnonymousReportsV1Router())
    app.use('/report',createAnonymousReportsV1Router({enabled:true,pool,authenticate:auth}))
    server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',() => resolve(s)) })
    const address = server!.address(); assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    async function call(path: string, data: unknown, who?: string, method='POST') {
      const res = await fetch(base+path,{method,headers:{'content-type':'application/json',...(who ? {authorization:`Bearer ${tokens[who]}`} : {})},...(method === 'POST' ? {body:JSON.stringify(data)} : {})})
      assert.equal(res.headers.get('cache-control'),'no-store'); assert.equal(res.headers.get('referrer-policy'),'no-referrer')
      const text = await res.text()
      return {status:res.status,body:text ? JSON.parse(text) : undefined}
    }
    const spec = {project_id:p1,scope:'anonymous-report:v1',ttl_seconds:3600}
    assert.equal((await call('/off/owner/create',spec,'owner-a')).status,404)
    assert.equal((await call('/report/owner/create',spec)).status,401)
    assert.equal((await call('/report/owner/create',spec,'sub')).status,404)
    for (const id of [p2, disabled, unmapped]) assert.equal((await call('/report/owner/create',{...spec,project_id:id},'owner-a')).status,404)
    for (const body of [{...spec,scope:'all'}, {...spec,ttl_seconds:604801},{...spec,ttl_seconds:0},{...spec,owner:'owner-b'}, {...spec,project_id:'bad'}]) assert.equal((await call('/report/owner/create',body,'owner-a')).status,400)
    const created = await call('/report/owner/create',spec,'owner-a')
    assert.equal(created.status,201); assert.deepEqual(Object.keys(created.body).sort(),['expires_at','scope','token']); const secret = created.body.token as string
    assert.match(secret,/^[A-Za-z0-9_-]{43}$/)
    const stored = await pool.query('SELECT token_hash,scope,project_id FROM report_v1_capabilities')
    assert.equal(stored.rows.length,1); assert.ok(stored.rows[0].token_hash.equals(digest(secret))); assert.equal(stored.rows[0].scope,spec.scope)
    const report = await call('/report/redeem',{token:secret})
    assert.equal(report.status,200); assert.deepEqual(Object.keys(report.body).sort(),['members','schema'])
    assert.equal(report.body.schema,'anonymous-report-v1')
    assert.deepEqual(report.body.members,[{label:l1,status:'compliant'},{label:l2,status:'pending'}].sort((a,b)=>a.label.localeCompare(b.label)))
    assert.doesNotMatch(JSON.stringify(report),/ACME|Legal|person|contact|example|carrier|SECRET|POLICY|https|document|notes|owner|project|source|token|key-id/i)
    const other = await call('/report/owner/create',{...spec,project_id:p2},'owner-b')
    const otherReport = await call('/report/redeem',{token:other.body.token})
    assert.deepEqual(otherReport.body,{schema:'anonymous-report-v1',members:[{label:l3,status:'unknown'}]})
    assert.notEqual(otherReport.body.members[0].label,report.body.members.find((m: any) => m.label===l1).label)
    assert.deepEqual((await call('/report/redeem',{token:secret})).body,report.body)
    assert.equal((await call('/report/redeem',{token:secret,extra:{contact:poison}})).status,400)
    assert.equal((await call('/report/redeem?token='+secret,{})).status,404)
    assert.equal((await call('/report/redeem',{},undefined,'GET')).status,404)
    assert.equal((await call('/report/owner/revoke',{project_id:p2,scope:spec.scope,token:secret},'owner-b')).status,404)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:secret},'owner-b')).status,404)
    assert.equal((await call('/report/redeem',{token:secret})).status,200)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:secret},'owner-a')).status,204)
    assert.equal((await call('/report/redeem',{token:secret})).status,404)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:secret},'owner-a')).status,404)
    const expired = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    await pool.query("UPDATE report_v1_capabilities SET created_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1",[digest(expired)])
    assert.equal((await call('/report/redeem',{token:expired})).status,404)
    const waiting = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT token_hash FROM report_v1_capabilities WHERE token_hash=$1 FOR UPDATE',[digest(waiting)])
      const pending = call('/report/redeem',{token:waiting})
      await sleep(200)
      await blocker.query('UPDATE report_v1_capabilities SET revoked_at=clock_timestamp() WHERE token_hash=$1',[digest(waiting)])
      await blocker.query('COMMIT')
      assert.equal((await pending).status,404)
    } finally { try { await blocker.query('ROLLBACK') } catch {} blocker.release() }
    // Queue the real revoke endpoint behind a lock, then queue a redemption.
    // Once revoke commits first, the waiter must observe the revoked row.
    const raced = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    const gate = await pool.connect()
    try {
      await gate.query('BEGIN'); await gate.query('SELECT token_hash FROM report_v1_capabilities WHERE token_hash=$1 FOR UPDATE',[digest(raced)])
      const revoking = call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:raced},'owner-a')
      let blocked = false
      for (let i=0; i<60; i++) {
        const r = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE report_v1_capabilities SET revoked_at%' ")
        if (r.rowCount) { blocked=true; break }
        await sleep(25)
      }
      assert.ok(blocked,'revoke must be waiting on the token lock')
      const reading = call('/report/redeem',{token:raced})
      await sleep(100); await gate.query('COMMIT')
      assert.equal((await revoking).status,204); assert.equal((await reading).status,404)
    } finally { try { await gate.query('ROLLBACK') } catch {} gate.release() }
    const timed = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    const blocker2 = await pool.connect()
    try {
      await blocker2.query('BEGIN')
      await blocker2.query("UPDATE report_v1_capabilities SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",[digest(timed)])
      const pending = call('/report/redeem',{token:timed}); await sleep(1250)
      await blocker2.query('COMMIT'); assert.equal((await pending).status,404)
    } finally { try { await blocker2.query('ROLLBACK') } catch {} blocker2.release() }
    const active = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    const revokeDisabled = (await call('/report/owner/create',spec,'owner-a')).body.token as string
    await pool.query('UPDATE report_v1_projects SET enabled=false WHERE id=$1',[p1])
    assert.equal((await call('/report/redeem',{token:active})).status,404)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:revokeDisabled},'owner-a')).status,204)
    await pool.query('UPDATE report_v1_projects SET enabled=true WHERE id=$1',[p1])
    assert.equal((await call('/report/redeem',{token:revokeDisabled})).status,404)
    assert.equal((await call('/report/redeem',{token:active})).status,200)
    await pool.query("UPDATE auth_v2_accounts SET enabled=false WHERE user_id='owner-a'")
    assert.equal((await call('/report/redeem',{token:active})).status,404)
    assert.equal((await call('/report/owner/create',spec,'owner-a')).status,401)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:active},'owner-a')).status,401)
    await pool.query("UPDATE auth_v2_accounts SET enabled=true WHERE user_id='owner-a'; UPDATE auth_v2_sessions SET revoked_at=now() WHERE user_id='owner-a'")
    assert.equal((await call('/report/owner/create',spec,'owner-a')).status,401)
    assert.equal((await call('/report/owner/revoke',{project_id:p1,scope:spec.scope,token:active},'owner-a')).status,401)
    await pool.query("UPDATE auth_v2_sessions SET revoked_at=NULL,expires_at=clock_timestamp()-interval '1 second' WHERE user_id='owner-a'")
    assert.equal((await call('/report/owner/create',spec,'owner-a')).status,401)
    await pool.query("UPDATE users SET role='sub' WHERE id='owner-a'")
    assert.equal((await call('/report/redeem',{token:active})).status,404)
    assert.equal((await call('/report/owner/create',spec,'owner-a')).status,404)
  } finally {
    if (server) await new Promise<void>((resolve,reject) => server!.close(e => e ? reject(e) : resolve()))
    if (pool) await pool.end()
    if (made) await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
