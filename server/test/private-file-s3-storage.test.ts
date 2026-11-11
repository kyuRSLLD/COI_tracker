import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { createPrivateFileS3Storage, privateFileS3ConfigFromEnv } from '../src/services/privateFileS3Storage.ts'
import type { PrivateFileS3Client } from '../src/services/privateFileS3Storage.ts'

const config = { bucket: 'private-example-bucket', expectedBucketOwner: '123456789012', maxFileBytes: 1024, deadlineMs: 80 }
const key = 'private-coi/' + 'a'.repeat(64)
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('base64')
const original = Buffer.from([0, 255, 4, 13, 10, 127, 128, 2])
const unavailable = (p: Promise<unknown>) => assert.rejects(p, (e: Error) => e.message === 'Private storage unavailable' && !('cause' in e))
const sleep = (n: number) => new Promise(resolve => setTimeout(resolve, n))

type Entry = { bytes: Buffer; mime: string; version: string; sha: string }
class SyntheticS3 {
  objects = new Map<string, Entry>()
  calls: { command: any; signal: AbortSignal }[] = []
  // These are response manipulations, not an AWS connection.
  putResult: (x: any) => any = x => x
  headResult: (x: any) => any = x => x
  getResult: (x: any) => any = x => x
  hook?: (command: any, signal: AbortSignal) => Promise<void>
  async send(command: any, opts: { abortSignal: AbortSignal }) {
    this.calls.push({ command, signal: opts.abortSignal })
    await this.hook?.(command, opts.abortSignal)
    const i = command.input
    assert.equal(i.Bucket, config.bucket)
    assert.equal(i.ExpectedBucketOwner, config.expectedBucketOwner)
    if (command instanceof PutObjectCommand) {
      assert.equal(i.IfNoneMatch, '*'); assert.equal(i.ChecksumAlgorithm, 'SHA256')
      if (this.objects.has(i.Key)) throw new Error('PreconditionFailed private details')
      const bytes = Buffer.from(i.Body)
      if (i.ContentLength !== bytes.length || i.ChecksumSHA256 !== hash(bytes)) throw new Error('BadDigest')
      const entry = { bytes, mime: i.ContentType, version: 'version-1', sha: hash(bytes) }
      this.objects.set(i.Key, entry)
      return this.putResult({ VersionId: entry.version, ChecksumSHA256: entry.sha })
    }
    const entry = this.objects.get(i.Key)
    if (!entry || i.VersionId !== entry.version) throw new Error('NoSuchVersion private details')
    assert.equal(i.ChecksumMode, 'ENABLED')
    const headers = { VersionId: entry.version, ContentLength: entry.bytes.length, ContentType: entry.mime, ChecksumSHA256: entry.sha, ChecksumType: 'FULL_OBJECT' }
    if (command instanceof HeadObjectCommand) return this.headResult(headers)
    if (command instanceof GetObjectCommand) return this.getResult({ ...headers, Body: Readable.from([entry.bytes.subarray(0, 2), entry.bytes.subarray(2)]) })
    throw new Error('unexpected command')
  }
}
function setup(options = config) {
  const mock = new SyntheticS3()
  return { mock, storage: createPrivateFileS3Storage(options, mock as unknown as PrivateFileS3Client) }
}

test('success: snapshots bytes; conditional PUT and HEAD exact version; bounded GET exact version', async () => {
  const { mock, storage } = setup()
  let release!: () => void, entered!: () => void
  const enteredP = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r)
  mock.hook = async command => { if (command instanceof PutObjectCommand) { entered(); await gate } }
  const input = Buffer.from(original), writing = storage.putNew(key, input, 'application/pdf')
  await enteredP; input.fill(33); release()
  const receipt = await writing
  assert.deepEqual(receipt, { mime: 'application/pdf', size: original.length, sha256: Buffer.from(hash(original), 'base64').toString('hex'), version: 'version-1' })
  assert.deepEqual(mock.objects.get(key)!.bytes, original)
  const read = await storage.getVersion(key, receipt.version, config.maxFileBytes)
  assert.deepEqual(read, { bytes: original, version: 'version-1' })
  assert.deepEqual(mock.calls.map(c => c.command.constructor.name), ['PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand'])
  assert.equal(mock.calls[1].command.input.VersionId, 'version-1')
  assert.equal(mock.calls[2].command.input.VersionId, 'version-1')
  assert.equal(mock.calls[0].command.input.ACL, undefined)
  assert.equal(mock.calls[0].command.input.Metadata, undefined)
})

