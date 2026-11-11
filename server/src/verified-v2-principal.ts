// Shared trusted adapter; this module creates no app or service.
import type { Request, RequestHandler } from 'express'
import type { V2AuthContext } from './v2/auth.ts'

const reject: RequestHandler = (_req, res) => { res.status(401).json({ error: 'Authentication required' }) }

/**
 * Adapts only freshly verified res.locals.authV2, never client fields. The
 * private WeakMap distinguishes our own pinned principal from any preexisting
 * property. Re-authentication is mandatory; a changed identity fails closed.
 */
export function createVerifiedPrincipalAdapter(requireAuth: RequestHandler): RequestHandler {
  const pinned = new WeakMap<Request, Readonly<V2AuthContext>>()
  return (req, res, next) => {
    let advanced = false
    const done = (err?: unknown) => {
      if (advanced) return
      advanced = true
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (err === 'route' || err === 'router') return reject(req, res, next)
      if (err || res.statusCode >= 400) { if (err) return next(err); return reject(req, res, next) }
      const a = res.locals.authV2 as V2AuthContext | undefined
      if (!a || typeof a.subject !== 'string' || !a.subject || !['gc', 'sub', 'admin'].includes(a.role) || typeof a.credential !== 'string' || !a.credential) return reject(req, res, next)
      const old = pinned.get(req)
      const desc = Object.getOwnPropertyDescriptor(req, 'securePrincipal')
      if (old) {
        if (!desc || desc.value !== old || desc.configurable || desc.writable || old.subject !== a.subject || old.role !== a.role || old.credential !== a.credential) return reject(req, res, next)
      } else {
        // Refuse inherited, accessor, configurable, or frozen foreign values.
        if ('securePrincipal' in req) return reject(req, res, next)
        const value = Object.freeze({ subject: a.subject, role: a.role, credential: a.credential })
        Object.defineProperty(req, 'securePrincipal', { value, writable: false, configurable: false, enumerable: false })
        pinned.set(req, value)
      }
      next()
    }
    try { Promise.resolve(requireAuth(req, res, done)).catch(done) } catch (e) { done(e) }
  }
}
