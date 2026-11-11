import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { inspectPrivateFile, InspectionError, type InspectionConfig, type InspectionMime } from '../src/services/privateFileInspection.ts'
import { mockScanner, type Behavior } from './mock-clamav-fixture.ts'

const files: [string, InspectionMime][] = [['sample.pdf', 'application/pdf'], ['sample.jpg', 'image/jpeg'], ['sample.png', 'image/png'], ['sample.webp', 'image/webp']]
const fixture = (file: string) => readFile(new URL(`./fixtures/private-inspection/${file}`, import.meta.url))
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const python = process.env.PRIVATE_INSPECTION_TEST_PYTHON
if (!python || !python.startsWith('/')) throw new Error('Set PRIVATE_INSPECTION_TEST_PYTHON to an absolute isolated virtualenv Python path')
const config = (path: string): InspectionConfig => ({ socketPath: path, maxFileBytes: 10 * 1024 * 1024,
  scannerDeadlineMs: 3000, parserDeadlineMs: 5000, pythonPath: python, prlimitPath: '/usr/bin/prlimit',
  pdfRendererPath: '/usr/bin/pdftoppm', parserMemoryBytes: 512 * 1024 * 1024, parserCpuSeconds: 10 })
const fails = (code: string) => (err: unknown) => err instanceof InspectionError && err.code === code && err.message === 'Private file inspection failed'

test('valid PDF and all three photo formats are fully passed to the local scanner', async () => {
  const mock = await mockScanner()
  try {
    for (const [file, mime] of files) {
      const bytes = await fixture(file)
      const result = await inspectPrivateFile(bytes, mime, config(mock.path))
      assert.deepEqual(result, { mime, size: bytes.length, sha256: digest(bytes) })
      assert.ok(Object.isFrozen(result)); assert.deepEqual(mock.received.at(-1), bytes)
    }
    assert.equal(mock.count, 4)
  } finally { await mock.close() }
})

