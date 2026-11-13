import { Button } from '../components/Button'
import { Link } from 'react-router-dom'
import { useState, useEffect, useRef } from 'react'
import {
  Save, Lock, Check, QrCode, Copy, RefreshCw, Printer, ExternalLink,
  Phone, Plus, Trash2, Star, Mail,
} from 'lucide-react'
import type { GCSettings, UserPhone } from '../types'
import { apiSettings, apiChangePassword, apiQrInvite, apiRegenerateQrInvite, apiPhones, apiMe, ApiError } from '../api'
import { formatPhone, isValidUsPhone, US_PHONE_PATTERN } from '../lib/formatPhone'
import { QRCodeSVG } from 'qrcode.react'

export function SettingsPage() {
  const [settings, setSettings] = useState<GCSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // password
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null)

  // QR onboarding
  const [qrInvite, setQrInvite] = useState<{ invite_code: string; invite_url: string; company_name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [regen, setRegen] = useState(false)

  // multi-phone numbers (email is the identifier)
  const [phones, setPhones] = useState<UserPhone[]>([])
  const [newPhone, setNewPhone] = useState('')
  const [newLabel, setNewLabel] = useState('mobile')
  const [newIsPrimary, setNewIsPrimary] = useState(false)
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [userEmail, setUserEmail] = useState('')
  const initialSettings = useRef<string | null>(null)

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  const loadAll = async () => {
    try {
      const [sr, qr, pr, me] = await Promise.all([
        apiSettings.get(),
        apiQrInvite(),
        apiPhones.list().catch(() => ({ phones: [] as UserPhone[] })),
        apiMe().catch(() => ({ user: { email: '' } as any })),
      ])
      setSettings(sr.settings)
      initialSettings.current = JSON.stringify(sr.settings)
      setQrInvite(qr)
      setPhones(pr.phones)
      setUserEmail(me.user.email)
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 403 || e.message?.includes('GC access required'))) {
        // no-op; handled by the guarded render below
      }
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { loadAll() }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    setSaving(true)
    try {
      const res = await apiSettings.update(settings)
      setSettings(res.settings)
      initialSettings.current = JSON.stringify(res.settings)
      showToast('Settings saved')
    } finally {
      setSaving(false)
    }
  }

  const isDirty = Boolean(initialSettings.current && settings && JSON.stringify(settings) !== initialSettings.current)
  const handleCopyLink = () => {
    if (!qrInvite) return
    navigator.clipboard?.writeText(qrInvite.invite_url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleRegenerate = async () => {
    if (!confirm('Regenerate the subcontractor onboarding QR code? The old code will stop working.')) return
    setRegen(true)
    try {
      const res = await apiRegenerateQrInvite()
      setQrInvite(res)
      showToast('New QR code generated')
    } finally {
      setRegen(false)
    }
  }

  const handlePrintFlyer = () => {
    if (!qrInvite) return
    const w = window.open('', '_blank', 'width=700,height=900')
    if (!w) return
    w.document.write(`<!doctype html><html><head><title>Subcontractor Onboarding — ${qrInvite.company_name}</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;padding:36px;color:#1e293b;max-width:540px;margin:auto}
      h1{font-size:26px;margin:0 0 6px}h2{font-size:15px;color:#475569;margin:0 0 24px;font-weight:400}
      .box{border:2px solid #0f172a;border-radius:18px;padding:30px;text-align:center}
      .qr{margin:18px auto;display:inline-block}ol{text-align:left;font-size:13px;line-height:1.7;margin:20px 0 0;padding-left:22px}
      .url{font-family:monospace;font-size:12px;background:#f1f5f9;padding:6px 10px;border-radius:8px;word-break:break-all;margin-top:14px;display:inline-block}
      @media print{button{display:none}}</style></head><body>
      <h1>${qrInvite.company_name}</h1>
      <h2>Subcontractor Insurance Onboarding</h2>
      <div class="box">
        <p style="font-size:14px;margin:0">Scan this QR code with your phone camera:</p>
        <div class="qr">${document.getElementById('qr-svg-container')?.innerHTML || ''}</div>
        <p class="url">${qrInvite.invite_url}</p>
        <ol>
          <li>Open the camera on your phone and scan the QR code (or type the link)</li>
          <li>Create a subcontractor account or sign in — <strong>free for subcontractors</strong></li>
          <li>Review the sharing terms and consent to connect</li>
          <li>Upload your ACORD certificate; ${qrInvite.company_name} can view your submission</li>
        </ol>
      </div>
      <p style="font-size:11px;color:#94a3b8;margin-top:18px;text-align:center">Powered by COI Shield · safecoi.com</p>
      <script>setTimeout(function(){window.print()},300)</script></body></html>`)
    w.document.close()
  }

  const handleAddPhone = async () => {
    if (!isValidUsPhone(newPhone)) {
      showToast('Please enter a complete 10-digit phone number')
      return
    }
    setPhoneSaving(true)
    try {
      const res = await apiPhones.add({ phone: newPhone.trim(), label: newLabel, is_primary: newIsPrimary || phones.length === 0 })
      setPhones(res.phones)
      setNewPhone('')
      setNewIsPrimary(false)
      showToast('Phone number added')
    } catch (err: any) {
      showToast(err.message)
    } finally {
      setPhoneSaving(false)
    }
  }
  const handleRemovePhone = async (id: string) => {
    try {
      const res = await apiPhones.remove(id)
      setPhones(res.phones)
      showToast('Phone number removed')
    } catch (err: any) {
      showToast(err.message)
    }
  }
  const handleMakePrimary = async (id: string) => {
    try {
      const res = await apiPhones.makePrimary(id)
      setPhones(res.phones)
      showToast('Primary phone updated')
    } catch (err: any) {
      showToast(err.message)
    }
  }
  if (loading) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-xs text-slate-400">Loading settings…</div>
  }
  if (!settings) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-sm text-slate-700">This account has no contractor workspace. Open Staff, or pick a company to view.</p>
        <Link to="/staff" className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-700 transition">
          Open Staff
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      <div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Profile</h1>
        <p className="text-xs text-slate-500 mt-1">
          Manage your company profile, password, and subcontractor onboarding.
        </p>
      </div>

      <form id="settings-form" onSubmit={handleSubmit} className="space-y-6 text-xs">
        {/* Company profile */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-sm font-bold text-slate-900">Company profile</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Company name</label>
              <input value={settings.company_name || ''} onChange={(e) => setSettings({ ...settings, company_name: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">GC license number</label>
              <input value={settings.license_number || ''} onChange={(e) => setSettings({ ...settings, license_number: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Business address</label>
            <input value={settings.address || ''} onChange={(e) => setSettings({ ...settings, address: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Office phone</label>
              <input type="tel" value={settings.phone || ''} onChange={(e) => setSettings({ ...settings, phone: formatPhone(e.target.value) })} placeholder="(312) 555-0100" pattern={US_PHONE_PATTERN} title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format" className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Compliance email</label>
              <input value={settings.email || ''} onChange={(e) => setSettings({ ...settings, email: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Logo URL (shown on client portals and the onboarding page)</label>
            <input value={settings.logo_url || ''} onChange={(e) => setSettings({ ...settings, logo_url: e.target.value })} placeholder="https://…" className="w-full px-3 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        {/* Account & phone numbers — email is the identifier, phones can be many */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-slate-800" />
            <h2 className="text-sm font-bold text-slate-900">Account identifier &amp; phone numbers</h2>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-1">
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Sign-in identifier (required)</div>
            <div className="font-mono text-slate-900 font-semibold">{userEmail || '—'}</div>
            <p className="text-[11px] text-slate-400">Your email is the unique identifier for your account. You can keep as many phone numbers on file as you need.</p>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Phone className="w-4 h-4 text-slate-800" />
              <h3 className="text-xs font-bold text-slate-900">Your phone numbers</h3>
            </div>
            {phones.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No phone numbers on file yet.</p>
            ) : (
              <div className="space-y-2">
                {phones.map((ph) => (
                  <div key={ph.id} className="flex items-center justify-between p-3 rounded-2xl border border-slate-200 text-xs">
                    <div className="flex items-center gap-3">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <div>
                        <div className="font-semibold text-slate-900 flex items-center gap-2">
                          {ph.phone}
                          {ph.is_primary ? (
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-bold">
                              <Star className="w-3 h-3 fill-amber-500 text-amber-500" /> primary
                            </span>
                          ) : null}
                        </div>
                        <div className="text-[11px] text-slate-400 capitalize">{ph.label || 'phone'}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!ph.is_primary && (
                        <button
                          type="button"
                          onClick={() => handleMakePrimary(ph.id)}
                          className="text-[11px] font-semibold text-slate-600 hover:text-slate-900 px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 transition"
                        >
                          Make primary
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemovePhone(ph.id)}
                        className="text-[11px] text-rose-600 hover:text-rose-800 px-2.5 py-1 rounded-lg border border-rose-200 hover:bg-rose-50 transition inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="grid sm:grid-cols-4 gap-2 pt-2 border-t border-slate-100 text-xs">
            <input
              type="tel"
              placeholder="(312) 555-0199"
              value={newPhone}
              onChange={(e) => setNewPhone(formatPhone(e.target.value))}
              pattern={US_PHONE_PATTERN}
              title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format"
              className="px-3 py-2 rounded-xl border border-slate-200"
            />
            <select
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-200 capitalize"
            >
              <option value="mobile">mobile</option>
              <option value="office">office</option>
              <option value="home">home</option>
              <option value="other">other</option>
            </select>
            <label className="flex items-center gap-2 text-slate-600 text-[11px] select-none">
              <input
                type="checkbox"
                checked={newIsPrimary}
                onChange={(e) => setNewIsPrimary(e.target.checked)}
              />
              Make primary
            </label>
            <button
              type="button"
              onClick={handleAddPhone}
              disabled={phoneSaving}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:opacity-40 transition"
            >
              <Plus className="w-3.5 h-3.5" /> {phoneSaving ? 'Adding…' : 'Add phone'}
            </button>
          </div>
        </div>
                {/* Subcontractor onboarding QR code */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-slate-800" />
            <h2 className="text-sm font-bold text-slate-900">Subcontractor onboarding QR code</h2>
          </div>
          <p className="text-xs text-slate-500">
            Share this QR code or link with subcontractors. They can sign up for free or sign in, then review and consent to sharing before connecting to your company.
          </p>

          {qrInvite && (
            <div className="grid md:grid-cols-2 gap-6 items-center">
              <div className="flex flex-col items-center text-center p-5 bg-slate-50 rounded-2xl border border-slate-200 min-w-0">
                <div id="qr-svg-container" className="max-w-full overflow-hidden p-3 bg-white rounded-xl shadow-xs border border-slate-200">
                  <QRCodeSVG value={qrInvite.invite_url} size={200} level="M" className="max-w-full h-auto" />
                </div>
                <p className="text-[11px] text-slate-400 mt-2 font-mono break-all">{qrInvite.invite_url}</p>
                <div className="flex flex-col gap-2 mt-3 w-full">
                  <Button
                    type="button"
                    variant="primary"
                    full
                    onClick={handleCopyLink}
                  >
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copied ? 'Copied' : 'Copy invite link'}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    full
                    onClick={handlePrintFlyer}
                  >
                    <Printer className="w-4 h-4" /> Print job-site flyer
                  </Button>
                  <a
                    href={qrInvite.invite_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-100 transition"
                  >
                    Open page <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              <div className="space-y-3 text-xs">
                <div className="rounded-xl border border-slate-200 p-3 bg-slate-50 text-xs">
                  <p className="text-[11px] text-slate-400 font-semibold uppercase tracking-wide">How it works</p>
                  <ol className="list-decimal list-inside text-slate-600 mt-1.5 space-y-1 text-xs">
                    <li>Share the flyer or link with subcontractors.</li>
                    <li>They scan and sign in with a free account.</li>
                    <li>They review the sharing terms and consent to connect.</li>
                    <li>Their uploaded certificates are then visible to your company.</li>
                  </ol>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-[11px] text-slate-400 pt-2 border-t border-slate-100">
                  <span>Invite code: <code className="font-mono text-sm tracking-widest">{qrInvite.invite_code}</code></span>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={regen}
                    onClick={handleRegenerate}
                    full
                    className="sm:w-auto"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${regen ? 'animate-spin' : ''}`} /> Regenerate code
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Security: password */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-slate-800" />
            <h2 className="text-sm font-bold text-slate-900">Password</h2>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Current password</label>
              <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">New password (min 8 chars)</label>
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Confirm new password</label>
              <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
          </div>
          {pwMsg && (
            <p className={`text-xs ${pwMsg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{pwMsg.text}</p>
          )}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="primary"
              disabled={pwSaving}
              onClick={async () => {
                setPwMsg(null)
                if (!currentPw || !newPw || !confirmPw) return setPwMsg({ text: 'All password fields are required', ok: false })
                if (newPw.length < 8) return setPwMsg({ text: 'New password must be at least 8 characters', ok: false })
                if (newPw !== confirmPw) return setPwMsg({ text: 'New passwords do not match', ok: false })
                try {
                  setPwSaving(true)
                  const r = await apiChangePassword(currentPw, newPw)
                  setPwMsg({ text: r.message || 'Password updated', ok: true })
                  setCurrentPw(''); setNewPw(''); setConfirmPw('')
                } catch (err: any) {
                  setPwMsg({ text: err?.message || 'Update failed', ok: false })
                } finally {
                  setPwSaving(false)
                }
              }}
            >
              <Check className="w-4 h-4" /> {pwSaving ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </div>

        {/* The former demo controls did not enforce a second factor. */}


        {/* Insurance requirements */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-sm font-bold text-slate-900">Insurance requirements shown to subcontractors &amp; clients</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">General Liability</label>
              <input value={settings.required_gl_limit || ''} onChange={(e) => setSettings({ ...settings, required_gl_limit: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Automobile Liability</label>
              <input value={settings.required_auto_limit || ''} onChange={(e) => setSettings({ ...settings, required_auto_limit: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Workers' Compensation</label>
              <input value={settings.required_wc_limit || ''} onChange={(e) => setSettings({ ...settings, required_wc_limit: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Umbrella / Excess</label>
              <input value={settings.required_umbrella_limit || ''} onChange={(e) => setSettings({ ...settings, required_umbrella_limit: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Required additional-insured endorsement wording</label>
            <textarea rows={3} value={settings.additional_insured_wording || ''} onChange={(e) => setSettings({ ...settings, additional_insured_wording: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-sm font-bold text-slate-900">Notifications</h2>
          <div className="max-w-xs">
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Expiration warning window (days)</label>
            <input type="number" min={7} max={90} value={settings.expiration_warning_days ?? 30} onChange={(e) => setSettings({ ...settings, expiration_warning_days: Number(e.target.value) })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save all settings'}
          </Button>
        </div>
      </form>
      {isDirty && (
        <div className="sm:hidden fixed inset-x-0 bottom-0 z-40 p-3 bg-white/95 backdrop-blur-sm border-t border-slate-200 shadow-xl">
          <Button type="submit" form="settings-form" variant="primary" full disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save all settings'}
          </Button>
        </div>
      )}
    </div>
  )
}
