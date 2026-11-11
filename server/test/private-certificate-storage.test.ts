import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  MAX_CERTIFICATE_BYTES, CertificateAccessDeniedError, CertificateInputError,
  CertificateStorageDisabledError, CertificateStorageError, PrivateCertificateStorage,
  createPrivateCertificateStorage,
} from '../src/services/privateCertificateStorage.ts'
import type { CertificateMime, CertificateRecordRepository, PrivateCertificateRecord, PrivateS3Transport } from '../src/services/privateCertificateStorage.ts'

const pdf = Buffer.from('%PDF-1.7\nsynthetic test only\n%%EOF')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const webp = Buffer.from('RIFFxxxxWEBPtest')
const owner = { kind: 'member' as const, userId: 'sub-owner' }
const gc = { kind: 'member' as const, userId: 'gc-one' }
const other = { kind: 'member' as const, userId: 'gc-other' }
const source = (bytes: Buffer = pdf) => Readable.from([bytes])
async function bytes(stream: Readable) {
  const chunks: Buffer[] = []
  for await (const part of stream) chunks.push(Buffer.from(part))
  return Buffer.concat(chunks)
}
function setup() {
  const records = new Map<string, PrivateCertificateRecord>()
  const objects = new Map<string, { bytes: Buffer; mime: string }>()
  const puts: PutObjectCommand[] = []
  const gets: GetObjectCommand[] = []
  let consent = true
  const repo: CertificateRecordRepository = {
    async create(id, record) { if (records.has(id)) throw new Error('conflict'); records.set(id, { ...record }) },
    async get(id) { return records.get(id) || null },
  }
  const s3: PrivateS3Transport = {
    async put(command) {
      puts.push(command)
      objects.set(command.input.Key!, { bytes: Buffer.from(command.input.Body as Buffer), mime: command.input.ContentType! })
    },
    async get(command) {
      gets.push(command)
      const obj = objects.get(command.input.Key!)
      if (!obj) throw new Error('object missing with sensitive detail')
      return { Body: source(obj.bytes), ContentLength: obj.bytes.length, ContentType: obj.mime }
    },
  }
  const authorize = async ({ principal, certificateId, action }: any) => certificateId.startsWith('cert-') && (
    principal.userId === owner.userId || (action === 'download' && principal.userId === gc.userId && consent)
  )
  const config = { enabled: true, bucket: 'test-private-certificates', authorize, records: repo, s3 }
  return { storage: new PrivateCertificateStorage(config), records, objects, puts, gets, repo, s3, config, setConsent(value: boolean) { consent = value } }
}

test('default off; explicit configuration and all dependencies are required, with no local fallback', async () => {
  assert.throws(() => createPrivateCertificateStorage(), CertificateStorageDisabledError)
  assert.throws(() => createPrivateCertificateStorage({ enabled: false }), CertificateStorageDisabledError)
  const t = setup()
  assert.throws(() => new PrivateCertificateStorage({ ...t.config, enabled: undefined }), CertificateStorageDisabledError)
  for (const options of [
    { enabled: true },
    { enabled: true, bucket: 'test-private-certificates', region: 'us-east-1', records: t.repo },
    { enabled: true, bucket: '../bad', region: 'us-east-1', records: t.repo, authorize: t.config.authorize },
    { enabled: true, bucket: 'test-private-certificates', region: 'https://attacker.test', records: t.repo, authorize: t.config.authorize },
    { enabled: true, bucket: 'test-private-certificates\n', region: 'us-east-1', records: t.repo, authorize: t.config.authorize },
    { enabled: true, bucket: 'test-private-certificates', region: 'us-east-1\n', records: t.repo, authorize: t.config.authorize },
  ]) assert.throws(() => createPrivateCertificateStorage(options), CertificateStorageError)
  // Construction only: no operation is executed on the real SDK client.
  assert.ok(createPrivateCertificateStorage({ enabled: true, bucket: 'test-private-certificates', region: 'us-east-1', records: t.repo, authorize: t.config.authorize }))
})