test('single-part object succeeds when S3 omits optional checksum type, but not the checksum', async () => {
  const { mock, storage } = setup()
  mock.headResult = x => ({ ...x, ChecksumType: undefined })
  mock.getResult = x => ({ ...x, ChecksumType: undefined })
  const receipt = await storage.putNew(key, original, 'image/jpeg')
  assert.deepEqual((await storage.getVersion(key, receipt.version, config.maxFileBytes)).bytes, original)
})

test('write receipt requires S3 head proof, never just an echo in PUT', async () => {
  for (const patch of [
    { ChecksumSHA256: undefined }, { ChecksumSHA256: hash(Buffer.from('different')) },
    { ChecksumSHA256: 'not-base64' }, { ChecksumSHA256: hash(original) + '-2' },
    { ContentLength: original.length + 1 }, { ContentLength: undefined },
    { VersionId: undefined }, { VersionId: 'another' }, { VersionId: 'null' },
    { ChecksumType: 'COMPOSITE' }, { ContentType: 'image/png' },
    { DeleteMarker: true }, { ContentRange: 'bytes 0-1/2' }
  ]) {
    const { mock, storage } = setup(); mock.headResult = h => ({ ...h, ...patch })
    await unavailable(storage.putNew(key, original, 'application/pdf'))
    assert.equal(mock.objects.size, 1) // write may have happened; orchestration must reconcile
  }
  const { mock, storage } = setup(); mock.headResult = () => { throw new Error('secret AWS failure') }
  await unavailable(storage.putNew(key, original, 'application/pdf'))
  assert.equal(mock.objects.size, 1)
})

test('write rejects null, malformed and missing versions before head; existing/racing writes fail closed', async () => {
  for (const v of [undefined, '', 'null', ' version', 'x\n', 'x'.repeat(513)]) {
    const { mock, storage } = setup(); mock.putResult = x => ({ ...x, VersionId: v })
    await unavailable(storage.putNew(key, original, 'application/pdf'))
    assert.equal(mock.calls.length, 1)
  }
  const { mock, storage } = setup()
  await storage.putNew(key, original, 'application/pdf')
  await unavailable(storage.putNew(key, Buffer.from('other'), 'application/pdf'))
  assert.deepEqual(mock.objects.get(key)!.bytes, original)
  const { mock: raced, storage: contender } = setup()
  raced.hook = async c => { if (c instanceof PutObjectCommand) throw Object.assign(new Error('secret conflict'), { $metadata: { httpStatusCode: 409 } }) }
  await unavailable(contender.putNew(key, original, 'application/pdf'))
  assert.equal(raced.calls.length, 1)
  const { storage: concurrent } = setup()
  const result = await Promise.allSettled([concurrent.putNew(key, original, 'image/png'), concurrent.putNew(key, original, 'image/png')])
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1)
})

test('reads reject corrupt, incomplete, oversized and non-byte streams and bad response headers', async () => {
  const patches = [
    { VersionId: 'different' }, { VersionId: undefined }, { VersionId: 'null' },
    { ContentLength: 0 }, { ContentLength: undefined }, { ContentLength: 1025 },
    { ContentLength: original.length - 1 }, { ContentLength: original.length + 1 },
    { ChecksumSHA256: undefined }, { ChecksumSHA256: hash(Buffer.from('bad')) },
    { ChecksumType: 'COMPOSITE' }, { ContentRange: 'bytes 0-1/8' }, { DeleteMarker: true },
    { Body: undefined }, { Body: Readable.from([Buffer.from('corrupt!')]) },
    { Body: Readable.from([original.subarray(0, 2)]) }, { Body: Readable.from([Buffer.concat([original, original])]) },
    { Body: Readable.from(['not a byte stream']) },
    { Body: Readable.from((async function* () { yield original.subarray(0, 2); throw new Error('secret stream error') })()) }
  ]
  for (const patch of patches) {
    const { mock, storage } = setup(); await storage.putNew(key, original, 'application/pdf')
    mock.getResult = x => { x.Body.destroy(); return { ...x, ...patch } }
    await unavailable(storage.getVersion(key, 'version-1', config.maxFileBytes))
  }
  const { storage } = setup(); await storage.putNew(key, original, 'application/pdf')
  for (const bad of ['null', '', ' leading', 'x\n', 'v'.repeat(513), 'other']) await unavailable(storage.getVersion(key, bad, config.maxFileBytes))
})

