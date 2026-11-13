import express from 'express'; const Router = express.Router
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { dbGet, dbRun } from '../db/db.ts'
import { requireAuth } from '../middleware/auth.ts'; import type { AuthRequest } from '../middleware/auth.ts'

import { requireCurrentGC } from './projects.ts'
export const settingsRouter = Router()
settingsRouter.use(requireAuth, requireCurrentGC)

settingsRouter.get('/', async (req: AuthRequest, res) => {
  try {
    let s = await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [req.user!.id])
    if (!s) {
      const id = uuidv4()
      const u = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [req.user!.id])
      const initialName = u?.company_name || u?.name || null
      await dbRun(
        `INSERT INTO gc_settings (id, user_id, company_name, expiration_warning_days, updated_at)
         VALUES (?, ?, ?, 30, ?)`,
        [id, req.user!.id, initialName, new Date().toISOString()]
      )
      s = await dbGet('SELECT * FROM gc_settings WHERE id = ? AND user_id = ?', [id, req.user!.id])
    }
    const u = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [req.user!.id])
    if (!s.company_name) s.company_name = u?.company_name || u?.name || null
    res.json({ settings: s })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.put('/', async (req: AuthRequest, res) => {
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

    const existing = await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [req.user!.id])
    const now = new Date().toISOString()
    if (!existing) {
      const id = uuidv4()
      await dbRun(
        `INSERT INTO gc_settings (id, user_id, company_name, license_number, address, phone, email, logo_url, additional_insured_wording, required_gl_limit, required_auto_limit, required_wc_limit, required_umbrella_limit, expiration_warning_days, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user!.id, company_name || null, license_number || null, address || null, phone || null, email || null, logo_url || null, additional_insured_wording || null, required_gl_limit || null, required_auto_limit || null, required_wc_limit || null, required_umbrella_limit || null, expiration_warning_days ?? 30, now]
      )
    } else {
      await dbRun(
        `UPDATE gc_settings
         SET company_name = ?, license_number = ?, address = ?, phone = ?, email = ?, logo_url = ?, additional_insured_wording = ?, required_gl_limit = ?, required_auto_limit = ?, required_wc_limit = ?, required_umbrella_limit = ?, expiration_warning_days = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
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
          req.user!.id,
        ]
      )
    }
    const updated = await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [req.user!.id])
    res.json({ settings: updated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Subcontractor onboarding QR invite endpoints
settingsRouter.get('/qr-invite', async (req: AuthRequest, res) => {
  try {
    let s = await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [req.user!.id])
    if (!s) return res.status(404).json({ error: 'Company settings not found' })
    if (!/^join-[0-9a-f]{36}$/.test(s.invite_code || '')) {
      const code = 'join-' + crypto.randomBytes(18).toString('hex')
      await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ? AND user_id = ? AND (invite_code IS NULL OR invite_code = ?)', [code, s.id, req.user!.id, s.invite_code ?? null])
      s = await dbGet('SELECT * FROM gc_settings WHERE id = ? AND user_id = ?', [s.id, req.user!.id])
      if (!s) return res.status(404).json({ error: 'Company settings not found' })
    }
    const origin = process.env.CLIENT_URL || 'https://safecoi.com'
    const u = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [req.user!.id])
    const cname = s.company_name || u?.company_name || u?.name || 'Your Company'
    res.json({
      invite_code: s.invite_code,
      invite_url: `${origin}/join/${s.invite_code}`,
      company_name: cname,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

settingsRouter.post('/qr-invite/regenerate', async (req: AuthRequest, res) => {
  try {
    const s = await dbGet('SELECT * FROM gc_settings WHERE user_id = ? ORDER BY updated_at DESC, id LIMIT 1', [req.user!.id])
    if (!s) return res.status(404).json({ error: 'Company settings not found' })
    const code = 'join-' + crypto.randomBytes(18).toString('hex')
    await dbRun('UPDATE gc_settings SET invite_code = ? WHERE id = ? AND user_id = ?', [code, s.id, req.user!.id])
    const origin = process.env.CLIENT_URL || 'https://safecoi.com'
    const u2 = await dbGet<any>('SELECT company_name, name FROM users WHERE id = ?', [req.user!.id])
    const cname2 = s.company_name || u2?.company_name || u2?.name || 'Your Company'
    res.json({
      invite_code: code,
      invite_url: `${origin}/join/${code}`,
      company_name: cname2,
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
