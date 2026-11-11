import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export type InspectionMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
export type InspectionRecord = Readonly<{ mime: InspectionMime; size: number; sha256: string }>
export type InspectionFailure = 'invalid_input' | 'format_rejected' | 'scanner_failure' | 'malware_detected'
export class InspectionError extends Error {
  readonly code: InspectionFailure
  constructor(code: InspectionFailure) { super('Private file inspection failed'); this.name = 'InspectionError'; this.code = code }
}

const HARD_MAX_BYTES = 10 * 1024 * 1024
const CHUNK_SIZE = 64 * 1024
const WORKER = fileURLToPath(new URL('./privateFileInspectionWorker.py', import.meta.url))
export interface InspectionConfig {
  // All values are trusted server-side configuration, never derived from a request.
  socketPath: string
  maxFileBytes: number
  scannerDeadlineMs: number
  parserDeadlineMs: number
  pythonPath: string
  prlimitPath: string
  pdfRendererPath: string
  parserMemoryBytes: number
  parserCpuSeconds: number
}
function validInt(n: number, min: number, max: number) { return Number.isSafeInteger(n) && n >= min && n <= max }
function validPath(p: unknown) { return typeof p === 'string' && isAbsolute(p) && !p.includes('\0') }
function validateConfig(c: InspectionConfig) {
  if (!c || !validPath(c.socketPath) || Buffer.byteLength(c.socketPath) > 100 ||
      !validPath(c.pythonPath) || !validPath(c.prlimitPath) || !validPath(c.pdfRendererPath) ||
      !validInt(c.maxFileBytes, 1, HARD_MAX_BYTES) || !validInt(c.scannerDeadlineMs, 10, 120_000) ||
      !validInt(c.parserDeadlineMs, 10, 120_000) || !validInt(c.parserMemoryBytes, 128 * 1024 * 1024, 1024 * 1024 * 1024) ||
      !validInt(c.parserCpuSeconds, 1, 60)) throw new InspectionError('invalid_input')
}
function hasSignature(b: Buffer, mime: string): mime is InspectionMime {
  switch (mime) {
    case 'application/pdf': return b.subarray(0, 5).equals(Buffer.from('%PDF-'))
    case 'image/jpeg': return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    case 'image/png': return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/webp': return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
    default: return false
  }
}

function parseFile(bytes: Buffer, mime: InspectionMime, c: InspectionConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    // No shell, no inherited application secrets or file descriptors; kill the process group on timeout.
    const child = spawn(c.prlimitPath, [
      `--as=${c.parserMemoryBytes}`, `--cpu=${c.parserCpuSeconds}`, '--fsize=0', '--core=0', '--nofile=32',
      '--', c.pythonPath, '-I', WORKER, mime, c.pdfRendererPath,
    ], { stdio: ['pipe', 'pipe', 'ignore'], detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    let done = false
    let inputFinished = false
    let output = ''
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!ok && child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ } }
      if (ok) resolve(); else reject(new InspectionError('format_rejected'))
    }
    const timer = setTimeout(() => finish(false), c.parserDeadlineMs)
    child.on('error', () => finish(false))
    child.stdin.on('error', () => finish(false))
    child.stdout.on('error', () => finish(false))
    child.stdout.on('data', (part: Buffer) => {
      output += part.toString('latin1')
      if (output.length > 32) finish(false)
    })
    child.stdin.on('finish', () => { inputFinished = true })
    child.on('close', (code, signal) => finish(code === 0 && signal === null && inputFinished && output === 'INSPECTION-PARSE-OK\n'))
    child.stdin.end(bytes)
  })
}

function scanFile(bytes: Buffer, c: InspectionConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false, sent = false, writeFinished = false, offset = 0, totalReply = 0
    const replies: Buffer[] = []
    const socket = createConnection({ path: c.socketPath })
    const timer = setTimeout(() => finish('scanner_failure'), c.scannerDeadlineMs)
    function finish(error?: InspectionFailure) {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(new InspectionError(error)); else resolve()
    }
    function pump() {
      if (done) return
      while (offset < bytes.length) {
        const end = Math.min(offset + CHUNK_SIZE, bytes.length)
        const size = Buffer.alloc(4); size.writeUInt32BE(end - offset)
        // At most one chunk is enqueued past the backpressure threshold.
        socket.write(size)
        const ready = socket.write(bytes.subarray(offset, end))
        offset = end
        if (!ready) return
      }
      if (!sent) { sent = true; socket.end(Buffer.alloc(4)) }
    }
    socket.on('connect', () => { socket.write('zINSTREAM\0'); pump() })
    socket.on('drain', pump)
    socket.on('finish', () => { writeFinished = true })
    socket.on('error', () => finish('scanner_failure'))
    socket.on('data', (part: Buffer) => {
      totalReply += part.length
      if (totalReply > 512) return finish('scanner_failure')
      replies.push(Buffer.from(part))
    })
    socket.on('close', hadError => {
      if (done) return
      const reply = Buffer.concat(replies).toString('latin1')
      if (hadError || !sent || !writeFinished) return finish('scanner_failure')
      if (reply === 'stream: OK\0') return finish()
      // Do not reveal the signature name, response, or file bytes.
      if (/^stream: [\x20-\x7e]{1,400} FOUND\x00$/.test(reply)) return finish('malware_detected')
      finish('scanner_failure')
    })
  })
}

/** Never exposes the snapshot; the result is evidence of checks, not a safety guarantee. */
export async function inspectPrivateFile(input: Uint8Array, declaredMime: string, config: InspectionConfig): Promise<InspectionRecord> {
  // Copy configuration too: caller mutation cannot change limits/paths while inspection is underway.
  const c = { ...config }
  validateConfig(c)
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > c.maxFileBytes) throw new InspectionError('invalid_input')
  // Snapshot synchronously before the first await; subsequent caller mutations cannot change the checked bytes.
  const bytes = Buffer.from(input)
  if (!hasSignature(bytes, declaredMime)) throw new InspectionError('invalid_input')
  await parseFile(bytes, declaredMime, c)
  await scanFile(bytes, c)
  return Object.freeze({ mime: declaredMime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
}
