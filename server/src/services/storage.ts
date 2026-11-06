import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import dotenv from 'dotenv'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_UPLOADS = path.resolve(__dirname, '../../uploads')

const REGION = process.env.AWS_REGION || 'us-east-1'
const BUCKET = process.env.AWS_S3_BUCKET || ''
const KEY_ID = process.env.AWS_ACCESS_KEY_ID || ''
const SECRET = process.env.AWS_SECRET_ACCESS_KEY || ''
const ENDPOINT = process.env.AWS_S3_ENDPOINT || undefined

export const isS3Configured = Boolean(
  BUCKET &&
  KEY_ID &&
  SECRET &&
  !KEY_ID.startsWith('your-') &&
  !SECRET.startsWith('your-')
)

let s3: S3Client | null = null
function getS3(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: REGION,
      endpoint: ENDPOINT,
      forcePathStyle: Boolean(ENDPOINT),
      credentials: {
        accessKeyId: KEY_ID,
        secretAccessKey: SECRET,
      },
    })
  }
  return s3
}

export interface StoredFile {
  url: string
  key: string
  filename: string
  size: number
  mime: string
}

export async function storeFile(file: Express.Multer.File): Promise<StoredFile> {
  const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`

  if (isS3Configured) {
    const key = `cois/${safeName}`
    const client = getS3()
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    )
    const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
    return { url, key, filename: file.originalname, size: file.size, mime: file.mimetype }
  }

  // Local disk fallback (dev-ready, zero config)
  fs.mkdirSync(LOCAL_UPLOADS, { recursive: true })
  const destPath = path.join(LOCAL_UPLOADS, safeName)
  fs.writeFileSync(destPath, file.buffer)
  return {
    url: `/uploads/${safeName}`,
    key: safeName,
    filename: file.originalname,
    size: file.size,
    mime: file.mimetype,
  }
}

export async function getFileViewUrl(key: string, storedUrl?: string): Promise<string> {
  if (!isS3Configured) {
    return storedUrl || `/uploads/${key}`
  }
  const client = getS3()
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: key })
    return await getSignedUrl(client, command, { expiresIn: 3600 })
  } catch {
    return storedUrl || '#'
  }
}

export { LOCAL_UPLOADS }
