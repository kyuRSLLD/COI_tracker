import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import { dbGet, dbRun } from '../db/db.ts'
import { requireAuth } from '../middleware/auth.ts'; import type { AuthRequest } from '../middleware/auth.ts'

export const settingsRouter = Router()

settingsRouter.get('/', requireAuth, async (_req, res) => {
  try {
    let s = await dbGet('SELECT * FROM gc_settings LIMIT 1')
    if (!s) {
      const id = uuidv4()
      await dbRun(
        `INSERT INTO gc_settings (id, company_name, expiration_warning_days, updated_at)
         VALUES (?, 'Your Company', 30, ?)`,
        [id, new Date().toISOString()]
      )
      s = await dbGet('SELECT * FROM gc_settings WHERE id = ?', [id])
    }
    res.json({ settings: s })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.put('/', requireAuth, async (req, res) => {
  try {
    const {
      company_name,
      license_number,
      address,
      phone,
      email,
      logo_url,
      additional_insured_wording,
      required_gl_limit,
      required_auto_limit,
      required_wc_limit,
      required_umbrella_limit,
      expiration_warning_days,
    } = req.body || {}

    const existing = await dbGet('SELECT * FROM gc_settings LIMIT 1')
    const now = new Date().toISOString()
    if (!existing) {
      const id = uuidv4()
      await dbRun(
        `INSERT INTO gc_settings (id, company_name, license_number, address, phone, email, logo_url, additional_insured_wording, required_gl_limit, required_auto_limit, required_wc_limit, required_umbrella_limit, expiration_warning_days, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, company_name || null, license_number || null, address || null, phone || null, email || null, logo_url || null, additional_insured_wording || null, required_gl_limit || null, required_auto_limit || null, required_wc_limit || null, required_umbrella_limit || null, expiration_warning_days ?? 30, now]
      )
    } else {
      await dbRun(
        `UPDATE gc_settings
         SET company_name = ?, license_number = ?, address = ?, phone = ?, email = ?, logo_url = ?, additional_insured_wording = ?, required_gl_limit = ?, required_auto_limit = ?, required_wc_limit = ?, required_umbrella_limit = ?, expiration_warning_days = ?, updated_at = ?
         WHERE id = ?`,
        [
          company_name ?? existing.company_name,
          license_number ?? existing.license_number,
          address ?? existing.address,
          phone ?? existing.phone,
          email ?? existing.email,
          logo_url ?? existing.logo_url,
          additional_insured_wording ?? existing.additional_insured_wording,
          required_gl_limit ?? existing.required_gl_limit,
          required_auto_limit ?? existing.required_auto_limit,
          required_wc_limit ?? existing.required_wc_limit,
          required_umbrella_limit ?? existing.required_umbrella_limit,
          expiration_warning_days ?? existing.expiration_warning_days,
          now,
          existing.id,
        ]
      )
    }
    const updated = await dbGet('SELECT * FROM gc_settings LIMIT 1')
    res.json({ settings: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Subcontractor onboarding QR invite endpoints
settingsRouter.get('/qr-invite', requireAuth, async (req: AuthRequest, res) => {
  try {
    let s = await dbGet('SELECT * FROM gc_settings LIMIT 1')
    if (!s) return res.status(404).json({ error: 'Company settings not found' })
    if (!s.invite_code) {
      const code = 'join-' + uuidv4().slice(0, 6)
      await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ?', [code, s.id])
      s.invite_code = code
    }
    const origin = process.env.CLIENT_URL || 'https://safecoi.com'
    res.json({
      invite_code: s.invite_code,
      invite_url: `${origin}/join/${s.invite_code}`,
      company_name: s.company_name,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/qr-invite/regenerate', requireAuth, async (_req, res) => {
  try {
    const s = await dbGet('SELECT * FROM gc_settings LIMIT 1')
    if (!s) return res.status(404).json({ error: 'Company settings not found' })
    const code = 'join-' + uuidv4().slice(0, 6)
    await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ?', [code, s.id])
    const origin = process.env.CLIENT_URL || 'https://safecoi.com'
    res.json({
      invite_code: code,
      invite_url: `${origin}/join/${code}`,
      company_name: s.company_name,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
