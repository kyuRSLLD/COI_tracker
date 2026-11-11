// Deliberately unmounted. This router does not authenticate; the caller MUST supply
// externally verified middleware and protect the entire router from bypass.
import { Router } from 'express'
import type { Request, RequestHandler, Response } from 'express'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream'
import type pg from 'pg'
import { privateCertificateRepository } from '../services/privateCertificateRepository.ts'
import { CertificateAccessDeniedError, CertificateInputError, MAX_CERTIFICATE_BYTES } from '../services/privateCertificateStorage.ts'
import type { AuthorizeCertificate, CertificateRecordRepository, PrivateCertificateStorage } from '../services/privateCertificateStorage.ts'

type Principal = { subject: string; role: string; credential: string }
type SecureRequest = Request & { securePrincipal?: Principal }
type StorageFactory = (config: { authorize: AuthorizeCertificate; records: CertificateRecordRepository }) => PrivateCertificateStorage
const id = /^[A-Za-z0-9_-]{1,128}$/
const types = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])

/** Compose only behind a separately reviewed credential-verification boundary. */
export function privateCertificatesRouter(options: {
  enabled?: boolean; verifiedMiddleware?: RequestHandler; pool?: pg.Pool; makeStorage?: StorageFactory
} = {}) {
  const router = Router()
  // Default off, including when accidentally mounted. No dependencies accessed.
  if (options.enabled !== true) {
    router.use((_req, res) => res.set({ 'Cache-Control': 'private, no-store', 'Connection': 'close' }).status(503).json({ error: 'Unavailable' }))
    return router
  }
  if (typeof options.verifiedMiddleware !== 'function' || !options.pool || typeof options.pool.query !== 'function' || typeof options.makeStorage !== 'function') {
    throw new Error('Verified middleware, PostgreSQL pool and storage factory required')
  }
  const pool = options.pool, makeStorage = options.makeStorage
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); next() })
  // Discard any value placed on the request by earlier, untrusted middleware.
  router.use((req, _res, next) => { delete (req as SecureRequest).securePrincipal; next() })
  router.use(options.verifiedMiddleware)
  router.use((_error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
    if (!res.headersSent) res.status(503).json({ error: 'Unavailable' })
    else res.destroy()
  })

  const handler = (action: 'upload' | 'download'): RequestHandler => async (req: SecureRequest, res: Response) => {
    const p = req.securePrincipal
    const certificateId = req.params.certificateId
    const reject = (status: number, error: string) => {
      if (action === 'upload') res.set('Connection', 'close')
      res.status(status).json({ error })
    }
    // Credential and role are supplied by the verified boundary, never body/header/query.
    if (!p || typeof p.subject !== 'string' || !id.test(p.subject) || typeof p.credential !== 'string' || !p.credential || p.credential.length > 8192 || typeof p.role !== 'string') {
      reject(401, 'Unavailable'); return
    }
    if (!id.test(certificateId) || Object.keys(req.query).length !== 0) { reject(400, 'Invalid request'); return }
    if (p.role === 'gc') {
      // The current metadata-only grant is NOT consent to files, even if active.
      reject(503, 'Unavailable'); return
    }
    if (p.role !== 'sub') { reject(404, 'Unavailable'); return }
    const repo = privateCertificateRepository(pool, p.subject)
    let allowed = false
    try { allowed = await repo.authorized(certificateId) } catch { reject(503, 'Unavailable'); return }
    if (!allowed) { reject(404, 'Unavailable'); return }
    if (action === 'upload') {
      const mime = req.headers['content-type']
      const len = req.headers['content-length']
      if (typeof mime !== 'string' || !types.has(mime) || (len !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(len) || Number(len) > MAX_CERTIFICATE_BYTES))) {
        res.set('Connection', 'close').status(400).json({ error: 'Invalid request' }); return
      }
      // Only raw bytes; no JSON, multipart fields, object key, or filename inputs.
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        res.set('Connection', 'close').status(400).json({ error: 'Invalid request' }); return
      }
    }
    const controller = new AbortController()
    let source: PassThrough | undefined
    let output: NodeJS.ReadableStream & { destroy: () => void } | undefined
    const cancel = () => { controller.abort(); source?.destroy(); output?.destroy() }
    const onClose = () => { if (!res.writableFinished) cancel() }
    req.once('aborted', cancel)
    res.once('close', onClose)
    if (req.aborted || res.destroyed) cancel()
    try {
      if (controller.signal.aborted) return
      const principal = { kind: 'member' as const, userId: p.subject }
      const storage = makeStorage({ records: repo.records, authorize: async ({ principal: actor, certificateId: target }) => actor.userId === p.subject && await repo.authorized(target) })
      if (action === 'upload') {
        source = new PassThrough()
        // Avoid process-level unhandled errors if the client disconnects during authorization.
        source.on('error', () => {})
        const upload = storage.upload({ principal, certificateId, stream: source, declaredMime: req.headers['content-type']!, signal: controller.signal })
        req.pipe(source)
        const result = await upload
        if (!controller.signal.aborted && !res.destroyed) res.status(201).json(result)
      } else {
        const result = await storage.download({ principal, certificateId, signal: controller.signal })
        output = result.stream
        if (controller.signal.aborted || res.destroyed) { result.stream.destroy(); return }
        res.set(result.headers)
        // pipeline destroys the HTTP response on stream failure, including truncated bodies.
        pipeline(result.stream, res, () => {})
        return
      }
    } catch (error) {
      req.unpipe(source)
      source?.destroy()
      if (controller.signal.aborted || res.destroyed) return
      if (action === 'upload') res.set('Connection', 'close')
      if (error instanceof CertificateInputError) res.status(400).json({ error: 'Invalid request' })
      else if (error instanceof CertificateAccessDeniedError) res.status(404).json({ error: 'Unavailable' })
      else res.status(503).json({ error: 'Unavailable' })
    } finally {
      req.removeListener('aborted', cancel)
      // For a piped download, retain cancellation until the response closes.
      if (!output) res.removeListener('close', onClose)
    }
  }
  router.put('/:certificateId', handler('upload'))
  router.get('/:certificateId', handler('download'))
  return router
}
