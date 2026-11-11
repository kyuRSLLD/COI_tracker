import { useState, useEffect } from 'react'
import { X, Building2 } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiSubcontractors } from '../api'
import { InvitePanel } from './InvitePanel'
import { SubcontractorQrScanner } from './SubcontractorQrScanner'
import { apiStagedInvites, getStoredUser } from '../api'
import { stagedInvitesEnabled, previewNotice } from '../lib/stagedInvites'
import { formatPhone, US_PHONE_PATTERN } from '../lib/formatPhone'

const TRADES = [
  'Electrical',
  'HVAC',
  'Plumbing',
  'Roofing',
  'Concrete',
  'Framing & Structural',
  'Drywall',
  'Painting',
  'Flooring',
  'Masonry',
  'Insulation',
  'Demolition',
  'Fire Protection',
  'Landscaping',
  'Other',
]

interface Props {
  open: boolean
  onClose: () => void
  subcontractor?: Subcontractor | null
  onSaved: () => void
}

export function SubcontractorModal({ open, onClose, subcontractor, onSaved }: Props) {
  const [companyName, setCompanyName] = useState('')
  const [trade, setTrade] = useState(TRADES[0])
  const [contactPerson, setContactPerson] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'manual' | 'invite' | 'scan'>('manual')
  const [staged, setStaged] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (subcontractor) {
      setCompanyName(subcontractor.company_name)
      setTrade(subcontractor.trade)
      setContactPerson(subcontractor.contact_person || '')
      setPhone(subcontractor.phone || '')
      setEmail(subcontractor.email || '')
      setAddress(subcontractor.address || '')
      setNotes(subcontractor.notes || '')
    } else {
      setCompanyName('')
      setTrade(TRADES[0])
      setContactPerson('')
      setPhone('')
      setEmail('')
      setAddress('')
      setNotes('')
    }
    setError(null)
    setMode('manual')
    setStaged(false)
  }, [subcontractor, open])

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!companyName.trim()) return
    setLoading(true)
    setError(null)
    try {
      const payload = {
        company_name: companyName.trim(),
        trade,
        contact_person: contactPerson.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        notes: notes.trim() || undefined,
      }
      if (subcontractor) {
        await apiSubcontractors.update(subcontractor.id, payload)
      } else {
        await apiSubcontractors.create(payload)
      }
      onSaved()
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-lg w-full max-h-[calc(100dvh-2rem)] overflow-y-auto p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Building2 className="w-3.5 h-3.5" /> Subcontractor
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-1">
              {subcontractor ? 'Edit subcontractor' : 'Add a new subcontractor'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Contact info is private to your company and is automatically hidden from clients.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {stagedInvitesEnabled && !subcontractor && getStoredUser()?.role === 'gc' && <div className="mt-5 space-y-3">
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{previewNotice}</p>
          <div role="group" aria-label="How to add a subcontractor" className="flex flex-wrap gap-2">
            {([['manual', 'Manual add'], ['invite', 'Invite'], ['scan', 'Scan subcontractor QR']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={mode === key} onClick={() => { setMode(key); setStaged(false) }} className={`rounded-lg px-3 py-2 text-xs font-semibold ${mode === key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>{label}</button>)}
          </div>
        </div>}
        {stagedInvitesEnabled && !subcontractor && mode === 'invite' && <InvitePanel hidden={false} />}
        {stagedInvitesEnabled && !subcontractor && mode === 'scan' && (staged ? <p role="status" className="mt-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">Test relationship recorded. No live subcontractor link or COI sharing was created.</p> : <div className="mt-4"><SubcontractorQrScanner
          onValidToken={async token => {
            const info = await apiStagedInvites.subQrInfo(token)
            const companyName = info.company_name ?? info.subcontractor?.company_name ?? info.sub_company_name
            return { companyName, trade: info.trade ?? info.subcontractor?.trade }
          }}
          onConfirmToken={async token => { const result = await apiStagedInvites.acceptSubQr(token); if (result?.status !== 'staged') throw new Error('Unexpected status') }}
          onConnected={() => setStaged(true)} onClose={() => setMode('manual')} /></div>)}
        <div hidden={!subcontractor && mode !== 'manual'}>
        {error && <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}

        <form onSubmit={handleSubmit} className="mt-5 space-y-3.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Company name *</label>
              <input
                required
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Horizon Electrical Services"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Trade *</label>
              <select
                value={trade}
                onChange={(e) => setTrade(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {TRADES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Contact person</label>
              <input
                value={contactPerson}
                onChange={(e) => setContactPerson(e.target.value)}
                placeholder="Elena Ramos"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(formatPhone(e.target.value))}
                placeholder="(312) 555-0321"
                pattern={US_PHONE_PATTERN}
                title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="elena@horizonelectric.demo"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Address</label>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="1420 W Grand Ave, Chicago, IL"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Internal notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Licensing, past projects, specialty notes…"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-60 transition shadow-sm"
            >
              {loading ? 'Saving…' : subcontractor ? 'Save changes' : 'Add subcontractor'}
            </button>
          </div>
        </form>
        </div>
      </div>
    </div>
  )
}