test('timeouts abort SDK calls, terminate streams, and do not continue a late PUT to HEAD', async () => {
  const short = { ...config, deadlineMs: 25 }
  const { mock, storage } = setup(short)
  let release!: () => void
  const gate = new Promise<void>(r => release = r)
  mock.hook = async c => { if (c instanceof PutObjectCommand) await gate }
  await unavailable(storage.putNew(key, original, 'application/pdf'))
  assert.equal(mock.calls[0].signal.aborted, true)
  release(); await sleep(10)
  assert.equal(mock.calls.length, 1)
  assert.equal(mock.objects.size, 1) // lost response: object could exist

  const readFixture = setup(short); await readFixture.storage.putNew(key, original, 'application/pdf')
  const stalled = new Readable({ read() {} })
  readFixture.mock.getResult = x => { x.Body.destroy(); return { ...x, Body: stalled } }
  await unavailable(readFixture.storage.getVersion(key, 'version-1', config.maxFileBytes))
  assert.equal(stalled.destroyed, true)
  assert.equal(readFixture.mock.calls.at(-1)!.signal.aborted, true)

  const headFixture = setup(short)
  headFixture.mock.hook = async c => { if (c instanceof HeadObjectCommand) await new Promise(() => {}) }
  await unavailable(headFixture.storage.putNew(key, original, 'application/pdf'))
  assert.equal(headFixture.mock.calls.at(-1)!.signal.aborted, true)
  const getFixture = setup(short); await getFixture.storage.putNew(key, original, 'application/pdf')
  getFixture.mock.hook = async c => { if (c instanceof GetObjectCommand) await new Promise(() => {}) }
  await unavailable(getFixture.storage.getVersion(key, 'version-1', config.maxFileBytes))
  assert.equal(getFixture.mock.calls.at(-1)!.signal.aborted, true)

  // An uncooperative SDK can deliver a body after the deadline; destroy it on arrival.
  const late = setup(short); await late.storage.putNew(key, original, 'application/pdf')
  let releaseGet!: () => void
  const getGate = new Promise<void>(r => releaseGet = r)
  late.mock.hook = async c => { if (c instanceof GetObjectCommand) await getGate }
  let lateBody: Readable | undefined
  late.mock.getResult = x => { lateBody = x.Body; return x }
  await unavailable(late.storage.getVersion(key, 'version-1', config.maxFileBytes))
  releaseGet(); await sleep(10)
  assert.equal(lateBody?.destroyed, true)
})

