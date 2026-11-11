import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { dbGet } from '../db/db.ts'
import { initAdminMfa, validateAdminSession } from '../services/adminMfa.ts'

// Missing development configuration uses a process-local ephemeral key, never a
// known shared fallback. Configure a stable key to keep development sessions.
const ephemeralKey = randomBytes(32).toString('hex')
function jwtKey(): string {
  const value = process.env.JWT_SECRET || ''
  if (process.env.NODE_ENV === 'production') {
    const raw = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex')
      : /^[A-Za-z0-9+/_-]{43}=?$/.test(value) ? Buffer.from(value, 'base64') : Buffer.alloc(0)
    if (raw.length !== 32 || new Set(raw).size < 16) throw new Error('Authentication unavailable: invalid JWT_SECRET')
  }
  return value || ephemeralKey
}
// Importing this module is part of application startup; prevent other legacy
// token routes from running with an absent/weak key in production.
if (process.env.NODE_ENV === 'production') jwtKey()

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }
  authToken?: string
  authExpiresAt?: number
  adminSessionId?: string
}

type TokenUser = { id: string; email: string; role: string; name: string; subcontractor_id?: string | null }

export function ensureAdminJwtKey(): void {
  jwtKey()
}

// A plain password or another sign-in route can never mint an admin session.
export function signToken(user: TokenUser): string {
  if (user.role === 'admin') throw new Error('Admin MFA required')
  return jwt.sign({ ...user, purpose: 'access' }, jwtKey(), { algorithm: 'HS256', expiresIn: '30d', jwtid: randomUUID() })
}

export function signAdminToken(user: TokenUser, sessionId: string, expiresIn: number): string {
  ensureAdminJwtKey()
  if (user.role !== 'admin') throw new Error('Admin authentication unavailable')
  return jwt.sign({ ...user, purpose: 'admin_mfa_session', mfa_session_id: sessionId }, jwtKey(), { algorithm: 'HS256', expiresIn })
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  let key: string
  try { key = jwtKey() } catch { res.status(503).json({ error: 'Authentication temporarily unavailable' }); return }
  let payload: any
  try {
    payload = jwt.verify(header.slice(7), key, { algorithms: ['HS256'] })
    if (!payload || typeof payload.id !== 'string' || !['access', 'admin_mfa_session', undefined].includes(payload.purpose)) throw new Error('Invalid')
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }
  try {
    await initAdminMfa()
    const token = header.slice(7)
    const revoked = await dbGet('SELECT token_hash FROM auth_revoked_tokens WHERE token_hash = ?', [createHash('sha256').update(token).digest('hex')])
    if (revoked) { res.status(401).json({ error: 'Invalid or expired token' }); return }
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
    req.authToken = token
    req.authExpiresAt = payload.exp
    if (user.role === 'admin') req.adminSessionId = payload.mfa_session_id
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
