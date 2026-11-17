import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const run = promisify(execFile)

const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'miaf',
  'mihe',
  'mihb',
])

function isHeic(buf: Buffer): boolean {
  if (!buf || buf.length < 16) return false
  if (buf.subarray(4, 8).toString('ascii') !== 'ftyp') return false
  const brand = buf.subarray(8, 12).toString('ascii').toLowerCase()
  return HEIC_BRANDS.has(brand)
}

function hasHeicName(name = ''): boolean {
  const ext = path.extname(name).toLowerCase()
  return ext === '.heic' || ext === '.heif' || ext === '.avif'
}

// Normalize upload to JPEG if HEIC/HEIF; pass through PNG/JPEG/PDF/TIFF/WebP as-is.
// Returns the buffer and its MIME type, or null if conversion fails.
export async function normalizeImage(
  buffer: Buffer,
  originalName = '',
): Promise<{ buffer: Buffer; mime: string } | null> {
  if (isHeic(buffer) || hasHeicName(originalName)) {
    const tmp = path.join(os.tmpdir(), `coi-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const inPath = tmp + '.heic'
    const outPath = tmp + '.jpg'
    try {
      await fs.writeFile(inPath, buffer)
      // Primary: heif-convert
      let converted = false
      try {
        await run('heif-convert', ['-q', '95', inPath, outPath])
        converted = true
      } catch {
        /* fallback below */
      }
      if (!converted) {
        // Fallback: ImageMagick convert (handles preview HEIC variants)
        try {
          await run('convert', [inPath, outPath])
          converted = true
        } catch {
          /* give up */
        }
      }
      if (!converted) return null
      const out = await fs.readFile(outPath)
      return { buffer: out, mime: 'image/jpeg' }
    } catch (e) {
      console.error('HEIC conversion failed:', e)
      return null
    } finally {
      await fs.unlink(inPath).catch(() => {})
      await fs.unlink(outPath).catch(() => {})
    }
  }
  const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8
  const isPdf = buffer.subarray(0, 4).toString('ascii') === '%PDF'
  const isWebp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  const isTiff =
    buffer.subarray(0, 2).equals(Buffer.from([0x49, 0x49])) || buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x4d]))
  const mime = isPdf
    ? 'application/pdf'
    : isPng
    ? 'image/png'
    : isJpg
    ? 'image/jpeg'
    : isWebp
    ? 'image/webp'
    : isTiff
    ? 'image/tiff'
    : 'application/octet-stream'
  return { buffer, mime }
}

// Normalizes the uploaded file BEFORE it is stored so the stored object is a
// browser-renderable JPEG when the input was HEIC/HEIF.
export async function prepareUploadFile<
  T extends { buffer: Buffer; mimetype?: string; size: number; originalname?: string }
>(file: T): Promise<T> {
  const norm = await normalizeImage(file.buffer, file.originalname)
  if (!norm) return file
  if (norm.buffer !== file.buffer) {
    const ext = norm.mime === 'image/jpeg' ? '.jpg' : path.extname(file.originalname || '')
    const base = path.basename(file.originalname || 'certificate', path.extname(file.originalname || ''))
    return {
      ...file,
      buffer: norm.buffer,
      mimetype: norm.mime,
      size: norm.buffer.length,
      originalname: `${base}${ext}`,
    }
  }
  return file
}

export function isTextractCompatible(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'application/pdf', 'image/tiff', 'image/webp'].includes(mime)
}
