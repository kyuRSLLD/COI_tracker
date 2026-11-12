// Separate entrypoint. Never import legacy app or run migrations here.
import { createPilot } from './pilot-bootstrap.ts'

async function main() {
  const portText = process.env.PORT
  if (!portText || !/^[1-9][0-9]*$/.test(portText) || Number(portText) > 65535) throw new Error('Invalid pilot configuration')
  const { app, pool, ses, httpsAgent, limiter } = createPilot(process.env)
  pool.on('error', () => { /* Fail subsequent requests closed; never log driver errors. */ })
  try {
    // Schema presence/connectivity only, not migration correctness or readiness.
    await pool.query('SELECT bucket_key, minute, hits FROM public.pilot_rate_buckets_v1 LIMIT 0')
    if (!await limiter.verify()) throw new Error('Unavailable')
    const server = app.listen(Number(portText), '0.0.0.0')
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    server.keepAliveTimeout = 5000
    server.maxConnections = 100
    let closing = false
    const stop = (failed = false) => {
      if (closing) return
      closing = true
      const forced = setTimeout(() => { server.closeAllConnections(); process.exit(1) }, 10000)
      forced.unref()
      server.close(() => { void pool.end().finally(() => { ses.destroy(); httpsAgent.destroy(); clearTimeout(forced); process.exit(failed ? 1 : 0) }) })
    }
    server.on('error', () => { stop(true) })
    process.once('SIGTERM', () => stop()); process.once('SIGINT', () => stop())
  } catch {
    await pool.end().catch(() => {})
    ses.destroy(); httpsAgent.destroy()
    throw new Error('Pilot startup unavailable')
  }
}
void main().catch(() => { console.error('Pilot startup unavailable'); process.exitCode = 1 })
