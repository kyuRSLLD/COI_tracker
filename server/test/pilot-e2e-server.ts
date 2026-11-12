// TEST ONLY. Only launched by scripts/test-pilot-e2e.sh in a fresh cluster.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createPilot } from '../src/pilot-bootstrap.ts'
import { pilotLimiterKeyCheck } from '../src/pilot-limiter.ts'

const work = process.env.E2E_WORK || ''
const port = process.env.E2E_PG_PORT || ''
if (process.env.NODE_ENV !== 'test' || !resolve(work).startsWith(resolve('.work/pilot-e2e.') ) || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('Disposable local test environment required')
const ca = await readFile(join(work, 'ca.crt'), 'utf8')
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const secret = randomBytes(32)
const env = {
  SECURE_V2_CONFIG_VERSION: '1', SECURE_V2_DB_HOST: '127.0.0.1', SECURE_V2_DB_PORT: port,
  SECURE_V2_DB_NAME: 'pilot_connection_e2e', SECURE_V2_DB_USER: 'pilot_owner', SECURE_V2_DB_PASSWORD: 'synthetic-only-password', PILOT_DB_CA_PEM: ca,
  SECURE_V2_JWT_PRIVATE_KEY_PEM: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), SECURE_V2_JWT_PUBLIC_KEY_PEM: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  SECURE_V2_JWT_ISSUER: 'synthetic-pilot', SECURE_V2_JWT_AUDIENCE: 'synthetic-pilot',
  SECURE_V2_SES_REGION: 'us-east-1', SECURE_V2_SES_FROM: 'sender@example.test', SECURE_V2_SES_TIMEOUT_MS: '1000', SECURE_V2_METADATA: 'disabled', SECURE_V2_FILES: 'disabled',
  PILOT_LIMITER_HMAC_KEY: secret.toString('base64url'), PILOT_REGISTRATION_MAILBOXES: 'sub@example.test,gc@example.test,other@example.test',
}
let unexpected = 0, delivered = 0
const mailboxes = new Set(['sub@example.test', 'gc@example.test', 'other@example.test'])
function installStub(p: ReturnType<typeof createPilot>) {
  // Override the returned instance immediately after construction and BEFORE listening.
  // Reject all commands other than known synthetic messages. No AWS SDK send occurs.
  p.ses.send = (async (command: unknown) => {
    if (!(command instanceof SendEmailCommand)) { unexpected++; throw new Error('Unexpected synthetic delivery') }
    const dest = command.input.Destination?.ToAddresses
    const email = dest?.[0]
    const token = /\n\n([A-Za-z0-9_-]{43})\n\n/.exec(command.input.Content?.Simple?.Body?.Text?.Data || '')?.[1]
    if (dest?.length !== 1 || !email || !mailboxes.has(email) || command.input.Destination?.CcAddresses?.length || command.input.Destination?.BccAddresses?.length || !token) {
      unexpected++; throw new Error('Unexpected synthetic delivery')
    }
    await writeFile(join(work, `mail-${email.split('@')[0]}`), token, { mode: 0o600, flag: 'wx' })
    delivered++
    return { MessageId: 'synthetic-only' }
  }) as typeof p.ses.send
}
const first = createPilot(env); installStub(first)
const second = createPilot(env); installStub(second)
const mismatch = createPilot({ ...env, PILOT_LIMITER_HMAC_KEY: randomBytes(32).toString('base64url') }); installStub(mismatch)
const pilots = [first, second, mismatch]
const servers: ReturnType<typeof first.app.listen>[] = []
try {
  const untrusted = createPilot({ ...env, PILOT_DB_CA_PEM: undefined }); installStub(untrusted)
  try { await assert.rejects(untrusted.pool.query('SELECT 1')) }
  finally { await untrusted.pool.end(); untrusted.ses.destroy(); untrusted.httpsAgent.destroy() }
  const ident = (await first.pool.query(`SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS ip, inet_server_port() AS port, s.ssl FROM pg_stat_ssl s WHERE s.pid=pg_backend_pid()`)).rows[0]
  assert.deepEqual(ident, { db: 'pilot_connection_e2e', usr: 'pilot_owner', ip: '127.0.0.1/32', port: Number(port), ssl: true })
  await first.pool.query(await readFile('server/src/pilot-limiter-schema.sql', 'utf8'))
  await first.pool.query('INSERT INTO public.pilot_rate_config_v1(singleton,key_check) VALUES(true,$1)', [pilotLimiterKeyCheck(secret)])
  assert.equal(await first.limiter.verify(), true)
  assert.equal(await second.limiter.verify(), true)
  assert.equal(await mismatch.limiter.verify(), false)
  for (const p of pilots) {
    const server = p.app.listen(0, '127.0.0.1'); servers.push(server)
    await new Promise<void>((ok, fail) => { server.once('listening', ok); server.once('error', fail) })
  }
  const ports = servers.map(s => (s.address() as AddressInfo).port)
  const post = (port: number, path: string, body: object) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const before = (await first.pool.query('SELECT count(*)::int AS n FROM public.auth_v2_registration_challenges')).rows[0].n
  assert.equal((await post(ports[0], '/api/v2/auth/register/request', { email: 'blocked@example.test' })).status, 503)
  assert.equal((await first.pool.query('SELECT count(*)::int AS n FROM public.auth_v2_registration_challenges')).rows[0].n, before)
  assert.equal(delivered, 0)
  assert.equal((await post(ports[2], '/api/v2/auth/login', { email: 'sub@example.test', password: 'synthetic password' })).status, 503)
  await writeFile(join(work, 'ports.json.tmp'), JSON.stringify({ first: ports[0], second: ports[1], mismatch: ports[2] }), { mode: 0o600 })
  await rename(join(work, 'ports.json.tmp'), join(work, 'ports.json'))
  const signal = await new Promise<string>(ok => { process.once('SIGTERM', () => ok('SIGTERM')); process.once('SIGINT', () => ok('SIGINT')) })
  assert.ok(signal)
  assert.equal(unexpected, 0, 'unexpected delivery was attempted')
  assert.equal(delivered, 3, 'exactly three synthetic deliveries expected')
  console.log('PASS: stub delivered only three allowed synthetic messages; blocked mailbox created no challenge; wrong limiter key failed closed; database TLS verified')
} finally {
  await Promise.all(servers.map(s => new Promise<void>(ok => { s.closeAllConnections(); s.close(() => ok()) })))
  await Promise.all(pilots.map(async p => { await p.pool.end(); p.ses.destroy(); p.httpsAgent.destroy() }))
}
