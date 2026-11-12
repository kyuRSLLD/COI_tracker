// Opt in: PG_LOCK_ORDER_TEST=1 node --experimental-strip-types --test server/test/connection-lock-order-postgres.test.ts
// Starts a fresh loopback-only PostgreSQL cluster; never reads an inherited DATABASE_URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import pg from 'pg'

const enabled = process.env.PG_LOCK_ORDER_TEST === '1'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const digest = (s: string) => createHash('sha256').update(s).digest('hex')

async function freePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

test('connection lock ordering and full-transaction retries (disposable PostgreSQL)', { skip: !enabled, timeout: 60_000 }, async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'coi-lock-order-pg-'))
  const bin = process.env.PG_LOCK_ORDER_TEST_BIN || '/usr/lib/postgresql/16/bin'
  const pgCommand = (name: string, args: string[]) => execFileSync(path.join(bin, name), args, { stdio: 'pipe' })
  const port = await freePort()
  let started = false
  let server: import('node:http').Server | undefined
  let monitor: pg.Client | undefined
  const pools: pg.Pool[] = []
  const OriginalPool = pg.Pool
  const originalQuery = pg.Client.prototype.query
  // Test-only barrier after a QR transaction really owns the selected user row.
  // This makes the historical QR-vs-join cycle deterministic, not probabilistic.
  const qrClients = new WeakSet<object>()
  let hook: { userId: string; reached: () => void; release: Promise<void> } | undefined
  ;(pg.Client.prototype as any).query = function (...args: any[]) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || ''
    const values = Array.isArray(args[1]) ? args[1] : args[0]?.values || []
    if (/FROM sub_connection_qr_tokens WHERE token_hash = \$1/i.test(sql) && /^\s*SELECT/i.test(sql)) qrClients.add(this)
    const result = (originalQuery as any).apply(this, args)
    const current = hook
    if (current && qrClients.has(this) && /FROM users WHERE id = \$1.*FOR UPDATE/i.test(sql) && values[0] === current.userId && result && typeof result.then === 'function') {
      hook = undefined
      return result.then(async (value: unknown) => { current.reached(); await current.release; return value })
    }
    if (/^(COMMIT|ROLLBACK)\b/i.test(sql)) qrClients.delete(this)
    return result
  }
  pg.Pool = class TestPool extends OriginalPool {
    constructor(config: pg.PoolConfig) { super(config); pools.push(this) }
  }
  try {
    pgCommand('initdb', ['-D', path.join(temp, 'data'), '-A', 'trust', '-U', userInfo().username, '--no-locale', '--encoding=UTF8'])
    pgCommand('pg_ctl', ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -k ${temp} -p ${port}`, '-w', 'start'])
    started = true
    pgCommand('createdb', ['-h', '127.0.0.1', '-p', String(port), 'coi_lock_order_disposable'])
    process.env.DATABASE_URL = `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${port}/coi_lock_order_disposable`
    process.env.NODE_ENV = 'test'
    process.env.JWT_SECRET = 'isolated-lock-order-test-secret'
    process.env.AWS_S3_BUCKET = ''
    process.env.AWS_ACCESS_KEY_ID = ''
    process.env.AWS_SECRET_ACCESS_KEY = ''
    const { createApp } = await import('../src/app.ts')
    const { dbGet, dbRun, dbExec, withTransaction, isPostgres } = await import('../src/db/db.ts')
    const { signToken } = await import('../src/middleware/auth.ts')
    assert.equal(isPostgres, true)
    const app = await createApp()
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    monitor = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await monitor.connect()
    const now = new Date().toISOString()
    // GC sorts before sub, exposing the original inversion.
    for (const [id, role] of [['a-gc', 'gc'], ['b-gc', 'gc'], ['z-sub', 'sub']]) {
      await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, 'unused', id, role, now])
    }
    await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['profile', 'z-sub', 'Profile', 'Trade', now, now])
    const invite = `join-${'a'.repeat(36)}`
    await dbRun('INSERT INTO gc_settings (id, user_id, company_name, invite_code, updated_at) VALUES (?, ?, ?, ?, ?)', ['settings', 'a-gc', 'GC', invite, now])
    const tokens: Record<string, string> = {}
    for (const [id, role] of [['a-gc', 'gc'], ['b-gc', 'gc'], ['z-sub', 'sub']]) tokens[id] = signToken({ id, role, email: `${id}@example.test`, name: id })
    async function request(endpoint: string, id: string, method = 'POST', body?: object) {
      const response = await fetch(base + endpoint, { method, headers: { authorization: `Bearer ${tokens[id]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000) })
      return { status: response.status, body: await response.json() as any }
    }
    async function issue() {
      const response = await request('/api/connection-qr', 'z-sub', 'POST', { consent: true })
      assert.equal(response.status, 200)
      return response.body.token as string
    }
    async function intent() {
      const response = await request(`/api/sub/join-intent/${invite}`, 'z-sub')
      assert.equal(response.status, 200)
      return response.body.intent as string
    }
    const redeem = (gc: string, code: string) => request('/api/connection-qr/redeem', gc, 'POST', { token: code })
    const join = (ticket: string) => request(`/api/sub/join/${invite}`, 'z-sub', 'POST', { consent: true, intent: ticket })
    const disconnect = () => request('/api/sub/connections/a-gc', 'z-sub', 'DELETE')
    async function waitForUserLock() {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const rows = await monitor!.query(`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE '%users%' AND query ILIKE '%FOR UPDATE%' AND cardinality(pg_blocking_pids(pid)) > 0`)
        if (rows.rowCount) return
        await delay(10)
      }
      throw new Error('Expected a user row-lock waiter')
    }
    function pauseQr(userId: string) {
      let reached!: () => void
      let release!: () => void
      const ready = new Promise<void>(resolve => { reached = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      hook = { userId, reached, release: gate }
      return { ready: Promise.race([ready, delay(5000).then(() => { throw new Error('QR barrier not reached') })]), release }
    }
    const count = async (gc: string) => Number((await dbGet<any>('SELECT COUNT(*) AS n FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', [gc, 'profile']))!.n)

    for (const mode of ['intent', 'accept'] as const) {
      await t.test(`QR holds GC while join ${mode} waits on the same first user`, async () => {
        const ticket = mode === 'accept' ? await intent() : undefined
        const code = await issue()
        const barrier = pauseQr('a-gc')
        const qr = redeem('a-gc', code)
        let joinResult: Promise<{ status: number; body: any }> | undefined
        try {
          await barrier.ready
          joinResult = mode === 'intent' ? request(`/api/sub/join-intent/${invite}`, 'z-sub') : join(ticket!)
          await waitForUserLock()
          // A join blocked on a-gc must not already own z-sub. The old
          // subcontractor-first join fails here and deadlocks when QR resumes.
          await monitor!.query('BEGIN')
          try { await monitor!.query("SELECT id FROM users WHERE id = 'z-sub' FOR UPDATE NOWAIT") }
          finally { await monitor!.query('ROLLBACK') }
        } finally { barrier.release() }
        const [qrResult, joining] = await Promise.all([qr, joinResult!])
        assert.equal(qrResult.status, 200)
        assert.equal(joining.status, 200)
        const joinedTicket = mode === 'intent' ? joining.body.intent : ticket!
        if (mode === 'intent') assert.equal((await join(joinedTicket)).status, 200)
        assert.equal((await join(joinedTicket)).status, 409)
        assert.equal(await count('a-gc'), 1)
        assert.equal((await redeem('a-gc', code)).status, 200)
      })
    }

    await t.test('QR grant and disconnect serialize; no replay or stale consent restores access', async () => {
      await dbRun('INSERT INTO gc_sub_connections (gc_user_id, subcontractor_id, created_at) VALUES (?, ?, ?)', ['b-gc', 'profile', now])
      const stale = await intent()
      const code = await issue()
      const unused = await issue()
      const barrier = pauseQr('z-sub')
      const qr = redeem('a-gc', code)
      let removal: Promise<{ status: number; body: any }> | undefined
      try {
        await barrier.ready
        removal = disconnect()
        await waitForUserLock()
      } finally { barrier.release() }
      const [qrResult, removed] = await Promise.all([qr, removal!])
      assert.equal(qrResult.status, 200)
      assert.equal(removed.status, 200)
      assert.equal(await count('a-gc'), 0)
      assert.equal(await count('b-gc'), 1)
      assert.equal((await redeem('a-gc', code)).status, 404)
      assert.equal((await redeem('a-gc', unused)).status, 404)
      assert.equal((await join(stale)).status, 409)
      assert.equal(await count('a-gc'), 0)
      const token = await dbGet<any>('SELECT revoked_at, redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(unused)])
      assert.ok(token.revoked_at)
      assert.equal(token.redeemed_by_gc_user_id, null)
    })

    await t.test('disconnect commits before a QR can finish its user locks', async () => {
      const fresh = await intent()
      assert.equal((await join(fresh)).status, 200)
      const stale = await intent()
      const code = await issue()
      const barrier = pauseQr('a-gc')
      const qr = redeem('a-gc', code)
      try {
        await barrier.ready
        // QR has discovered the token but does not hold the issuer yet.
        assert.equal((await disconnect()).status, 200)
      } finally { barrier.release() }
      assert.equal((await qr).status, 404)
      assert.equal((await join(stale)).status, 409)
      assert.equal(await count('a-gc'), 0)
      const token = await dbGet<any>('SELECT revoked_at, redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(code)])
      assert.ok(token.revoked_at)
      assert.equal(token.redeemed_by_gc_user_id, null)
    })

    await t.test('the subcontractor can also sort first', async () => {
      for (const [id, role] of [['0-sub', 'sub'], ['z-gc', 'gc']]) {
        await dbRun('INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, `${id}@example.test`, 'unused', id, role, now])
        tokens[id] = signToken({ id, role, email: `${id}@example.test`, name: id })
      }
      await dbRun('INSERT INTO subcontractors (id, user_id, company_name, trade, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['other-profile', '0-sub', 'Other', 'Trade', now, now])
      const otherInvite = `join-${'b'.repeat(36)}`
      await dbRun('INSERT INTO gc_settings (id, user_id, company_name, invite_code, updated_at) VALUES (?, ?, ?, ?, ?)', ['other-settings', 'z-gc', 'Other GC', otherInvite, now])
      const codeResponse = await request('/api/connection-qr', '0-sub', 'POST', { consent: true })
      const intentResponse = await request(`/api/sub/join-intent/${otherInvite}`, '0-sub')
      assert.equal(codeResponse.status, 200)
      assert.equal(intentResponse.status, 200)
      const barrier = pauseQr('0-sub')
      const qr = redeem('z-gc', codeResponse.body.token)
      let accepting: Promise<{ status: number; body: any }> | undefined
      try {
        await barrier.ready
        accepting = request(`/api/sub/join/${otherInvite}`, '0-sub', 'POST', { consent: true, intent: intentResponse.body.intent })
        await waitForUserLock()
        await monitor!.query('BEGIN')
        try { await monitor!.query("SELECT id FROM users WHERE id = 'z-gc' FOR UPDATE NOWAIT") }
        finally { await monitor!.query('ROLLBACK') }
      } finally { barrier.release() }
      const [qrResult, joined] = await Promise.all([qr, accepting!])
      assert.equal(qrResult.status, 200)
      assert.equal(joined.status, 200)
      assert.equal(Number((await dbGet<any>('SELECT COUNT(*) AS n FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['z-gc', 'other-profile']))!.n), 1)
    })

    await t.test('a changed QR issuer after discovery never grants access', async () => {
      const code = await issue()
      const barrier = pauseQr('a-gc')
      const qr = redeem('a-gc', code)
      try {
        await barrier.ready
        // Model an independent administrative writer changing the discovered
        // row before it is locked; the transaction must not trust its snapshot.
        await dbRun('UPDATE sub_connection_qr_tokens SET issuer_user_id = ? WHERE token_hash = ?', ['0-sub', digest(code)])
      } finally { barrier.release() }
      assert.equal((await qr).status, 404)
      assert.equal(await count('a-gc'), 0)
      const token = await dbGet<any>('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(code)])
      assert.equal(token.redeemed_by_gc_user_id, null)
    })

    await t.test('a join intent is consumed by at most one concurrent accept', async () => {
      const ticket = await intent()
      const results = await Promise.all([join(ticket), join(ticket)])
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
      assert.equal(await count('a-gc'), 1)
      assert.equal((await disconnect()).status, 200)
      assert.equal((await join(ticket)).status, 409)
      assert.equal(await count('a-gc'), 0)
    })

    await t.test('one QR grants at most one GC under concurrent redemption', async () => {
      // Both candidates start disconnected; the previous test already verified
      // disconnect preserves unrelated links.
      await dbRun('DELETE FROM gc_sub_connections WHERE gc_user_id = ? AND subcontractor_id = ?', ['b-gc', 'profile'])
      const code = await issue()
      const [first, second] = await Promise.all([redeem('a-gc', code), redeem('b-gc', code)])
      assert.deepEqual([first.status, second.status].sort(), [200, 404])
      const token = await dbGet<any>('SELECT redeemed_by_gc_user_id FROM sub_connection_qr_tokens WHERE token_hash = ?', [digest(code)])
      assert.ok(['a-gc', 'b-gc'].includes(token.redeemed_by_gc_user_id))
      assert.equal(await count('a-gc'), token.redeemed_by_gc_user_id === 'a-gc' ? 1 : 0)
      assert.equal(await count('b-gc'), token.redeemed_by_gc_user_id === 'b-gc' ? 1 : 0)
    })

    await t.test('real deadlock retries the whole transaction; serialization retry is bounded', async () => {
      await dbExec('CREATE TABLE retry_test (id TEXT PRIMARY KEY, n INTEGER NOT NULL); INSERT INTO retry_test VALUES (\'one\', 0), (\'two\', 0)')
      let arrived = 0
      let unlock!: () => void
      const gate = new Promise<void>(resolve => { unlock = resolve })
      const attempts = [0, 0]
      const work = (index: number, first: string, second: string) => withTransaction(async tx => {
        attempts[index]++
        await tx.run('UPDATE retry_test SET n = n + 1 WHERE id = ?', [first])
        if (attempts[index] === 1) {
          if (++arrived === 2) unlock()
          await gate
        }
        await tx.run('UPDATE retry_test SET n = n + 1 WHERE id = ?', [second])
      })
      await Promise.all([work(0, 'one', 'two'), work(1, 'two', 'one')])
      assert.equal(attempts[0] + attempts[1], 3)
      assert.equal(Number((await dbGet<any>('SELECT n FROM retry_test WHERE id = ?', ['one']))!.n), 2)
      assert.equal(Number((await dbGet<any>('SELECT n FROM retry_test WHERE id = ?', ['two']))!.n), 2)
      let serialAttempts = 0
      await withTransaction(async tx => {
        serialAttempts++
        await tx.run('UPDATE retry_test SET n = n + 1 WHERE id = ?', ['one'])
        if (serialAttempts === 1) await tx.run("DO $$ BEGIN RAISE EXCEPTION 'test' USING ERRCODE = '40001'; END $$")
      })
      assert.equal(serialAttempts, 2)
      assert.equal(Number((await dbGet<any>('SELECT n FROM retry_test WHERE id = ?', ['one']))!.n), 3)
      let failures = 0
      await assert.rejects(withTransaction(async tx => {
        failures++
        await tx.run('UPDATE retry_test SET n = n + 1 WHERE id = ?', ['one'])
        await tx.run("DO $$ BEGIN RAISE EXCEPTION 'test' USING ERRCODE = '40001'; END $$")
      }), (error: any) => error.code === '40001')
      assert.equal(failures, 3)
      assert.equal(Number((await dbGet<any>('SELECT n FROM retry_test WHERE id = ?', ['one']))!.n), 3)
      let ordinary = 0
      await assert.rejects(withTransaction(async () => { ordinary++; throw new Error('ordinary failure') }), /ordinary failure/)
      assert.equal(ordinary, 1)
    })
  } finally {
    hook = undefined
    pg.Client.prototype.query = originalQuery
    pg.Pool = OriginalPool
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
    if (monitor) await monitor.end()
    await Promise.all(pools.map(pool => pool.end()))
    if (started) pgCommand('pg_ctl', ['-D', path.join(temp, 'data'), '-m', 'immediate', '-w', 'stop'])
    await rm(temp, { recursive: true, force: true })
  }
})
