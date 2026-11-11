import fs from 'node:fs'
import { promises as fsp, constants } from 'node:fs'
import path from 'node:path'
import { LOCAL_UPLOADS } from './storage.ts'
import { relationshipPrototypeEnvironmentSafe } from '../db/db.ts'
import { stagedInvitationAuthConfigured } from '../middleware/auth.ts'

// This store has no integration with S3, legacy uploads, keys, URLs, or upload APIs.
// Capture the opt-in and directory identity at module load; changing either later
// cannot enable this feature or redirect it to a different directory.
const bootFlag = process.env.PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED
const bootDirectory = process.env.PRIVATE_CERTIFICATE_TEST_DIR
const bootMode = process.env.NODE_ENV
let bootIdentity: { dev: number, ino: number } | undefined
try {
  if (bootDirectory) {
    const s = fs.lstatSync(bootDirectory)
    if (s.isDirectory()) bootIdentity = { dev: s.dev, ino: s.ino }
  }
} catch { /* unavailable until a valid directory exists at boot */ }

const overlapping = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
function publicUploadsRealPath(): string {
  try { return fs.realpathSync(LOCAL_UPLOADS) } catch {
    return path.join(fs.realpathSync(path.dirname(LOCAL_UPLOADS)), path.basename(LOCAL_UPLOADS))
  }
}
export function privateCertificateEnvironmentSafe(): boolean {
  try {
    if (process.platform !== 'linux' || bootFlag !== 'true' || process.env.PRIVATE_CERTIFICATE_PROTOTYPE_ENABLED !== bootFlag ||
        !['test', 'development'].includes(bootMode || '') || process.env.NODE_ENV !== bootMode ||
        !bootDirectory || process.env.PRIVATE_CERTIFICATE_TEST_DIR !== bootDirectory || !bootIdentity ||
        !path.isAbsolute(bootDirectory) || path.normalize(bootDirectory) !== bootDirectory ||
        !path.basename(bootDirectory).startsWith('coi-synthetic-certificates-') ||
        !relationshipPrototypeEnvironmentSafe() || !stagedInvitationAuthConfigured()) return false
    const tmp = fs.realpathSync('/tmp')
    const real = fs.realpathSync(bootDirectory)
    if (real !== bootDirectory || !real.startsWith(tmp + path.sep) || overlapping(real, path.resolve(LOCAL_UPLOADS)) || overlapping(real, publicUploadsRealPath())) return false
    const s = fs.lstatSync(bootDirectory)
    return s.isDirectory() && s.dev === bootIdentity.dev && s.ino === bootIdentity.ino &&
      s.uid === process.getuid?.() && (s.mode & 0o077) === 0
  } catch { return false }
}

export const certificateIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const formats: Record<string, { extension: string, magic: (b: Buffer) => boolean }> = {
  'application/pdf': { extension: 'pdf', magic: b => b.subarray(0, 5).equals(Buffer.from('%PDF-')) },
  'image/png': { extension: 'png', magic: b => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { extension: 'jpg', magic: b => b.subarray(0, 3).equals(Buffer.from([255, 216, 255])) },
  'image/webp': { extension: 'webp', magic: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
}

// The physical filename is the lowercase UUID COI ID, not a database key or URL.
// Pin the root directory descriptor and use O_NOFOLLOW on the final component.
// Linux /proc/self/fd makes the lookup relative to that pinned directory.
export async function openSyntheticCertificate(id: string, mime: unknown) {
  if (!privateCertificateEnvironmentSafe() || !certificateIdPattern.test(id) || typeof mime !== 'string' || !Object.hasOwn(formats, mime)) return undefined
  let dir: fsp.FileHandle | undefined
  let file: fsp.FileHandle | undefined
  try {
    dir = await fsp.open(bootDirectory!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const d = await dir.stat()
    if (d.dev !== bootIdentity!.dev || d.ino !== bootIdentity!.ino || !privateCertificateEnvironmentSafe()) return undefined
    file = await fsp.open(`/proc/self/fd/${dir.fd}/${id}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 12 || stat.size > 20 * 1024 * 1024) return undefined
    const header = Buffer.alloc(12)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    if (bytesRead !== 12 || !formats[mime].magic(header)) return undefined
    const result = { file, size: stat.size, mime, extension: formats[mime].extension }
    file = undefined // ownership passes to caller
    return result
  } catch {
    return undefined
  } finally {
    await file?.close().catch(() => {})
    await dir?.close().catch(() => {})
  }
}
