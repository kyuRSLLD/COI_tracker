import type { Request } from 'express'

const LOGIN_FAILURE_LIMIT = 10
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT_MAX_ENTRIES = 10_000

type RateLimitEntry = { count: number; windowStartedAt: number }
const loginAttempts = new Map<string, RateLimitEntry>()

// Use Express's resolved address, not the untrusted X-Forwarded-For header.
export function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

export function normalizeLoginEmail(email: unknown): string {
  return String(email).trim().toLowerCase()
}

function loginKey(req: Request, normalizedEmail: string): string {
  return `${requestIp(req)}\u0000${normalizedEmail}`
}

// Reserve an attempt before awaiting password verification. This also counts
// in-flight requests, preventing parallel guesses from bypassing the limit.
// A verified password clears the reservation and all earlier failures.
export function consumeLoginAttempt(req: Request, normalizedEmail: string): boolean {
  const now = Date.now()
  for (const [key, entry] of loginAttempts) {
    if (now - entry.windowStartedAt >= LOGIN_FAILURE_WINDOW_MS) loginAttempts.delete(key)
  }
  const key = loginKey(req, normalizedEmail)
  const current = loginAttempts.get(key)
  if (current) {
    if (current.count >= LOGIN_FAILURE_LIMIT) return false
    current.count += 1
    return true
  }
  while (loginAttempts.size >= RATE_LIMIT_MAX_ENTRIES) {
    const oldestKey = loginAttempts.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    loginAttempts.delete(oldestKey)
  }
  loginAttempts.set(key, { count: 1, windowStartedAt: now })
  return true
}

export function clearLoginAttempts(req: Request, normalizedEmail: string): void {
  loginAttempts.delete(loginKey(req, normalizedEmail))
}
