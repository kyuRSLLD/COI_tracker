import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import pg from 'pg'
import { createV2Auth, hashV2Password } from '../src/v2/auth.ts'

function pair(size: number) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: size })
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}
test('key configuration fails closed without matching strong server-owned RSA keys', async () => {
  const pool = new pg.Pool(); const good = pair(2048), other = pair(2048), small = pair(1024)
  const config = { ...good, issuer: 'issuer', audience: 'audience' }
  assert.doesNotThrow(() => createV2Auth(pool, config))
  assert.throws(() => createV2Auth(pool, { ...config, privateKey: '' }))
  assert.throws(() => createV2Auth(pool, { ...config, publicKey: good.privateKey }))
  assert.throws(() => createV2Auth(pool, { ...config, publicKey: other.publicKey }))
  assert.throws(() => createV2Auth(pool, { ...config, ...small }))
  assert.throws(() => createV2Auth(pool, { ...config, issuer: '' }))
  assert.throws(() => createV2Auth(pool, { ...config, audience: ' audience ' }))
  await pool.end()
})
test('scrypt passwords are salted, byte-bounded, and never silently truncated', async () => {
  await assert.rejects(hashV2Password('short'))
  await assert.rejects(hashV2Password('x'.repeat(257)))
  const a = await hashV2Password('correct horse battery staple')
  const b = await hashV2Password('correct horse battery staple')
  assert.match(a, /^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
  assert.notEqual(a, b)
  assert.ok(!a.includes('correct horse'))
})
