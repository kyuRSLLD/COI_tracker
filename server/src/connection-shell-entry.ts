// Separate opt-in source entry; not wired into existing deployment configuration.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createPilot } from './pilot-bootstrap.ts'
import { createConnectionShell } from './connection-shell-wrapper.ts'

async function main() {
  const text = process.env.PORT
  if (!text || !/^[1-9][0-9]*$/.test(text) || Number(text) > 65535) throw new Error('Unavailable')
  const pilot = createPilot(process.env)
  pilot.pool.on('error', () => {})
  try {
    const app = createConnectionShell(pilot.app, fileURLToPath(new URL('../../client/connection-pilot/dist', import.meta.url)))
    // Same connectivity and shared-key check as pilot-entry; this is not readiness.
    await pilot.pool.query('SELECT bucket_key, minute, hits FROM public.pilot_rate_buckets_v1 LIMIT 0')
    if (!await pilot.limiter.verify()) throw new Error('Unavailable')
    const server = createServer({ maxHeaderSize: 8192 }, app)
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.timeout = 15_000
    server.keepAliveTimeout = 5_000
    server.maxConnections = 100
    let closing = false
    const stop = (failed = false) => {
      if (closing) return
      closing = true
      const forced = setTimeout(() => { server.closeAllConnections(); process.exit(1) }, 10_000)
      forced.unref()
      server.close(() => { void pilot.pool.end().finally(() => { pilot.ses.destroy(); pilot.httpsAgent.destroy(); clearTimeout(forced); process.exit(failed ? 1 : 0) }) })
    }
    server.on('error', () => stop(true))
    process.once('SIGTERM', () => stop()); process.once('SIGINT', () => stop())
    server.listen(Number(text), '0.0.0.0')
  } catch {
    await pilot.pool.end().catch(() => {})
    pilot.ses.destroy(); pilot.httpsAgent.destroy()
    throw new Error('Unavailable')
  }
}
void main().catch(() => { console.error('Connection shell startup unavailable'); process.exitCode = 1 })
