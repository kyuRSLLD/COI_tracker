import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
const run = promisify(execFile)
const HEIC_SIGNATURES = [Buffer.from('ftypheic'), Buffer.from('ftypheix'), Buffer.from('ftypmif1'), Buffer.from('ftypmsf1')]
function isHeic(buf: Buffer): boolean {
  if (buf.length < 16) return false
  const slice = buf.subarray(4, 16)
  return HEIC_SIGNATURES.some(s => slice.includes(s))
}
// Normalize upload to JPEG if HEIC; pass through PNG/JPEG/PDF/TIFF as-is.
// Returns the buffer and its MIME type, or null if conversion fails.
export async function normalizeImage(buffer: Buffer, originalName = ''): Promise<{ buffer: Buffer; mime: string } | null> {
  const ext = path.extname(originalName).toLowerCase()
  if (isHeic(buffer) || ext === '.heic' || ext === '.heif') {
    const tmp = path.join(os.tmpdir(), `coi-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const inPath = tmp + '.heic'
    const outPath = tmp + '.jpg'
    try {
      await fs.writeFile(inPath, buffer)
      await run('heif-convert', ['-q', '95', inPath, outPath])
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
  const isTiff = buffer.subarray(0, 2).equals(Buffer.from([0x49, 0x49])) || buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x4d]))
  const mime = isPdf ? 'application/pdf' : isPng ? 'image/png' : isJpg ? 'image/jpeg' : isTiff ? 'image/tiff' : 'application/octet-stream'
  return { buffer, mime }
}
export function isTextractCompatible(mime: string): boolean {
  return ['image/jpeg', 'image/png', 'application/pdf', 'image/tiff'].includes(mime)
}
