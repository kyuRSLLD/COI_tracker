import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { dbGet } from '../db/db.ts'

const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-change-in-production')
if (!JWT_SECRET) throw new Error('JWT_SECRET must be configured in production')

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }
}

export function signToken(user: { id: string; email: string; role: string; name: string }): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' })
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any
    if (typeof payload.id !== 'string') throw new Error('Invalid subject')
    const user = await dbGet('SELECT id, email, role, name, subcontractor_id FROM users WHERE id = ?', [payload.id])
    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    req.user = { id: user.id, email: user.email, role: user.role, name: user.name, subcontractor_id: user.subcontractor_id || null }
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
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
