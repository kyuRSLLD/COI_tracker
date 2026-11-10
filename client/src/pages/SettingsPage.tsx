import { useState, useEffect } from 'react'
import {
  Save, Lock, Check, QrCode, Copy, RefreshCw, Printer, ExternalLink,
  Smartphone, KeyRound, ShieldAlert, Sparkles, AlertTriangle, Download,
} from 'lucide-react'
import type { GCSettings } from '../types'
import { apiSettings, apiChangePassword, apiQrInvite, apiRegenerateQrInvite } from '../api'
import { QRCodeSVG } from 'qrcode.react'

const BACKUP_CODES = ['A3F9-K8X2', '7M1B-QQ40', 'Z9C2-T6L1', '5V0P-9Y7D', 'E8R4-N3W6', '2K7H-B1J5', 'F6S0-X4M9', 'U1A8-D5C3']

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

  // 2FA (simulated full setup)
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false)
  const [twoFactorMethod, setTwoFactorMethod] = useState<'app' | 'sms'>('app')
  const [smsPhone, setSmsPhone] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [show2faSetup, setShow2faSetup] = useState(false)
  const [tfaMsg, setTfaMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const tfaSecret = 'SAFECOI-K7B2-M9F1-Z4Q0'

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  const loadAll = async () => {
    try {
      const [sr, qr] = await Promise.all([apiSettings.get(), apiQrInvite()])
      setSettings(sr.settings)
      setQrInvite(qr)
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
      showToast('Settings saved')
    } finally {
      setSaving(false)
    }
  }

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
          <li>Create a free subcontractor account — <strong>free for your first month</strong></li>
          <li>Upload your ACORD certificate or connect your insurance carrier</li>
          <li>Your certificate is verified and linked to ${qrInvite.company_name} automatically</li>
        </ol>
      </div>
      <p style="font-size:11px;color:#94a3b8;margin-top:18px;text-align:center">Powered by COI Shield · safecoi.com</p>
      <script>setTimeout(function(){window.print()},300)</script></body></html>`)
    w.document.close()
  }

  const handleVerify2fa = () => {
    setTfaMsg(null)
    if (!verifyCode || verifyCode.trim().length < 6) {
      return setTfaMsg({ text: 'Enter the 6-digit verification code', ok: false })
    }
    setTwoFactorEnabled(true)
    setShow2faSetup(false)
    setVerifyCode('')
    setTfaMsg({ text: 'Two-method authentication is now enabled', ok: true })
    showToast('2FA enabled')
  }

  if (loading || !settings) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-xs text-slate-400">Loading settings…</div>
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      <div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Profile &amp; Settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          Your company profile, security (passwords &amp; two-method authentication), and subcontractor onboarding QR code — all in one place.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 text-xs">
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
              <input value={settings.phone || ''} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-600 mb-1">Compliance email (used for reminders &amp; invites)</label>
              <input value={settings.email || ''} onChange={(e) => setSettings({ ...settings, email: e.target.value })} className="w-full px-3 py-2 rounded-xl border border-slate-200" />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-slate-600 mb-1">Logo URL (shown on client portals and the onboarding page)</label>
            <input value={settings.logo_url || ''} onChange={(e) => setSettings({ ...settings, logo_url: e.target.value })} placeholder="https://…" className="w-full px-3 py-2 rounded-xl border border-slate-200" />
          </div>
        </div>

        {/* Subcontractor onboarding QR code */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-slate-800" />
            <h2 className="text-sm font-bold text-slate-900">Subcontractor onboarding QR code</h2>
          </div>
          <p className="text-xs text-slate-500">
            Share this QR code or link with subcontractors. Scanning it lets them sign up (or connect an existing account) directly to your company — no manual invites needed.
          </p>

          {qrInvite && (
            <div className="grid md:grid-cols-2 gap-6 items-center">
              <div className="flex flex-col items-center text-center p-5 bg-slate-50 rounded-2xl border border-slate-200">
                <div id="qr-svg-container" className="p-3 bg-white rounded-xl shadow-xs border border-slate-200">
                  <QRCodeSVG value={qrInvite.invite_url} size={200} level="M" />
                </div>
                <p className="text-[11px] text-slate-400 mt-2 font-mono">{qrInvite.invite_url}</p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-semibold flex items-center gap-1 hover:bg-slate-800"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy invite link'}
                  </button>
                  <button
                    type="button"
                    onClick={handlePrintFlyer}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 font-semibold hover:bg-slate-50 flex items-center gap-1"
                  >
                    <Printer className="w-3.5 h-3.5" /> Print job-site flyer
                  </button>
                  <a
                    href={qrInvite.invite_url}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 rounded-lg border border-slate-200 font-semibold hover:bg-slate-50 flex items-center gap-1"
                  >
                    Open page <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>

              <div className="space-y-3 text-xs">
                <div className="rounded-xl border border-slate-200 p-3 bg-slate-50">
                  <p className="text-[11px] text-slate-400">How it works</p>
                  <ol className="list-decimal list-inside text-slate-600 mt-1 space-y-1 text-[11px]">
                    <li>Print the flyer and post it in your job-site trailer or text the link.</li>
                    <li>Subcontractors scan, create a free account (first month free), and are linked instantly.</li>
                    <li>Subs who already have a COI Shield account can connect it with one tap.</li>
                    <li>Their COI lands in your review queue — verified in minutes.</li>
                  </ol>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-100">
                  <span>Invite code: <code className="font-mono">{qrInvite.invite_code}</code></span>
                  <button
                    type="button"
                    disabled={regen}
                    onClick={handleRegenerate}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${regen ? 'animate-spin' : ''}`} /> Regenerate code
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Security: password */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-slate-800" />
            <h2 className="text-sm font-bold text-slate-900">Security — password</h2>
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
            <button
              type="button"
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
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 transition shadow-sm"
            >
              <Check className="w-4 h-4" /> {pwSaving ? 'Updating…' : 'Update password'}
            </button>
          </div>
        </div>

        {/* Security: two-method authentication */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-800" />
              <h2 className="text-sm font-bold text-slate-900">Two-method authentication (2FA)</h2>
            </div>
            <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${
              twoFactorEnabled
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-slate-100 text-slate-600 border-slate-200'
            }`}>
              {twoFactorEnabled ? 'Enabled' : 'Not enabled'}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Add a second sign-in step to protect compliance records and client portals from takeover.
          </p>

          {!twoFactorEnabled && !show2faSetup && (
            <button
              type="button"
              onClick={() => setShow2faSetup(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition"
            >
              <Smartphone className="w-4 h-4" /> Set up two-method authentication
            </button>
          )}

          {show2faSetup && !twoFactorEnabled && (
            <div className="space-y-4 rounded-2xl border border-slate-200 p-5 bg-slate-50">
              <div className="flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setTwoFactorMethod('app')}
                  className={`px-3 py-1.5 rounded-lg font-semibold border ${
                    twoFactorMethod === 'app'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200'
                  }`}
                >
                  Authenticator app (recommended)
                </button>
                <button
                  type="button"
                  onClick={() => setTwoFactorMethod('sms')}
                  className={`px-3 py-1.5 rounded-lg font-semibold border ${
                    twoFactorMethod === 'sms'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200'
                  }`}
                >
                  SMS code
                </button>
              </div>

              {twoFactorMethod === 'app' ? (
                <div className="grid md:grid-cols-2 gap-4 items-center">
                  <div className="text-center p-3 bg-white rounded-xl border border-slate-200">
                    <div className="inline-block p-2 bg-white rounded-lg">
                      <QRCodeSVG value={`otpauth://totp/COIShield:${settings.email || 'user'}?secret=${tfaSecret}&issuer=COI%20Shield`} size={170} level="M" />
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1">Scan with Google Authenticator, 1Password, or Authy</p>
                  </div>
                  <div className="space-y-2 text-xs">
                    <p className="text-slate-600">Can't scan? Enter the setup key manually:</p>
                    <div className="flex items-center gap-2">
                      <code className="px-2.5 py-1 rounded bg-white border border-slate-200 font-mono text-[11px] text-slate-700 select-all">
                        {tfaSecret}
                      </code>
                      <button
                        type="button"
                        onClick={() => { navigator.clipboard?.writeText(tfaSecret); showToast('Secret copied') }}
                        className="px-2 py-1 rounded border border-slate-200 hover:bg-white text-[11px]"
                      >
                        Copy
                      </button>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Enter the 6-digit code shown in your app
                      </label>
                      <input
                        type="text"
                        maxLength={6}
                        value={verifyCode}
                        onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                        placeholder="123456"
                        className="w-40 tracking-widest text-center text-sm font-mono px-3 py-1.5 rounded-lg border border-slate-200 bg-white"
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Mobile phone for SMS codes</label>
                    <input
                      type="tel"
                      value={smsPhone}
                      onChange={(e) => setSmsPhone(e.target.value)}
                      placeholder="(312) 555-0100"
                      className="w-60 px-3 py-1.5 rounded-lg border border-slate-200 bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">Enter the 6-digit test code (use any 6 digits for the demo)</label>
                    <input
                      type="text"
                      maxLength={6}
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      className="w-40 tracking-widest text-center text-sm font-mono px-3 py-1.5 rounded-lg border border-slate-200 bg-white"
                    />
                  </div>
                </div>
              )}

              {tfaMsg && <p className={`text-xs ${tfaMsg.ok ? 'text-emerald-600' : 'text-rose-600'}`}>{tfaMsg.text}</p>}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleVerify2fa}
                  className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition"
                >
                  Verify and enable
                </button>
                <button
                  type="button"
                  onClick={() => setShow2faSetup(false)}
                  className="px-3 py-2 rounded-xl text-xs text-slate-500 hover:bg-slate-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {twoFactorEnabled && (
            <div className="space-y-3 rounded-2xl border border-emerald-200 p-5 bg-emerald-50/50 text-xs">
              <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                <Check className="w-4 h-4" /> Two-method authentication is active
              </div>
              <p className="text-emerald-900/80">
                You'll be asked for a one-time code each time you sign in. Save these backup codes somewhere safe — each can be used once if you lose access to your authenticator:
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] text-slate-700">
                {BACKUP_CODES.map((c) => (
                  <span key={c} className="px-2 py-1 rounded bg-white border border-emerald-200 text-center select-all">{c}</span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([BACKUP_CODES.join('\n')], { type: 'text/plain' })
                    const u = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = u
                    a.download = 'coi-shield-backup-codes.txt'
                    a.click()
                    URL.revokeObjectURL(u)
                  }}
                  className="px-3 py-1.5 rounded-lg border border-emerald-300 font-semibold text-emerald-900 bg-white hover:bg-emerald-100 flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" /> Download backup codes
                </button>
                <button
                  type="button"
                  onClick={() => { setTwoFactorEnabled(false); showToast('2FA disabled') }}
                  className="px-3 py-1.5 rounded-lg text-rose-700 hover:bg-rose-50 font-semibold"
                >
                  Disable two-method authentication
                </button>
              </div>
            </div>
          )}
        </div>

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
          <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 px-6 py-3 rounded-2xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 transition shadow-sm">
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save all settings'}
          </button>
        </div>
      </form>
    </div>
  )
}
