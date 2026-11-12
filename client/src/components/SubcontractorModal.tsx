import { useState, useEffect, useContext } from 'react'
import { X, Building2 } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiSubcontractors } from '../api'
import { formatPhone, US_PHONE_PATTERN } from '../lib/formatPhone'
import { ConnectionOptions, ConnectionSession } from './ConnectionOptions'

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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState<'manual' | 'connect'>('connect')
  const connectionSession = useContext(ConnectionSession)
  const canConnect = !subcontractor && connectionSession.role === 'gc' && Boolean(connectionSession.token)

  useEffect(() => {
    if (subcontractor) {
      setCompanyName(subcontractor.company_name)
      setTrade(subcontractor.trade)
      setContactPerson(subcontractor.contact_person || '')
      setPhone(subcontractor.phone || '')
      setEmail(subcontractor.email || '')
      setAddress(subcontractor.address || '')
    } else {
      setCompanyName('')
      setTrade(TRADES[0])
      setContactPerson('')
      setPhone('')
      setEmail('')
      setAddress('')
    }
    setError(null)
    setMethod('connect')
  }, [subcontractor, open, connectionSession.token])

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
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
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
            <p className="text-[11px] text-slate-400 mt-1">
              Internal subcontractor notes are not available in this view.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {canConnect && method === 'connect' && <ConnectionOptions key={connectionSession.token} onSaved={onSaved} onManual={() => setMethod('manual')} />}
        {(!canConnect || method === 'manual') && <>
        {canConnect && <button type="button" onClick={() => setMethod('connect')} className="mt-5 text-xs font-semibold text-brand-700 hover:underline">Back to connection options</button>}
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
        </>}
      </div>
    </div>
  )
}
