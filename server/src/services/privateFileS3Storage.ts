// Isolated server-owned adapter. No client, credentials, router, or AWS connection is created here.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import type { S3Client } from '@aws-sdk/client-s3'
import type { FileMime, ImmutablePrivateStorage } from './selfReportedPrivateFiles.ts'

export type PrivateFileS3Config = Readonly<{
  bucket: string
  expectedBucketOwner: string
  maxFileBytes: number
  deadlineMs: number
}>
// The actual SDK client is injected by a trusted server composition root, never by a request.
export type PrivateFileS3Client = Pick<S3Client, 'send'>
const LIMIT = 10 * 1024 * 1024
const mimes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const fail = (): never => { throw new Error('Private storage unavailable') }
const isVersion = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim() && value !== 'null' && !/[\u0000-\u001f\u007f]/.test(value)
const validKey = (key: unknown): key is string => typeof key === 'string' && /^private-coi\/[0-9a-f]{64}$/.test(key)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest()
function validBucket(bucket: unknown): bucket is string {
  return typeof bucket === 'string' && bucket.length >= 3 && bucket.length <= 63 &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) && !bucket.includes('..') &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(bucket) &&
    !['xn--', 'sthree-', 'amzn-s3-demo-'].some(x => bucket.startsWith(x)) &&
    !['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'].some(x => bucket.endsWith(x))
}
function validateConfig(c: PrivateFileS3Config): void {
  if (!c || !validBucket(c.bucket) || typeof c.expectedBucketOwner !== 'string' || !/^\d{12}$/.test(c.expectedBucketOwner) ||
      !Number.isSafeInteger(c.maxFileBytes) || c.maxFileBytes < 1 || c.maxFileBytes > LIMIT ||
      !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 120000) throw new Error('Invalid private S3 configuration')
  if (c.bucket.endsWith('-an')) {
    const regional = c.bucket.match(/^.+-([0-9]{12})-([a-z0-9]+(?:-[a-z0-9]+)+)-an$/)
    if (!regional || regional[1] !== c.expectedBucketOwner) throw new Error('Invalid private S3 configuration')
  }
}
// Strict decimal strings: do not silently accept whitespace, signs, exponents, fractions or defaults.
export function privateFileS3ConfigFromEnv(env: Record<string, string | undefined>): PrivateFileS3Config {
  const number = (v: string | undefined) => typeof v === 'string' && /^[1-9][0-9]*$/.test(v) ? Number(v) : NaN
  const c = { bucket: env?.PRIVATE_FILE_S3_BUCKET as string, expectedBucketOwner: env?.PRIVATE_FILE_S3_EXPECTED_BUCKET_OWNER as string,
    maxFileBytes: number(env?.PRIVATE_FILE_S3_MAX_BYTES), deadlineMs: number(env?.PRIVATE_FILE_S3_DEADLINE_MS) }
  validateConfig(c)
  return Object.freeze(c)
}
function checksum(value: unknown): Buffer {
  // Reject noncanonical Base64, padded multipart composites, and other algorithms.
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return fail()
  const b = Buffer.from(value, 'base64')
  if (b.length !== 32 || b.toString('base64') !== value) return fail()
  return b
}
function checkedHeaders(r: { VersionId?: string; ContentLength?: number; ChecksumSHA256?: string; ChecksumType?: string; DeleteMarker?: boolean; ContentRange?: string }, version: string, max: number) {
  if (!r || r.VersionId !== version || r.DeleteMarker || r.ContentRange !== undefined ||
      !Number.isSafeInteger(r.ContentLength) || r.ContentLength! < 1 || r.ContentLength! > max ||
      (r.ChecksumType !== undefined && r.ChecksumType !== 'FULL_OBJECT')) return fail()
  return { size: r.ContentLength!, sha: checksum(r.ChecksumSHA256) }
}
function destroy(body: unknown) { if (body instanceof Readable) body.destroy() }
async function deadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => { controller.abort(); reject(new Error('cancelled')) }
    timer = setTimeout(cancel, ms)
    external?.addEventListener('abort', cancel, { once: true })
  })
  try {
    if (external?.aborted) cancel()
    if (controller.signal.aborted) return await stopped
    return await Promise.race([work(controller.signal), stopped])
  } finally {
    if (timer) clearTimeout(timer)
    external?.removeEventListener('abort', cancel)
    controller.abort()
  }
}

