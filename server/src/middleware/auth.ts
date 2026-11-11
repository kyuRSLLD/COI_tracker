import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

// Staged invitation endpoints must not trust the development fallback, nor a
// key changed in the environment after this module captured its signing key.
export function stagedInvitationAuthConfigured(): boolean {
  return Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET === JWT_SECRET && JWT_SECRET !== 'dev-secret-change-in-production' && Buffer.byteLength(JWT_SECRET, 'utf8') >= 32)
}

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }
}

export function signToken(user: { id: string; email: string; role: string; name: string }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' })
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any
    req.user = { id: payload.id, email: payload.email, role: payload.role, name: payload.name, subcontractor_id: payload.subcontractor_id || null }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })
}
