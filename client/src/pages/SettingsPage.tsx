import { useState, useEffect } from 'react'
import { Sparkles, Save } from 'lucide-react'
import type { GCSettings } from '../types'
import { apiSettings } from '../api'

export function SettingsPage() {
  const [settings, setSettings] = useState<GCSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    apiSettings.get().then((r) => setSettings(r.settings)).finally(() => setLoading(false))
  }, [])

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

  if (loading || !settings) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-xs text-slate-400">Loading settings…</div>
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      <div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Company & Coverage Settings</h1>
        <p className="text-xs text-slate-500 mt-1">
          These requirements are shown to subcontractors when they upload COIs, and to clients on your shared compliance portals.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 text-xs">
        {/* Company profile */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-base font-bold text-slate-900">General contractor profile</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Company name</label>
              <input value={settings.company_name || ''} onChange={(e) => setSettings({ ...settings, company_name: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">License number</label>
              <input value={settings.license_number || ''} onChange={(e) => setSettings({ ...settings, license_number: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Phone</label>
              <input value={settings.phone || ''} onChange={(e) => setSettings({ ...settings, phone: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Compliance contact email</label>
              <input type="email" value={settings.email || ''} onChange={(e) => setSettings({ ...settings, email: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
            </div>
            <div className="sm:col-span-2">
              <label className="block font-semibold text-slate-700 mb-1">Office address</label>
              <input value={settings.address || ''} onChange={(e) => setSettings({ ...settings, address: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
            </div>
          </div>
        </div>

        {/* Coverage requirements */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-base font-bold text-slate-900">Default required coverage limits</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">General Liability (per/aggregate)</label>
              <input value={settings.required_gl_limit || ''} onChange={(e) => setSettings({ ...settings, required_gl_limit: e.target.value })} placeholder="$1,000,000 / $2,000,000" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Automobile Liability</label>
              <input value={settings.required_auto_limit || ''} onChange={(e) => setSettings({ ...settings, required_auto_limit: e.target.value })} placeholder="$1,000,000" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Workers' Compensation</label>
              <input value={settings.required_wc_limit || ''} onChange={(e) => setSettings({ ...settings, required_wc_limit: e.target.value })} placeholder="Statutory Limits" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Umbrella / Excess Liability</label>
              <input value={settings.required_umbrella_limit || ''} onChange={(e) => setSettings({ ...settings, required_umbrella_limit: e.target.value })} placeholder="$5,000,000" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
            </div>
          </div>
        </div>

        {/* Endorsement wording + warning days */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card space-y-4">
          <h2 className="text-base font-bold text-slate-900">Endorsements & renewal alerts</h2>
          <div>
            <label className="block font-semibold text-slate-700 mb-1">Required additional-insured wording (shown to subcontractors)</label>
            <textarea rows={3} value={settings.additional_insured_wording || ''} onChange={(e) => setSettings({ ...settings, additional_insured_wording: e.target.value })} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
          </div>
          <div className="max-w-xs">
            <label className="block font-semibold text-slate-700 mb-1">Expiration warning window</label>
            <div className="flex items-center gap-2">
              <input type="number" min="7" max="180" value={settings.expiration_warning_days} onChange={(e) => setSettings({ ...settings, expiration_warning_days: Number(e.target.value) })} className="w-24 rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-bold" />
              <span className="text-slate-500">days before expiration</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" disabled={saving} className="inline-flex items-center gap-1.5 px-6 py-3 rounded-2xl text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 transition shadow-sm">
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save all settings'}
          </button>
        </div>
      </form>
    </div>
  )
}