test('strict configuration, environment, key, input, and immutable config snapshot', async () => {
  const env = { PRIVATE_FILE_S3_BUCKET: config.bucket, PRIVATE_FILE_S3_EXPECTED_BUCKET_OWNER: config.expectedBucketOwner, PRIVATE_FILE_S3_MAX_BYTES: '1024', PRIVATE_FILE_S3_DEADLINE_MS: '80' }
  assert.deepEqual(privateFileS3ConfigFromEnv(env), config)
  assert.equal(privateFileS3ConfigFromEnv({ ...env, PRIVATE_FILE_S3_BUCKET: 'private-123456789012-us-east-1-an' }).bucket, 'private-123456789012-us-east-1-an')
  for (const patch of [
    { PRIVATE_FILE_S3_BUCKET: '' }, { PRIVATE_FILE_S3_BUCKET: 'bad bucket' }, { PRIVATE_FILE_S3_BUCKET: 'bucket--x-s3' },
    { PRIVATE_FILE_S3_BUCKET: 'bad-an' }, { PRIVATE_FILE_S3_BUCKET: 'private-999999999999-us-east-1-an' },
    { PRIVATE_FILE_S3_BUCKET: 'arn:aws:s3:accesspoint/test' }, { PRIVATE_FILE_S3_EXPECTED_BUCKET_OWNER: '123' },
    { PRIVATE_FILE_S3_MAX_BYTES: '1e3' }, { PRIVATE_FILE_S3_MAX_BYTES: ' 1' }, { PRIVATE_FILE_S3_MAX_BYTES: '0' },
    { PRIVATE_FILE_S3_MAX_BYTES: '10485761' }, { PRIVATE_FILE_S3_DEADLINE_MS: '120001' }, { PRIVATE_FILE_S3_DEADLINE_MS: undefined }
  ]) assert.throws(() => privateFileS3ConfigFromEnv({ ...env, ...patch }), /Invalid private S3 configuration/)
  assert.throws(() => createPrivateFileS3Storage({ ...config, deadlineMs: NaN }, {} as PrivateFileS3Client), /configuration/)
  assert.throws(() => createPrivateFileS3Storage(config, {} as PrivateFileS3Client), /configuration/)
  const mutable = { ...config }, { mock, storage } = setup(mutable)
  mutable.bucket = 'different-bucket'; mutable.maxFileBytes = 1
  await storage.putNew(key, original, 'application/pdf')
  assert.equal(mock.calls[0].command.input.Bucket, config.bucket)
  for (const k of ['', 'private-coi/' + 'A'.repeat(64), 'other/' + 'a'.repeat(64), key + '/x']) await unavailable(storage.putNew(k, original, 'application/pdf'))
  await unavailable(storage.putNew(key, Buffer.alloc(0), 'application/pdf'))
  await unavailable(storage.putNew(key, Buffer.alloc(1025), 'application/pdf'))
  await unavailable(storage.putNew(key, original, 'text/plain' as any))
  assert.equal(mock.calls.length, 2)
})

test('caller cancellation stops PUT or HEAD and prevents late follow-on work', async () => {
  const pre = setup(), already = new AbortController()
  already.abort()
  await unavailable(pre.storage.putNew(key, original, 'application/pdf', already.signal))
  assert.equal(pre.mock.calls.length, 0)

  const duringPut = setup(), putAbort = new AbortController()
  let releasePut!: () => void, enteredPut!: () => void
  const putGate = new Promise<void>(resolve => releasePut = resolve)
  const putEntered = new Promise<void>(resolve => enteredPut = resolve)
  duringPut.mock.hook = async command => { if (command instanceof PutObjectCommand) { enteredPut(); await putGate } }
  const writing = duringPut.storage.putNew(key, original, 'application/pdf', putAbort.signal)
  await putEntered; putAbort.abort(); await unavailable(writing)
  assert.equal(duringPut.mock.calls[0].signal.aborted, true)
  releasePut(); await sleep(10)
  assert.equal(duringPut.mock.calls.length, 1)
  assert.equal(duringPut.mock.objects.size, 1) // ambiguous commit must be reconciled

  const duringHead = setup(), headAbort = new AbortController()
  let enteredHead!: () => void
  const headEntered = new Promise<void>(resolve => enteredHead = resolve)
  duringHead.mock.hook = async command => { if (command instanceof HeadObjectCommand) { enteredHead(); await new Promise(() => {}) } }
  const checking = duringHead.storage.putNew(key, original, 'application/pdf', headAbort.signal)
  await headEntered; headAbort.abort(); await unavailable(checking)
  assert.equal(duringHead.mock.calls.at(-1)!.signal.aborted, true)
  assert.equal(duringHead.mock.objects.size, 1)
})

test('per-read bound is required and enforced against headers and actual stream before buffering', async () => {
  const { mock, storage } = setup()
  await storage.putNew(key, original, 'application/pdf')
  const calls = mock.calls.length
  for (const max of [0, -1, NaN, Infinity, 1.5, undefined]) {
    await unavailable(storage.getVersion(key, 'version-1', max as number))
  }
  assert.equal(mock.calls.length, calls)
  let rejectedBody: Readable | undefined
  mock.getResult = x => { rejectedBody = x.Body; return x }
  await unavailable(storage.getVersion(key, 'version-1', original.length - 1))
  assert.equal(rejectedBody!.destroyed, true)
  assert.deepEqual((await storage.getVersion(key, 'version-1', original.length)).bytes, original)
  mock.getResult = x => {
    x.Body.destroy()
    // A dishonest/malformed stream exceeds the lower declared length and requested bound.
    return { ...x, ContentLength: original.length - 1, Body: Readable.from([original]) }
  }
  await unavailable(storage.getVersion(key, 'version-1', original.length - 1))
})
