import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { dbGet } from '../db/db.ts'
import { validateAdminSession } from '../services/adminMfa.ts'

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production'

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }
}

type TokenUser = { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }

export function ensureAdminJwtKey(): void {
  if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === 'dev-secret-change-in-production')) {
    throw new Error('Admin authentication unavailable')
  }
}

// A plain password or another sign-in route can never mint an admin session.
export function signToken(user: TokenUser): string {
  if (user.role === 'admin') throw new Error('Admin MFA required')
  return jwt.sign({ ...user, purpose: 'access' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '30d' })
}

export function signAdminToken(user: TokenUser, sessionId: string, expiresIn: number): string {
  ensureAdminJwtKey()
  if (user.role !== 'admin') throw new Error('Admin authentication unavailable')
  return jwt.sign({ ...user, purpose: 'admin_mfa_session', mfa_session_id: sessionId }, JWT_SECRET, { algorithm: 'HS256', expiresIn })
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  let payload: any
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] })
    if (!payload || typeof payload.id !== 'string' || !['access', 'admin_mfa_session', undefined].includes(payload.purpose)) throw new Error('Invalid')
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }
  try {
    const user = await dbGet<any>('SELECT id, email, role, name, subcontractor_id, password_hash FROM users WHERE id = ?', [payload.id])
    // Reject rather than promote/demote an old token when its role has changed.
    if (!user || user.role !== payload.role) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    if (user.role === 'admin') {
      ensureAdminJwtKey()
      if (payload.purpose !== 'admin_mfa_session' || !(await validateAdminSession(user, payload.mfa_session_id))) {
        res.status(401).json({ error: 'Invalid or expired token' })
        return
      }
    } else if (payload.purpose === 'admin_mfa_session') {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    req.user = { id: user.id, email: user.email, role: user.role, name: user.name, subcontractor_id: user.subcontractor_id || null }
    next()
  } catch {
    res.status(503).json({ error: 'Authentication temporarily unavailable' })
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  void requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })
}
