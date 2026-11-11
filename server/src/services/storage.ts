import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetPublicAccessBlockCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import dotenv from 'dotenv'

dotenv.config()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_UPLOADS = path.resolve(__dirname, '../../uploads')
// Unlike LOCAL_UPLOADS this directory is never mounted by express.static.
// .work is ignored by the repository; never accidentally stage local certificates.
const PRIVATE_UPLOADS = path.resolve(__dirname, '../../.work/private-uploads')
const REGION = process.env.AWS_REGION || 'us-east-1'
const BUCKET = process.env.AWS_S3_BUCKET || ''
const ENDPOINT = process.env.AWS_S3_ENDPOINT || undefined
export const isS3Configured = Boolean(BUCKET && !BUCKET.startsWith('your-'))
export const s3Bucket = BUCKET
export const s3Region = REGION
let s3: S3Client | null = null
function getS3(): S3Client {
  // The SDK default credential chain supports environment keys and IAM roles.
  if (!s3) s3 = new S3Client({ region: REGION, endpoint: ENDPOINT, forcePathStyle: Boolean(ENDPOINT), maxAttempts: 2 })
  return s3
}
export interface StoredFile { url: string; key: string; filename: string; size: number; mime: string }
export async function storeFile(file: Express.Multer.File): Promise<StoredFile> {
  const safeName = `${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)}`
  if (isS3Configured) {
    const key = `cois/${safeName}`
    await getS3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: file.mimetype }))
    return { url: '', key, filename: file.originalname, size: file.size, mime: file.mimetype }
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Private object storage is not configured')
  fs.mkdirSync(LOCAL_UPLOADS, { recursive: true })
  fs.writeFileSync(path.join(LOCAL_UPLOADS, safeName), file.buffer)
  return { url: `/uploads/${safeName}`, key: safeName, filename: file.originalname, size: file.size, mime: file.mimetype }
}
export async function getFileViewUrl(key: string, storedUrl?: string): Promise<string> {
  if (!isS3Configured) {
    if (process.env.NODE_ENV === 'production') throw new Error('Object storage is not configured')
    return storedUrl || `/uploads/${key}`
  }
  // Fail closed rather than falling back to a public URL on signing errors.
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 300 })
}

export interface PrivateStoredFile { key: string; backend: 's3' | 'local' }
export async function storePrivateFile(file: Express.Multer.File, mime: string): Promise<PrivateStoredFile> {
  const name = randomUUID()
  if (isS3Configured) {
    // Refuse private uploads unless the bucket itself enforces all four public-access
    // blocks. Missing permissions/configuration are failures, never public fallbacks.
    if (process.env.NODE_ENV === 'production') {
      const { PublicAccessBlockConfiguration: p } = await getS3().send(new GetPublicAccessBlockCommand({ Bucket: BUCKET }))
      if (!p?.BlockPublicAcls || !p.IgnorePublicAcls || !p.BlockPublicPolicy || !p.RestrictPublicBuckets) throw new Error('Bucket public access blocking is required')
    }
    const key = `private/coi-drafts/${name}`
    await getS3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: mime, ContentDisposition: 'attachment' }))
    return { key, backend: 's3' }
  }
  if (process.env.NODE_ENV === 'production') throw new Error('Private object storage is not configured')
  fs.mkdirSync(PRIVATE_UPLOADS, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(PRIVATE_UPLOADS, name), file.buffer, { flag: 'wx', mode: 0o600 })
  return { key: name, backend: 'local' }
}
export async function deletePrivateFile(stored: PrivateStoredFile): Promise<void> {
  if (stored.backend === 's3') await getS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: stored.key }))
  else fs.unlinkSync(privateLocalPath(stored.key))
}
export function privateLocalPath(key: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('Invalid private key')
  return path.join(PRIVATE_UPLOADS, key)
}
export async function signedPrivateFileUrl(key: string): Promise<string> {
  if (!isS3Configured || !/^private\/coi-drafts\/[0-9a-f-]{36}$/i.test(key)) throw new Error('Private storage unavailable')
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: 'attachment' }), { expiresIn: 300 })
}
export { LOCAL_UPLOADS }