export function createPrivateFileS3Storage(config: PrivateFileS3Config, client: PrivateFileS3Client): ImmutablePrivateStorage {
  validateConfig(config)
  if (!client || typeof client.send !== 'function') throw new Error('Invalid private S3 configuration')
  // Snapshot trusted configuration; later mutations cannot change bucket or limits.
  const { bucket, expectedBucketOwner, maxFileBytes, deadlineMs } = config
  const common = { Bucket: bucket, ExpectedBucketOwner: expectedBucketOwner }
  return {
    async putNew(key: string, input: Uint8Array, mime: FileMime, signal?: AbortSignal) {
      try {
        if (!validKey(key) || !(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxFileBytes || !mimes.has(mime) || (signal !== undefined && !(signal instanceof AbortSignal))) return fail()
        // Freeze the logical upload before any await; don't accept a caller-supplied hash.
        const bytes = Buffer.from(input), sha = digest(bytes)
        return await deadline(deadlineMs, async signal => {
          const put = await client.send(new PutObjectCommand({ ...common, Key: key, Body: bytes, ContentLength: bytes.length,
            ContentType: mime, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ChecksumSHA256: sha.toString('base64') }), { abortSignal: signal })
          if (signal.aborted || !put || !isVersion(put.VersionId)) return fail()
          const version = put.VersionId
          // An S3-validated checksum is not user metadata or a Put response echo. Head the exact
          // committed version independently, with checksum mode enabled, and also check length/MIME.
          const head = await client.send(new HeadObjectCommand({ ...common, Key: key, VersionId: version, ChecksumMode: 'ENABLED' }), { abortSignal: signal })
          if (signal.aborted) return fail()
          const evidence = checkedHeaders(head, version, maxFileBytes)
          if (head.ContentType !== mime || evidence.size !== bytes.length || !evidence.sha.equals(sha)) return fail()
          return { mime, size: evidence.size, sha256: evidence.sha.toString('hex'), version }
        }, signal)
      } catch { return fail() }
    },
    async getVersion(key: string, version: string, maxBytes: number) {
      try {
        if (!validKey(key) || !isVersion(version) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return fail()
        const bound = Math.min(maxFileBytes, maxBytes)
        return await deadline(deadlineMs, async signal => {
          const result = await client.send(new GetObjectCommand({ ...common, Key: key, VersionId: version, ChecksumMode: 'ENABLED' }), { abortSignal: signal })
          if (signal.aborted) { destroy(result?.Body); return fail() }
          const body = result?.Body
          if (!(body instanceof Readable)) { destroy(body); return fail() }
          const abort = () => body.destroy()
          signal.addEventListener('abort', abort, { once: true })
          try {
            const evidence = checkedHeaders(result, version, bound)
            const chunks: Buffer[] = []; let size = 0
            for await (const chunk of body) {
              if (signal.aborted || !(chunk instanceof Uint8Array)) return fail()
              size += chunk.byteLength
              if (size > evidence.size || size > bound) return fail()
              chunks.push(Buffer.from(chunk))
            }
            if (signal.aborted || size !== evidence.size) return fail()
            const bytes = Buffer.concat(chunks, size)
            if (!digest(bytes).equals(evidence.sha)) return fail()
            return { bytes, version }
          } finally { signal.removeEventListener('abort', abort); body.destroy() }
        })
      } catch { return fail() }
    }
  }
}
