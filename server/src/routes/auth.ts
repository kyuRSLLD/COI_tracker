import express from 'express'
const Router = express.Router
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun } from '../db/db.ts'
import { signToken, requireAuth } from '../middleware/auth.ts'
import type { AuthRequest } from '../middleware/auth.ts'

export const authRouter = Router()

authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, name, company_name, role } = req.body || {}
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' })
    }
    const finalRole = role === 'sub' ? 'sub' : 'gc'
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
        `INSERT INTO subcontractors (id, user_id, company_name, trade, contact_person, email, created_at, updated_at)
         VALUES (?, ?, ?, 'Trade to be specified', ?, ?, ?, ?)`,
        [subId, id, company_name || name, name, email.toLowerCase(), now, now]
      )
    }
    await dbRun(
      `INSERT INTO users (id, email, password_hash, name, company_name, role, created_at, subcontractor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, email.toLowerCase(), hash, name, company_name || null, finalRole, new Date().toISOString(), subId]
    )
    const user = { id, email: email.toLowerCase(), name, role: finalRole, subcontractor_id: subId }
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
    res.json({ token, user: { ...payload, company_name: user.company_name } })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

authRouter.get('/me', requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = await dbGet('SELECT id, email, name, company_name, role, created_at, subcontractor_id FROM users WHERE id = ?', [
      req.user!.id,
    ])
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ user })
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