test('input errors, mismatch, oversized input and structurally invalid/truncated content fail closed', async () => {
  const mock = await mockScanner()
  try {
    const png = await fixture('sample.png'), jpeg = await fixture('sample.jpg'), webp = await fixture('sample.webp'), pdf = await fixture('sample.pdf'), encrypted = await fixture('encrypted.pdf')
    for (const [bytes, mime] of [[Buffer.alloc(0), 'image/png'], [png, 'image/jpeg'], [pdf, 'text/html'], [Buffer.alloc(101), 'image/png']] as const) {
      await assert.rejects(inspectPrivateFile(bytes, mime, { ...config(mock.path), maxFileBytes: 100 }), fails('invalid_input'))
    }
    const damagedPng = Buffer.from(png); damagedPng[damagedPng.length - 5] ^= 1
    const shorterWebp = Buffer.from(webp.subarray(0, webp.length - 8)); shorterWebp.writeUInt32LE(shorterWebp.length - 8, 4)
    const brokenJpeg = Buffer.concat([jpeg.subarray(0, 150), Buffer.from([0xff, 0xd9])])
    const cases: [Buffer, InspectionMime][] = [
      [Buffer.from('%PDF-'), 'application/pdf'], [Buffer.from('%PDF-1.7\nfake\n%%EOF'), 'application/pdf'], [Buffer.concat([pdf.subarray(0, 60), Buffer.from('\n%%EOF')]), 'application/pdf'], [encrypted, 'application/pdf'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'], [brokenJpeg, 'image/jpeg'], [jpeg.subarray(0, jpeg.length - 2), 'image/jpeg'],
      [png.subarray(0, 30), 'image/png'], [damagedPng, 'image/png'], [Buffer.concat([png, Buffer.from('junk')]), 'image/png'],
      [webp.subarray(0, webp.length - 1), 'image/webp'], [shorterWebp, 'image/webp'],
    ]
    for (const [bytes, mime] of cases) await assert.rejects(inspectPrivateFile(bytes, mime, config(mock.path)), fails('format_rejected'))
    assert.equal(mock.count, 0)
    for (const bad of [{ socketPath: 'remote-host:3310' }, { socketPath: '/tmp/a\0b' }, { maxFileBytes: 0 }, { maxFileBytes: 10 * 1024 * 1024 + 1 }, { scannerDeadlineMs: 0 }, { parserMemoryBytes: 1 }])
      await assert.rejects(inspectPrivateFile(png, 'image/png', { ...config(mock.path), ...bad }), fails('invalid_input'))
  } finally { await mock.close() }
})

test('configured byte cap includes the exact boundary', async () => {
  const mock = await mockScanner()
  try {
    const png = await fixture('sample.png')
    assert.equal((await inspectPrivateFile(png, 'image/png', { ...config(mock.path), maxFileBytes: png.length })).size, png.length)
    await assert.rejects(inspectPrivateFile(png, 'image/png', { ...config(mock.path), maxFileBytes: png.length - 1 }), fails('invalid_input'))
    await assert.rejects(inspectPrivateFile(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', config(mock.path)), fails('invalid_input'))
    assert.equal(mock.count, 1)
  } finally { await mock.close() }
})

test('malware, scanner errors, malformed or oversized replies, early close, and timeouts all reject', async () => {
  const png = await fixture('sample.png')
  const scenarios: [Behavior, string][] = [
    [s => s.end('stream: Eicar-Test-Signature FOUND\0'), 'malware_detected'],
    [s => s.end('stream: INSTREAM size limit exceeded. ERROR\0'), 'scanner_failure'],
    [s => s.end('stream: OK\n'), 'scanner_failure'], [s => s.end('stream: OK\0extra'), 'scanner_failure'],
    [s => s.end('stream: OK\0stream: OK\0'), 'scanner_failure'], [s => s.end(Buffer.alloc(513, 65)), 'scanner_failure'],
    [s => s.end(), 'scanner_failure'], [() => {}, 'scanner_failure'],
    [s => s.write('stream: OK\0'), 'scanner_failure'],
  ]
  for (const [behavior, failure] of scenarios) {
    const mock = await mockScanner(behavior)
    try { await assert.rejects(inspectPrivateFile(png, 'image/png', { ...config(mock.path), scannerDeadlineMs: 100 }), fails(failure)) }
    finally { await mock.close() }
  }
  await assert.rejects(inspectPrivateFile(png, 'image/png', config('/tmp/nonexistent-clamd-for-test.sock')), fails('scanner_failure'))
})

test('parser executables missing, non-parser success and parser timeout all fail closed', async () => {
  const mock = await mockScanner(), dir = await mkdtemp(join(tmpdir(), 'inspect-worker-'))
  try {
    const png = await fixture('sample.png'), pdf = await fixture('sample.pdf')
    const sleeper = join(dir, 'sleeper')
    await writeFile(sleeper, '#!/bin/sh\nexec /bin/sleep 3\n'); await chmod(sleeper, 0o700)
    for (const [data, mime, overrides] of [
      [png, 'image/png', { pythonPath: '/tmp/missing-python-inspection' }],
      [png, 'image/png', { prlimitPath: '/tmp/missing-prlimit-inspection' }],
      [png, 'image/png', { pythonPath: '/bin/true' }],
      [png, 'image/png', { pythonPath: sleeper, parserDeadlineMs: 50 }],
      [pdf, 'application/pdf', { pdfRendererPath: '/tmp/missing-pdf-renderer' }],
    ] as const) await assert.rejects(inspectPrivateFile(data, mime, { ...config(mock.path), ...overrides }), fails('format_rejected'))
    assert.equal(mock.count, 0)
  } finally { await mock.close(); await rm(dir, { recursive: true, force: true }) }
})

test('a mutated caller buffer cannot change what is parsed, scanned, and hashed', async () => {
  const mock = await mockScanner()
  try {
    const input = await fixture('sample.png'), original = Buffer.from(input)
    const c = config(mock.path)
    const pending = inspectPrivateFile(input, 'image/png', c)
    input.fill(0)
    c.socketPath = '/tmp/missing-mutated-config.sock'; c.maxFileBytes = 1
    const result = await pending
    assert.equal(result.sha256, digest(original)); assert.deepEqual(mock.received[0], original)
  } finally { await mock.close() }
})

// Construct a large well-formed PNG without a separate imaging dependency in the test process.
function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length)
  let n = 0xffffffff
  for (const byte of Buffer.concat([name, data])) { n ^= byte; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0) }
  crc.writeUInt32BE((n ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, name, data, crc])
}
test('oversized decoded image dimensions reject before a scanner request', async () => {
  const mock = await mockScanner()
  try {
    const png = await fixture('sample.png'), header = Buffer.from(png.subarray(16, 29))
    header.writeUInt32BE(6000, 0); header.writeUInt32BE(6000, 4)
    const bomb = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), png.subarray(33)])
    await assert.rejects(inspectPrivateFile(bomb, 'image/png', config(mock.path)), fails('format_rejected'))
    assert.equal(mock.count, 0)
  } finally { await mock.close() }
})

test('bounded multi-chunk INSTREAM transmits the exact inspected bytes', async () => {
  const mock = await mockScanner()
  try {
    const w = 700, h = 700, header = Buffer.alloc(13); header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2
    const raw = Buffer.alloc((w * 3 + 1) * h)
    for (let y = 0; y < h; y++) randomBytes(w * 3).copy(raw, y * (w * 3 + 1) + 1)
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
    assert.ok(png.length > 65536)
    const result = await inspectPrivateFile(png, 'image/png', config(mock.path))
    assert.equal(result.sha256, digest(png)); assert.deepEqual(mock.received[0], png)
  } finally { await mock.close() }
})

test('deadline also applies if a scanner accepts a connection but never reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inspect-stall-')), path = join(dir, 's.sock')
  const active = new Set<Socket>()
  const server = createServer({ pauseOnConnect: true }, socket => { active.add(socket); socket.on('close', () => active.delete(socket)); socket.on('error', () => {}) })
  await new Promise<void>(resolve => server.listen(path, resolve))
  try {
    const png = await fixture('sample.png')
    await assert.rejects(inspectPrivateFile(png, 'image/png', { ...config(path), scannerDeadlineMs: 100 }), fails('scanner_failure'))
  } finally {
    for (const socket of active) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
