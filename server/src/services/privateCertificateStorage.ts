import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

/** This module is deliberately not imported by the app or any route. */
export const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024
export type CertificateMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
export type CertificateAction = 'upload' | 'download'

// This must be derived from server-side authentication, never a request body.
// Public/client-share principals are deliberately not supported by this service.
export type MemberPrincipal = { kind: 'member'; userId: string }
export type AuthorizeCertificate = (request: {
  principal: MemberPrincipal; certificateId: string; action: CertificateAction
}) => Promise<boolean>

// Private server-side metadata, never returned to a caller. create must atomically
// fail if certificateId already exists; get must read the authoritative mapping.
export type PrivateCertificateRecord = {
  key: string; mime: CertificateMime; size: number
}
export interface CertificateRecordRepository {
  create(certificateId: string, record: PrivateCertificateRecord): Promise<void>
  get(certificateId: string): Promise<PrivateCertificateRecord | null>
}

// A narrow injection seam for isolated tests. Production callers should use the
// factory below, which constructs an AWS SDK client and has no local fallback.
export interface PrivateS3Transport {
  put(command: PutObjectCommand): Promise<unknown>
  get(command: GetObjectCommand): Promise<{ Body?: unknown; ContentLength?: number; ContentType?: string }>
}

export class CertificateStorageDisabledError extends Error {
  constructor() { super('Private certificate storage is disabled'); this.name = 'CertificateStorageDisabledError' }
}
export class CertificateAccessDeniedError extends Error {
  constructor() { super('Certificate access denied'); this.name = 'CertificateAccessDeniedError' }
}
export class CertificateInputError extends Error {
  constructor(message = 'Invalid certificate input') { super(message); this.name = 'CertificateInputError' }
}
export class CertificateStorageError extends Error {
  constructor() { super('Private certificate storage unavailable'); this.name = 'CertificateStorageError' }
}

const MIME_EXTENSIONS: Record<CertificateMime, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
}
const idPattern = /^[A-Za-z0-9_-]{1,128}(?![\s\S])/
const keyPattern = /^private-certificates\/[a-f0-9]{64}(?![\s\S])/
function validId(id: unknown): id is string { return typeof id === 'string' && idPattern.test(id) }
function isMime(mime: unknown): mime is CertificateMime {
  return typeof mime === 'string' && Object.hasOwn(MIME_EXTENSIONS, mime)
}
function isRecord(record: PrivateCertificateRecord | null): record is PrivateCertificateRecord {
  return !!record && typeof record.key === 'string' && keyPattern.test(record.key) && isMime(record.mime) &&
    Number.isSafeInteger(record.size) && record.size > 0 && record.size <= MAX_CERTIFICATE_BYTES
}
function detectMime(data: Buffer): CertificateMime | null {
  if (data.length >= 8 && /^%PDF-(?:1\.[0-7]|2\.0)/.test(data.subarray(0, 8).toString('latin1'))) return 'application/pdf'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
async function collectFile(stream: Readable, declaredMime: unknown): Promise<{ data: Buffer; mime: CertificateMime }> {
  if (!(stream instanceof Readable) || !isMime(declaredMime)) throw new CertificateInputError()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new CertificateInputError()
      size += chunk.byteLength
      if (size > MAX_CERTIFICATE_BYTES) throw new CertificateInputError('Certificate exceeds the 10 MiB limit')
      chunks.push(Buffer.from(chunk))
    }
    if (size === 0) throw new CertificateInputError()
    const data = Buffer.concat(chunks, size)
    const mime = detectMime(data)
    if (!mime || mime !== declaredMime) throw new CertificateInputError('Certificate type does not match its content')
    return { data, mime }
  } catch (error) {
    stream.destroy()
    if (error instanceof CertificateInputError) throw error
    throw new CertificateInputError('Unable to read certificate input')
  }
}