test('opaque random server-owned keys, private S3 command, immutable mapping, and streamed download', async () => {
  const t = setup()
  const result = await t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf', key: 'attacker-controlled-key' } as any)
  assert.deepEqual(result, { mime: 'application/pdf', size: pdf.length })
  assert.deepEqual(Object.keys(result).sort(), ['mime', 'size'])
  const put = t.puts[0].input
  assert.match(put.Key!, /^private-certificates\/[0-9a-f]{64}$/)
  assert.notEqual(put.Key, 'attacker-controlled-key')
  assert.equal(put.Bucket, 'test-private-certificates')
  assert.equal(put.ACL, undefined)
  assert.equal(put.ServerSideEncryption, 'AES256')
  assert.equal(put.ContentDisposition, 'attachment')
  assert.equal(put.ContentLength, pdf.length)
  await t.storage.upload({ principal: owner, certificateId: 'cert-b', stream: source(), declaredMime: 'application/pdf' })
  assert.notEqual(t.puts[0].input.Key, t.puts[1].input.Key)
  const download = await t.storage.download({ principal: gc, certificateId: 'cert-a' })
  assert.equal(t.gets[0].input.Key, put.Key)
  assert.ok(download.stream instanceof Readable)
  assert.deepEqual(await bytes(download.stream), pdf)
  assert.deepEqual(download.headers, {
    'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
    'Content-Disposition': 'attachment; filename="certificate.pdf"',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  })
  // A conflicting create must not replace the original mapping, even though its new object may be orphaned.
  await assert.rejects(t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf' }), CertificateStorageError)
  assert.equal(t.records.get('cert-a')?.key, put.Key)
})

test('authorization fails closed before object or mapping access and is rechecked after consent revocation', async () => {
  const t = setup()
  await t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf' })
  assert.deepEqual(await bytes((await t.storage.download({ principal: gc, certificateId: 'cert-a' })).stream), pdf)
  const before = t.gets.length
  t.setConsent(false)
  for (const principal of [gc, other, { kind: 'client', userId: 'gc-one' } as any, null as any, { kind: 'member', userId: '../bad' } as any]) {
    await assert.rejects(t.storage.download({ principal, certificateId: 'cert-a' }), CertificateAccessDeniedError)
  }
  assert.equal(t.gets.length, before)
  await assert.rejects(t.storage.upload({ principal: gc, certificateId: 'cert-c', stream: source(), declaredMime: 'application/pdf' }), CertificateAccessDeniedError)
  await assert.rejects(t.storage.download({ principal: owner, certificateId: '../private-certificates/key' }), CertificateAccessDeniedError)
  await assert.rejects(t.storage.download({ principal: owner, certificateId: 'cert-a\n' }), CertificateAccessDeniedError)
  for (const authorize of [async () => false, async () => { throw new Error('authorization unavailable') }, async () => 'true' as any]) {
    let lookedUp = false
    const records = { ...t.repo, async get(id: string) { lookedUp = true; return t.repo.get(id) } }
    const storage = new PrivateCertificateStorage({ ...t.config, authorize, records })
    await assert.rejects(storage.download({ principal: owner, certificateId: 'cert-a' }), CertificateAccessDeniedError)
    assert.equal(lookedUp, false)
  }
  assert.equal(t.gets.length, before)
})

test('enforces MIME signature, mismatch, empty input and the 10 MiB hard limit before S3', async () => {
  const t = setup()
  const cases: Array<[CertificateMime, Buffer]> = [['application/pdf', pdf], ['image/jpeg', jpeg], ['image/png', png], ['image/webp', webp]]
  for (const [i, [mime, contents]] of cases.entries()) {
    // Deliberately split signatures across chunks.
    const saved = await t.storage.upload({ principal: owner, certificateId: `cert-${i}`, declaredMime: mime, stream: Readable.from([contents.subarray(0, 2), contents.subarray(2)]) })
    assert.equal(saved.mime, mime)
    const out = await t.storage.download({ principal: owner, certificateId: `cert-${i}` })
    assert.deepEqual(await bytes(out.stream), contents)
    assert.match(out.headers['Content-Disposition'], /^attachment; filename="certificate\.(pdf|jpg|png|webp)"$/)
  }
  const before = t.puts.length
  const invalid: Array<[string, Buffer]> = [
    ['application/pdf', Buffer.alloc(0)], ['application/pdf', Buffer.from('not a pdf')],
    ['image/png', pdf], ['text/html', png], ['image/svg+xml', png], ['image/jpeg', Buffer.from([0xff, 0xd8])],
    ['application/pdf', Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])],
    ['application/pdf', Buffer.concat([pdf, Buffer.alloc(MAX_CERTIFICATE_BYTES)])],
  ]
  for (const [mime, contents] of invalid) {
    await assert.rejects(t.storage.upload({ principal: owner, certificateId: 'cert-invalid', declaredMime: mime, stream: source(contents) }), CertificateInputError)
  }
  const broken = new Readable({ read() { this.destroy(new Error('input transport failed')) } })
  await assert.rejects(t.storage.upload({ principal: owner, certificateId: 'cert-broken', declaredMime: 'application/pdf', stream: broken }), CertificateInputError)
  assert.equal(t.puts.length, before)
  const boundary = Buffer.alloc(MAX_CERTIFICATE_BYTES); pdf.copy(boundary)
  assert.equal((await t.storage.upload({ principal: owner, certificateId: 'cert-boundary', declaredMime: 'application/pdf', stream: source(boundary) })).size, MAX_CERTIFICATE_BYTES)
})

