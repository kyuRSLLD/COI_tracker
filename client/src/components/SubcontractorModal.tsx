import { useState, useEffect, useContext } from 'react'
import { X } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiSubcontractors } from '../api'
import { formatPhone, US_PHONE_PATTERN } from '../lib/formatPhone'
import { ConnectionOptions, ConnectionSession } from './ConnectionOptions'
import { Button } from './Button'

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
  initialMode?: 'connect' | 'manual'
  initialRequestSubId?: string
}

export function SubcontractorModal({
  open,
  onClose,
  subcontractor,
  onSaved,
  initialMode,
}: Props) {
  // Manual-entry fields
  const [companyName, setCompanyName] = useState('')
  const [trade, setTrade] = useState(TRADES[0])
  const [contactPerson, setContactPerson] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Two modes only: Connect (QR or email) and Enter manually
  const [method, setMethod] = useState<'connect' | 'manual'>('connect')
  const connectionSession = useContext(ConnectionSession)
  const canConnect = !subcontractor && connectionSession.role === 'gc' && Boolean(connectionSession.token)

  // Initialize/reset on open
  useEffect(() => {
    if (!open) return
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
    const mode = initialMode || (canConnect ? 'connect' : 'manual')
    setMethod(mode)
  }, [open, subcontractor, initialMode, canConnect])

  if (!open) return null

  const handleManualSubmit = async (e: React.FormEvent) => {
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
      <div className="bg-white rounded-2xl sm:rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900">
              {subcontractor ? 'Edit subcontractor' : 'Add a subcontractor'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Contact info is private to your company and automatically hidden from clients.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode tabs — only when adding a new sub */}
        {!subcontractor && (
          <div className="flex border-b border-slate-200 text-xs font-semibold -mx-5 px-5 sm:-mx-6 sm:px-6 mt-4 gap-1">
            {canConnect && (
              <button
                type="button"
                onClick={() => setMethod('connect')}
                className={`flex-1 text-center px-1.5 sm:px-3 py-2 border-b-2 transition whitespace-nowrap ${
                  method === 'connect'
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <span className="sm:hidden">Connect</span>
                <span className="hidden sm:inline">Connect (QR / email)</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setMethod('manual')}
              className={`flex-1 text-center px-1.5 sm:px-3 py-2 border-b-2 transition whitespace-nowrap ${
                method === 'manual'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <span className="sm:hidden">Manual</span>
              <span className="hidden sm:inline">Enter manually</span>
            </button>
          </div>
        )}

        {/* Tab 1 — Connect */}
        {!subcontractor && canConnect && method === 'connect' && (
          <ConnectionOptions
            key={connectionSession.token}
            onSaved={onSaved}
          />
        )}

        {/* Tab 2 — Enter manually */}
        {(Boolean(subcontractor) || !canConnect || method === 'manual') && (
          <>
            {error && (
              <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                {error}
              </div>
            )}
            <form onSubmit={handleManualSubmit} className="mt-5 space-y-3.5">
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
                      <option key={t} value={t}>
                        {t}
                      </option>
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
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={loading}>
                  {loading ? 'Saving…' : subcontractor ? 'Save changes' : 'Add subcontractor'}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
