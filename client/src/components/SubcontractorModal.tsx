import { useState, useEffect, useContext } from 'react'
import { X, CheckCircle2, Copy, ExternalLink } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiSubcontractors, apiEmails } from '../api'
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
  initialMode?: 'connect' | 'manual' | 'request'
  initialRequestSubId?: string
}

export function SubcontractorModal({
  open,
  onClose,
  subcontractor,
  onSaved,
  initialMode,
  initialRequestSubId,
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

  // Mode: connect | manual | request
  const [method, setMethod] = useState<'connect' | 'manual' | 'request'>('connect')
  const connectionSession = useContext(ConnectionSession)
  const canConnect = !subcontractor && connectionSession.role === 'gc' && Boolean(connectionSession.token)

  // Request-a-COI fields
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const [requestSubId, setRequestSubId] = useState<string>('')
  const [requestDays, setRequestDays] = useState('30')
  const [requestMessage, setRequestMessage] = useState('')
  const [requestLoading, setRequestLoading] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [requestResult, setRequestResult] = useState<{ portalUrl: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [thenRequest, setThenRequest] = useState(false)

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
    setRequestError(null)
    setRequestResult(null)
    setCopied(false)
    setThenRequest(false)
    const mode = initialMode || (canConnect ? 'connect' : 'manual')
    setMethod(mode)
    apiSubcontractors
      .list()
      .then((r) => {
        setSubs(r.subcontractors)
        const preselect = initialRequestSubId || (r.subcontractors[0]?.id ?? '')
        setRequestSubId(preselect)
      })
      .catch(() => {})
  }, [open, subcontractor, initialMode, initialRequestSubId, canConnect])

  if (!open) return null

  const handleManualSubmit = async (e: React.FormEvent, andRequest = false) => {
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
      let subId: string | undefined = subcontractor?.id
      if (subcontractor) {
        await apiSubcontractors.update(subcontractor.id, payload)
      } else {
        const res = await apiSubcontractors.create(payload)
        subId = res.subcontractor?.id
      }
      onSaved()
      if (andRequest && subId) {
        try {
          const req = await apiEmails.sendRequest({
            subcontractor_id: subId,
            expires_in_days: 30,
          })
          setRequestResult({ portalUrl: req.portalUrl, token: req.token })
          setRequestSubId(subId)
          setMethod('request')
          return
        } catch {
          // Sub was saved even if link creation failed
        }
      }
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRequestSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!requestSubId) return
    setRequestLoading(true)
    setRequestError(null)
    try {
      const res = await apiEmails.sendRequest({
        subcontractor_id: requestSubId,
        custom_message: requestMessage.trim() || undefined,
        expires_in_days: Number(requestDays),
      })
      setRequestResult({ portalUrl: res.portalUrl, token: res.token })
      onSaved()
    } catch (err: any) {
      setRequestError(err.message || 'Unable to create upload link')
    } finally {
      setRequestLoading(false)
    }
  }

  const copyLink = async () => {
    if (!requestResult) return
    await navigator.clipboard.writeText(requestResult.portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-extrabold text-slate-900">
              {subcontractor ? 'Edit subcontractor' : 'Add a subcontractor'}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {method === 'request'
                ? 'Create a shareable upload link — the subcontractor opens it, enters policy details, and attaches the certificate. No account needed.'
                : 'Contact info is private to your company and is automatically hidden from clients.'}
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
          <div className="flex border-b border-slate-200 text-xs font-semibold -mx-6 px-6 mt-4 gap-1 overflow-x-auto">
            {canConnect && (
              <button
                type="button"
                onClick={() => setMethod('connect')}
                className={`px-3 py-2 border-b-2 transition whitespace-nowrap ${
                  method === 'connect'
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                Connect (QR / invite)
              </button>
            )}
            <button
              type="button"
              onClick={() => setMethod('manual')}
              className={`px-3 py-2 border-b-2 transition whitespace-nowrap ${
                method === 'manual'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Enter manually
            </button>
            <button
              type="button"
              onClick={() => setMethod('request')}
              className={`px-3 py-2 border-b-2 transition whitespace-nowrap ${
                method === 'request'
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              Request a COI
            </button>
          </div>
        )}

        {/* Tab 1 — Connect */}
        {!subcontractor && canConnect && method === 'connect' && (
          <ConnectionOptions
            key={connectionSession.token}
            onSaved={onSaved}
            onManual={() => setMethod('manual')}
          />
        )}

        {/* Tab 2 — Enter manually */}
        {(Boolean(subcontractor) || (!canConnect && method !== 'request') || method === 'manual') && (
          <>
            {error && (
              <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                {error}
              </div>
            )}
            <form onSubmit={(e) => handleManualSubmit(e, thenRequest)} className="mt-5 space-y-3.5">
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
                {subcontractor ? (
                  <Button type="submit" variant="primary" disabled={loading}>
                    {loading ? 'Saving…' : 'Save changes'}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={loading}
                      onClick={() => setThenRequest(false)}
                    >
                      Add subcontractor
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={loading}
                      onClick={() => setThenRequest(true)}
                    >
                      {loading ? 'Saving…' : 'Save & request COI'}
                    </Button>
                  </>
                )}
              </div>
            </form>
          </>
        )}

        {/* Tab 3 — Request a COI */}
        {!subcontractor && method === 'request' && (
          <div className="mt-4">
            {requestError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
                {requestError}
              </div>
            )}
            {requestResult ? (
              <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  Upload link created — send it to the subcontractor
                </div>
                <div className="flex gap-2">
                  <input
                    readOnly
                    value={requestResult.portalUrl}
                    className="flex-1 rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-mono text-slate-800 select-all"
                  />
                  <Button type="button" variant="primary" onClick={copyLink} className="text-xs">
                    <Copy className="w-3.5 h-3.5 mr-1" />
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <a
                    href={requestResult.portalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-brand-700 hover:underline font-semibold"
                  >
                    Open upload page <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  <a
                    href={`mailto:?subject=${encodeURIComponent('Please upload your Certificate of Insurance')}&body=${encodeURIComponent(`Hi,\n\nPlease upload your Certificate of Insurance using this link:\n${requestResult.portalUrl}\n\nThank you.`)}`}
                    className="text-brand-700 hover:underline font-semibold"
                  >
                    Email the link
                  </a>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setRequestResult(null)
                      onSaved()
                    }}
                  >
                    Create another link
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => {
                      onSaved()
                      onClose()
                    }}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : subs.length === 0 ? (
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-2">
                <div className="font-semibold">No subcontractors yet</div>
                <p>
                  Add a subcontractor first (via{' '}
                  <button
                    type="button"
                    onClick={() => setMethod('connect')}
                    className="underline font-semibold"
                  >
                    Connect
                  </button>{' '}
                  or{' '}
                  <button
                    type="button"
                    onClick={() => setMethod('manual')}
                    className="underline font-semibold"
                  >
                    Enter manually
                  </button>
                  ), then come back to create their upload link.
                </p>
              </div>
            ) : (
              <form onSubmit={handleRequestSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Subcontractor
                  </label>
                  <select
                    value={requestSubId}
                    onChange={(e) => setRequestSubId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.company_name} — {s.trade}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Link expires in
                  </label>
                  <select
                    value={requestDays}
                    onChange={(e) => setRequestDays(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Optional note to include
                  </label>
                  <textarea
                    value={requestMessage}
                    onChange={(e) => setRequestMessage(e.target.value)}
                    rows={2}
                    placeholder="e.g. Please provide your renewed COI before mobilization on June 15."
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Include this note when you share the link manually.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" disabled={requestLoading || !requestSubId}>
                    {requestLoading ? 'Creating…' : 'Create upload link'}
                  </Button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