test('storage and metadata failures never fall back to a URL; invalid response and broken streams fail closed', async () => {
  const t = setup()
  await t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf' })
  await assert.rejects(t.storage.download({ principal: owner, certificateId: 'cert-missing' }), CertificateStorageError)
  const original = { ...t.records.get('cert-a')! }
  t.records.set('cert-a', { ...original, key: '../public-key' })
  await assert.rejects(t.storage.download({ principal: owner, certificateId: 'cert-a' }), CertificateStorageError)
  t.records.set('cert-a', original)
  const make = (get: PrivateS3Transport['get']) => new PrivateCertificateStorage({ ...t.config, s3: { ...t.s3, get } })
  for (const result of [
    { Body: source(), ContentLength: pdf.length + 1, ContentType: 'application/pdf' },
    { Body: source(), ContentLength: pdf.length, ContentType: 'text/html' },
    { Body: 'not-a-stream', ContentLength: pdf.length, ContentType: 'application/pdf' },
  ]) await assert.rejects(make(async () => result).download({ principal: owner, certificateId: 'cert-a' }), CertificateStorageError)
  await assert.rejects(make(async () => { throw new Error('secret storage details') }).download({ principal: owner, certificateId: 'cert-a' }), { name: 'CertificateStorageError', message: 'Private certificate storage unavailable' })
  for (const payload of [pdf.subarray(0, pdf.length - 1), Buffer.concat([pdf, Buffer.from('extra')])]) {
    const download = await make(async () => ({ Body: source(payload), ContentLength: pdf.length, ContentType: 'application/pdf' })).download({ principal: owner, certificateId: 'cert-a' })
    await assert.rejects(bytes(download.stream), CertificateStorageError)
  }
  const s3Broken = new PrivateCertificateStorage({ ...t.config, s3: { ...t.s3, async put() { throw new Error('secret') } } })
  await assert.rejects(s3Broken.upload({ principal: owner, certificateId: 'cert-fail', stream: source(), declaredMime: 'application/pdf' }), CertificateStorageError)
  assert.equal(t.records.has('cert-fail'), false)
})

test('closing download destroys the upstream stream even before reading begins', async () => {
  const t = setup()
  await t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf' })
  const upstream = source()
  const storage = new PrivateCertificateStorage({ ...t.config, s3: { ...t.s3, async get() { return { Body: upstream, ContentLength: pdf.length, ContentType: 'application/pdf' } } } })
  const response = await storage.download({ principal: owner, certificateId: 'cert-a' })
  response.stream.destroy()
  await new Promise((resolve) => response.stream.once('close', resolve))
  assert.equal(upstream.destroyed, true)
})

test('early upstream failure is sanitized even before download is consumed', async () => {
  const t = setup()
  await t.storage.upload({ principal: owner, certificateId: 'cert-a', stream: source(), declaredMime: 'application/pdf' })
  const upstream = new Readable({ read() {} })
  const storage = new PrivateCertificateStorage({ ...t.config, s3: { ...t.s3, async get() { return { Body: upstream, ContentLength: pdf.length, ContentType: 'application/pdf' } } } })
  const response = await storage.download({ principal: owner, certificateId: 'cert-a' })
  const errorPromise = new Promise<Error>((resolve) => response.stream.once('error', resolve))
  upstream.destroy(new Error('sensitive AWS details'))
  const error = await errorPromise
  assert.equal(error.name, 'CertificateStorageError')
  assert.equal(error.message, 'Private certificate storage unavailable')
})
