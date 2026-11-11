// Synthetic Unix-socket ClamAV protocol fixture; never used by the application.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Behavior = (socket: Socket, scanned: Buffer) => void
export async function mockScanner(behavior: Behavior = (socket) => socket.end('stream: OK\0')) {
  const dir = await mkdtemp(join(tmpdir(), 'inspect-'))
  const path = join(dir, 'clam.sock')
  let count = 0
  const active = new Set<Socket>()
  const received: Buffer[] = []
  const server = createServer({ allowHalfOpen: true }, socket => {
    active.add(socket); socket.on('close', () => active.delete(socket)); socket.on('error', () => {})
    let buf = Buffer.alloc(0), header = false, length: number | undefined, complete = false
    const chunks: Buffer[] = []
    socket.on('data', part => {
      if (complete) return
      buf = Buffer.concat([buf, part])
      if (!header) {
        const terminator = buf.indexOf(0)
        if (terminator < 0) return
        assert.equal(buf.subarray(0, terminator).toString(), 'zINSTREAM')
        buf = buf.subarray(terminator + 1); header = true
      }
      while (true) {
        if (length === undefined) {
          if (buf.length < 4) return
          length = buf.readUInt32BE(); buf = buf.subarray(4)
          assert.ok(length <= 65536)
          if (length === 0) {
            assert.equal(buf.length, 0)
            complete = true; count++
            const scanned = Buffer.concat(chunks); received.push(scanned)
            behavior(socket, scanned); return
          }
        }
        if (buf.length < length) return
        chunks.push(Buffer.from(buf.subarray(0, length))); buf = buf.subarray(length); length = undefined
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  return { path, received, get count() { return count }, async close() {
    for (const socket of active) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  } }
}