type StorageConfig = {
  enabled?: boolean; bucket: string; authorize: AuthorizeCertificate; records: CertificateRecordRepository; s3: PrivateS3Transport
}
export class PrivateCertificateStorage {
  private readonly config: StorageConfig
  constructor(config: StorageConfig) {
    if (config.enabled !== true) throw new CertificateStorageDisabledError()
    if (!isValidBucket(config.bucket) || typeof config.authorize !== 'function' ||
        typeof config.records?.get !== 'function' || typeof config.records?.create !== 'function' ||
        typeof config.s3?.put !== 'function' || typeof config.s3?.get !== 'function') throw new CertificateStorageError()
    this.config = config
  }
  private async check(principal: MemberPrincipal, certificateId: string, action: CertificateAction): Promise<void> {
    if (!validId(certificateId) || !principal || principal.kind !== 'member' || !validId(principal.userId)) throw new CertificateAccessDeniedError()
    try {
      if (await this.config.authorize({ principal, certificateId, action }) !== true) throw new CertificateAccessDeniedError()
    } catch { throw new CertificateAccessDeniedError() }
  }
  async upload(request: { principal: MemberPrincipal; certificateId: string; stream: Readable; declaredMime: string }): Promise<{ mime: CertificateMime; size: number }> {
    await this.check(request.principal, request.certificateId, 'upload')
    const { data, mime } = await collectFile(request.stream, request.declaredMime)
    const record: PrivateCertificateRecord = { key: `private-certificates/${randomBytes(32).toString('hex')}`, mime, size: data.length }
    try {
      await this.config.s3.put(new PutObjectCommand({
        Bucket: this.config.bucket, Key: record.key, Body: data, ContentLength: record.size,
        ContentType: record.mime, ContentDisposition: 'attachment', ServerSideEncryption: 'AES256',
        // No ACL: bucket-owner-enforced S3 ownership and Block Public Access are required.
      }))
      await this.config.records.create(request.certificateId, record)
    } catch { throw new CertificateStorageError() }
    return { mime, size: record.size }
  }
  async download(request: { principal: MemberPrincipal; certificateId: string }): Promise<{
    stream: Readable; headers: Record<string, string>
  }> {
    await this.check(request.principal, request.certificateId, 'download')
    let record: PrivateCertificateRecord | null
    try { record = await this.config.records.get(request.certificateId) } catch { throw new CertificateStorageError() }
    if (!isRecord(record)) throw new CertificateStorageError()
    let result: Awaited<ReturnType<PrivateS3Transport['get']>>
    try { result = await this.config.s3.get(new GetObjectCommand({ Bucket: this.config.bucket, Key: record.key })) }
    catch { throw new CertificateStorageError() }
    if (!(result.Body instanceof Readable) || result.ContentLength !== record.size || result.ContentType !== record.mime) {
      if (result.Body instanceof Readable) result.Body.destroy()
      throw new CertificateStorageError()
    }
    const source = result.Body
    const expected = record.size
    // Pull-based stream: no object is accumulated in memory. An incomplete or
    // oversized body fails the stream; a route must terminate the response on error.
    const stream = Readable.from((async function* () {
      let seen = 0
      try {
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) throw new CertificateStorageError()
          seen += chunk.byteLength
          if (seen > expected) throw new CertificateStorageError()
          yield chunk
        }
        if (seen !== expected) throw new CertificateStorageError()
      } catch { throw new CertificateStorageError() }
      finally { source.destroy() }
    })())
    // Attach immediately: an upstream socket may fail before the caller pipes.
    // Consumers still observe the sanitized error on the returned stream.
    stream.on('error', () => {})
    source.once('error', () => stream.destroy(new CertificateStorageError()))
    stream.once('close', () => source.destroy())
    return { stream, headers: {
      'Content-Type': record.mime,
      'Content-Length': String(record.size),
      'Content-Disposition': `attachment; filename="certificate.${MIME_EXTENSIONS[record.mime]}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } }
  }
}

function isValidBucket(bucket: unknown): bucket is string {
  // Dotless DNS bucket names only, avoiding TLS wildcard ambiguity. Explicitly
  // reject IPv4-like names and reserved S3 prefixes/suffixes.
  return typeof bucket === 'string' && bucket.length >= 3 && bucket.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])(?![\s\S])/.test(bucket) &&
    !/^(?:xn--|sthree-|amzn-s3-demo-)/.test(bucket) && !/(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(bucket)
}

/** Explicit opt-in only. Uses AWS's credential provider chain; no custom endpoint or fallback. */
export function createPrivateCertificateStorage(config: {
  enabled?: boolean; bucket?: string; region?: string; authorize?: AuthorizeCertificate; records?: CertificateRecordRepository
} = {}): PrivateCertificateStorage {
  if (config.enabled !== true) throw new CertificateStorageDisabledError()
  const region = config.region
  // Restrict this first implementation to commercial AWS regional endpoints.
  if (!isValidBucket(config.bucket) || typeof region !== 'string' ||
      !/^(?:us|af|ap|ca|eu|il|me|mx|sa)-(?:north|south|east|west|central|northeast|northwest|southeast|southwest)-[1-9][0-9]*(?![\s\S])/.test(region) ||
      typeof config.authorize !== 'function' || !config.records ||
      typeof config.records.get !== 'function' || typeof config.records.create !== 'function') throw new CertificateStorageError()
  const s3 = new S3Client({ region, endpoint: `https://s3.${region}.amazonaws.com` })
  return new PrivateCertificateStorage({
    enabled: true, bucket: config.bucket, authorize: config.authorize, records: config.records,
    s3: { put: (command) => s3.send(command), get: (command) => s3.send(command) },
  })
}
