import express from 'express'
const Router = express.Router
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun, dbAll } from '../db/db.ts'
import { signToken, requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const authRouter = Router()

// Normalizes any raw phone into (xxx) xxx-xxxx. Falls back to trimmed raw for non-US formats.
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null
  const d = String(raw).replace(/\D/g, '')
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return String(raw).trim() || null
}

authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name, first_name, last_name, phone, company_name, role } = req.body || {}
    if (role !== undefined && role !== 'gc' && role !== 'sub') {
      return res.status(400).json({ error: 'Public registration is only available for general contractors and subcontractors. Existing administrators should sign in.' })
    }
    const fn = (first_name || '').trim()
    const ln = (last_name || '').trim()
    const fullName = [fn, ln].filter(Boolean).join(' ') || (name || '').trim()
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    // New registrations require first name, last name, and phone; legacy single "name" still accepted
    if (!fullName) {
      return res.status(400).json({ error: 'First name, last name, and phone are required' })
    }
    if ((fn || ln) && (!fn || !ln)) {
      return res.status(400).json({ error: 'First name, last name, and phone are required' })
    }
    const finalRole = role === 'sub' ? 'sub' : 'gc'
    const phoneFormatted = normalizePhone(phone)
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()])
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' })
    }
    const hash = await bcrypt.hash(password, 10)
    const id = uuidv4()
    let subId: string | null = null
    if (finalRole === 'sub') {
      subId = uuidv4()
      const now = new Date().toISOString()
      await dbRun(
        `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, phone, email, created_at, updated_at)
         VALUES (?, ?, ?, 'Trade to be specified', ?, ?, ?, ?, ?)`,
        [subId, id, company_name || fullName, fullName, phoneFormatted, email.toLowerCase(), now, now]
      )
    }
    await dbRun(
      `INSERT INTO users (id, email, password_hash, name, first_name, last_name, phone, company_name, role, created_at, subcontractor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, email.toLowerCase(), hash, fullName, fn || null, ln || null, phoneFormatted, company_name || null, finalRole, new Date().toISOString(), subId]
    )
    if (phone) {
      await dbRun(
        'INSERT INTO user_phones (id, user_id, phone, label, is_primary, created_at) VALUES (?, ?, ?, ?, 1, ?)',
        [uuidv4(), id, phoneFormatted || String(phone).trim(), 'mobile', new Date().toISOString()]
      )
    }
    const user = { id, email: email.toLowerCase(), name: fullName, first_name: fn || null, last_name: ln || null, phone: phoneFormatted, role: finalRole, subcontractor_id: subId }
    const token = signToken(user)
    res.json({ token, user })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()])
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    const ok = await bcrypt.compare(password, user.password_hash)
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    const payload = { id: user.id, email: user.email, role: user.role, name: user.name, subcontractor_id: user.subcontractor_id || null }
    const token = signToken(payload)
    res.json({ token, user: { ...payload, first_name: user.first_name || null, last_name: user.last_name || null, phone: user.phone || null, company_name: user.company_name } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.get('/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await dbGet('SELECT id, email, name, first_name, last_name, phone, company_name, role, created_at, subcontractor_id FROM users WHERE id = ?', [
      req.user!.id,
    ])
    if (!user) return res.status(404).json({ error: 'User not found' })
    const phones = await dbAll('SELECT id, phone, label, is_primary, created_at FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC', [req.user!.id])
    res.json({ user: { ...user, phones } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { current_password, new_password } = req.body || {}
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' })
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' })
    }
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user!.id])
    if (!user) return res.status(404).json({ error: 'User not found' })
    const ok = await bcrypt.compare(current_password, user.password_hash)
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' })
    const hash = await bcrypt.hash(new_password, 10)
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id])
    res.json({ success: true, message: 'Password updated successfully' })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Multi-phone numbers per user (email remains the unique identifier)
authRouter.get('/phones', requireAuth, async (req: AuthRequest, res) => {
  try {
    const phones = await dbAll(
      'SELECT id, phone, label, is_primary, created_at FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC',
      [req.user!.id]
    )
    res.json({ phones })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.post('/phones', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { phone, label, is_primary } = req.body || {}
    if (!phone || !String(phone).trim()) return res.status(400).json({ error: 'Phone is required' })
    const clean = normalizePhone(phone) || String(phone).trim()
    const id = uuidv4()
    const makePrimary = !!is_primary
    if (makePrimary) {
      await dbRun('UPDATE user_phones SET is_primary = 0 WHERE user_id = ?', [req.user!.id])
      await dbRun('UPDATE users SET phone = ? WHERE id = ?', [clean, req.user!.id])
    }
    await dbRun(
      'INSERT INTO user_phones (id, user_id, phone, label, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, req.user!.id, clean, label ? String(label).trim().slice(0, 30) : 'mobile', makePrimary ? 1 : 0, new Date().toISOString()]
    )
    const phones = await dbAll('SELECT id, phone, label, is_primary, created_at FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC', [req.user!.id])
    res.json({ phones })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.delete('/phones/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const target = await dbGet('SELECT * FROM user_phones WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id])
    if (!target) return res.status(404).json({ error: 'Phone not found' })
    await dbRun('DELETE FROM user_phones WHERE id = ?', [req.params.id])
    if (target.is_primary) {
      const next = await dbGet('SELECT * FROM user_phones WHERE user_id = ? ORDER BY created_at ASC LIMIT 1', [req.user!.id])
      if (next) {
        await dbRun('UPDATE user_phones SET is_primary = 1 WHERE id = ?', [next.id])
        await dbRun('UPDATE users SET phone = ? WHERE id = ?', [next.phone, req.user!.id])
      } else {
        await dbRun('UPDATE users SET phone = NULL WHERE id = ?', [req.user!.id])
      }
    }
    const phones = await dbAll('SELECT id, phone, label, is_primary, created_at FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC', [req.user!.id])
    res.json({ phones })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.patch('/phones/:id/primary', requireAuth, async (req: AuthRequest, res) => {
  try {
    const target = await dbGet('SELECT * FROM user_phones WHERE id = ? AND user_id = ?', [req.params.id, req.user!.id])
    if (!target) return res.status(404).json({ error: 'Phone not found' })
    await dbRun('UPDATE user_phones SET is_primary = 0 WHERE user_id = ?', [req.user!.id])
    await dbRun('UPDATE user_phones SET is_primary = 1 WHERE id = ?', [req.params.id])
    await dbRun('UPDATE users SET phone = ? WHERE id = ?', [target.phone, req.user!.id])
    const phones = await dbAll('SELECT id, phone, label, is_primary, created_at FROM user_phones WHERE user_id = ? ORDER BY is_primary DESC, created_at ASC', [req.user!.id])
    res.json({ phones })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
