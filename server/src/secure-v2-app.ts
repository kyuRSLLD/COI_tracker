import express from 'express'
import type { ErrorRequestHandler, RequestHandler, Router } from 'express'

/**
 * These dependencies are trusted application components, not sandboxed plugins.
 * The authenticator must verify credentials and call next() only on success.
 */
export interface SecureV2Dependencies {
  authRouter?: Router
  gcRouter?: Router
  connectionsRouter?: Router
  certificatesRouter?: Router
  authenticate?: RequestHandler
  // Only when trusted routers own bounded parsing; binary streams stay raw.
  routersOwnBodyParsing?: boolean
  beforeProtected?: RequestHandler
}

const JSON_LIMIT = '64kb'
const unavailable: RequestHandler = (_req, res) => {
  res.status(503).json({ error: 'Service unavailable' })
}
const unauthorized: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'Authentication required' })
}
const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Not found' })
}

/** A fresh app with no database initialization, listeners, legacy or static routes. */
export function createSecureV2App(deps: SecureV2Dependencies = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.disable('etag')
  app.enable('case sensitive routing')
  app.enable('strict routing')

  // First for every response, including denials and parser errors. No CORS policy
  // is installed here: any cross-origin integration needs explicit review.
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    })
    next()
  })

  // Deny before parsing bodies, authenticating, or invoking any injected router.
  // Reject encoded paths, backslashes and dot/double-slash segments to avoid
  // differing proxy/router interpretations of a path at this security boundary.
  app.use((req, res, next) => {
    const path = req.path
    if (path.includes('%') || path.includes('\\') || /[\x00-\x20\x7f]/.test(path) ||
        path.includes('//') || path.split('/').some(segment => segment === '.' || segment === '..')) {
      return notFound(req, res, next)
    }
    const allowed = ['/api/v2/auth', '/api/v2/gc', '/api/v2/connections', '/api/v2/certificates']
    if (!allowed.some(base => path === base || path.startsWith(`${base}/`))) {
      return notFound(req, res, next)
    }
    next()
  })

  const json: RequestHandler = deps.routersOwnBodyParsing ? (_req, _res, next) => next() : express.json({ limit: JSON_LIMIT, strict: true })
  // The auth router is the only public surface. It must itself implement only
  // reviewed public authentication endpoints (and enforce its own rate limits).
  app.use('/api/v2/auth', json, deps.authRouter ?? unavailable)

  const authenticate: RequestHandler = (req, res, next) => {
    if (!deps.authenticate) return unavailable(req, res, next)
    // Reject ambiguous duplicate Authorization fields as well as malformed
    // bearer syntax before the authenticator or a private router sees them.
    const authHeaderCount = req.rawHeaders.filter((_value, index) =>
      index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length
    const header = req.headers.authorization
    if (authHeaderCount !== 1 || !header || header.length > 4096 ||
        !/^Bearer [A-Za-z0-9\-._~+/]+=*$/i.test(header)) {
      return unauthorized(req, res, next)
    }

    let advanced = false
    const guardedNext: typeof next = (error?: unknown) => {
      if (advanced) return
      advanced = true
      // Do not enter a private router after a response/denial, even if an
      // authenticator accidentally calls next() after sending its response.
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (res.statusCode >= 400 && !error) return unauthorized(req, res, next)
      // Express control-flow sentinels must never skip authentication.
      if (error === 'route' || error === 'router') return unauthorized(req, res, next)
      if (error) return next(error)
      next()
    }
    try {
      // Express 4 does not handle rejected promises by itself.
      const result = deps.authenticate(req, res, guardedNext)
      Promise.resolve(result).catch((error: unknown) => {
        if (!advanced) guardedNext(error || new Error('Authentication failed'))
        else if (!res.writableEnded) next(error || new Error('Authentication failed'))
      })
    } catch (error) {
      if (!advanced) guardedNext(error || new Error('Authentication failed'))
      else if (!res.writableEnded) next(error || new Error('Authentication failed'))
    }
  }

  // Authentication precedes body parsing and each private router (including the
  // optional certificates router); absence never falls through to another app.
  const beforeProtected: RequestHandler = deps.beforeProtected ?? ((_req, _res, next) => next())
  app.use('/api/v2/gc', beforeProtected, authenticate, json, deps.gcRouter ?? unavailable)
  app.use('/api/v2/connections', beforeProtected, authenticate, json, deps.connectionsRouter ?? unavailable)
  app.use('/api/v2/certificates', beforeProtected, authenticate, json, deps.certificatesRouter ?? unavailable)

  app.use(notFound)
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    // A response already started by a trusted injected handler cannot be
    // retracted; terminate rather than expose an error or invoke finalhandler.
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request too large' })
    } else if (err?.type === 'entity.parse.failed' || err?.type === 'request.aborted' || err?.type === 'request.size.invalid') {
      res.status(400).json({ error: 'Bad request' })
    } else if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      res.status(415).json({ error: 'Unsupported request' })
    } else {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
  app.use(errors)
  return app
}
