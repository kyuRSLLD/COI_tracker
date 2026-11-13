import { useContext, useState, useEffect, useLayoutEffect, useRef } from 'react'
import type { ComponentProps } from 'react'
import { Plus, Search, FileText, Edit2, Trash2, Upload, ChevronDown, ChevronRight, Check } from 'lucide-react'
import type { Subcontractor, GCSettings, COI } from '../types'
import { ApiError, apiCoiFields, apiSubcontractors, apiSettings, getToken, SESSION_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from '../api'
import { ExpirationBadge } from '../components/ExpirationBadge'
import { RequestCOIModal } from '../components/RequestCOIModal'
import { SubcontractorModal } from '../components/SubcontractorModal'
import { AddCOIModal } from '../components/AddCOIModal'
import { COIReviewModal } from '../components/COIReviewModal'
import { CertificateViewer } from '../components/CertificateViewer'
import { ConnectionSession } from '../components/ConnectionOptions'
import { CoiFieldsReview } from '../components/CoiFieldsReview'

// The authenticated detail endpoint returns only the current GC's owned
// certificates or the connected subcontractor's own certificates. It includes
// both owner fields, although they are not part of the shared COI type.
type DetailCOI = COI & { owner_gc_user_id?: string | null; owner_sub_user_id?: string | null }

function canReviewCertificate(coi: DetailCOI): boolean {
  // Mirror the review endpoint: malformed dual-owned or unknown rows are not writable.
  return typeof coi.owner_gc_user_id === 'string' && coi.owner_gc_user_id.length > 0 && coi.owner_sub_user_id === null
}

function isSubOwnedCertificate(coi: DetailCOI): boolean {
  return coi.owner_gc_user_id === null && typeof coi.owner_sub_user_id === 'string' && coi.owner_sub_user_id.length > 0
}

// Remount the entire page for a new authenticated identity, including legacy
// modals. Never render a previous account's data under a newly stored token.
export function SubcontractorsPage() {
  const { token } = useContext(ConnectionSession)
  if (!token || token !== getToken()) return null
  return <SessionSubcontractorsPage key={token} sessionToken={token} />
}

type FieldsDetails = ComponentProps<typeof CoiFieldsReview>['details']
type FieldsReviewState = {
  coi: COI
  loading: boolean
  details: FieldsDetails | null
  wasEmpty: boolean
  sourceTag: string
  reviewRevision: string | null
  editable: boolean
  saving: boolean
  openingOriginal: boolean
  conflicted: boolean
  error: string | null
}

// The API accepts sparse reviews. Normalize missing sections for the editor,
// without copying values from unrelated legacy COI fields or inventing facts.
function editorDetails(details: FieldsDetails | null): FieldsDetails {
  return {
    producer: {
      name: details?.producer?.name ?? '', address: details?.producer?.address ?? '',
      phone: details?.producer?.phone ?? '', email: details?.producer?.email ?? '',
    },
    insured: { name: details?.insured?.name ?? '', address: details?.insured?.address ?? '' },
    insurers: (details?.insurers ?? []).map((item) => ({ letter: item.letter ?? '', name: item.name ?? '', naic: item.naic ?? '' })),
    policies: (details?.policies ?? []).map((policy) => ({
      type: policy.type ?? '', insurerLetter: policy.insurerLetter ?? '', policyNumber: policy.policyNumber ?? '',
      effectiveDate: policy.effectiveDate ?? '', expirationDate: policy.expirationDate ?? '',
      limits: (policy.limits ?? []).map((limit) => ({ label: limit.label ?? '', amount: limit.amount ?? '' })),
    })),
    source: details?.source ?? 'manual',
  }
}

function SessionSubcontractorsPage({ sessionToken }: { sessionToken: string }) {
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const [gcSettings, setGcSettings] = useState<GCSettings | undefined>()
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [trade, setTrade] = useState('all')
  const [status, setStatus] = useState('all')
  const [selectedSub, setSelectedSub] = useState<Subcontractor | null>(null)
  const [editSub, setEditSub] = useState<Subcontractor | null>(null)
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [requestModal, setRequestModal] = useState(false)
  const [requestSubId, setRequestSubId] = useState<string | undefined>()
  const [addCoiSub, setAddCoiSub] = useState<Subcontractor | null>(null)
  const [addCoiOpen, setAddCoiOpen] = useState(false)
  const [reviewCoi, setReviewCoi] = useState<any>(null)
  const [viewingCertificate, setViewingCertificate] = useState<COI | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fieldsReview, setFieldsReview] = useState<FieldsReviewState | null>(null)
  const [invalidated, setInvalidated] = useState(false)
  const active = useRef(false)
  const listVersion = useRef(0)
  const detailVersion = useRef(0)
  const fieldsVersion = useRef(0)
  const fieldsSaving = useRef(false)
  const originalInFlight = useRef(false)
  const reviewBlocked = useRef(false)
  const standaloneViewVersion = useRef(0)
  const selectedSubRef = useRef<Subcontractor | null>(null)
  const detailTarget = useRef<string | null>(null)

  useLayoutEffect(() => {
    active.current = true
    const invalidate = () => {
      active.current = false
      listVersion.current++
      detailVersion.current++
      fieldsVersion.current++
      setInvalidated(true)
    }
    const storageChanged = (event: StorageEvent) => {
      if ((event.key === 'coi_token' || event.key === null) && getToken() !== sessionToken) invalidate()
    }
    const sessionChanged = () => { if (getToken() !== sessionToken) invalidate() }
    const sessionExpired = (event: Event) => { if ((event as CustomEvent<string>).detail === sessionToken) invalidate() }
    window.addEventListener('storage', storageChanged)
    window.addEventListener(SESSION_CHANGED_EVENT, sessionChanged)
    window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpired)
    return () => {
      active.current = false
      listVersion.current++
      detailVersion.current++
      fieldsVersion.current++
      window.removeEventListener('storage', storageChanged)
      window.removeEventListener(SESSION_CHANGED_EVENT, sessionChanged)
      window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpired)
    }
  }, [sessionToken])

  const currentSession = () => active.current && getToken() === sessionToken

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  const load = async () => {
    const version = ++listVersion.current
    if (!currentSession()) return
    try {
      const [res, cfg] = await Promise.all([
        apiSubcontractors.list({
          trade: trade === 'all' ? undefined : trade,
          status: status === 'all' ? undefined : status,
          search: search || undefined,
        }),
        apiSettings.get(),
      ])
      if (!currentSession() || version !== listVersion.current) return
      setSubs(res.subcontractors)
      setGcSettings(cfg.settings)
      setLoadError(null)
      if (selectedSubRef.current && detailTarget.current === selectedSubRef.current.id) void loadDetail(selectedSubRef.current.id)
    } catch (err: unknown) {
      if (currentSession() && version === listVersion.current) setLoadError(err instanceof Error ? err.message : 'Unable to refresh subcontractors.')
    } finally {
      if (currentSession() && version === listVersion.current) setLoading(false)
    }
  }

  const loadDetail = async (id: string) => {
    const version = ++detailVersion.current
    detailTarget.current = id
    if (!currentSession()) return
    try {
      const res = await apiSubcontractors.get(id)
      if (!currentSession() || version !== detailVersion.current) return
      selectedSubRef.current = res.subcontractor
      setSelectedSub(res.subcontractor)
    } catch (err: unknown) {
      if (currentSession() && version === detailVersion.current) {
        detailTarget.current = selectedSubRef.current?.id ?? null
        setLoadError(err instanceof Error ? err.message : 'Unable to load subcontractor.')
      }
    }
  }

  const openSubcontractor = (sub: Subcontractor) => {
    // Some list responses already contain the full detail. Show that data
    // immediately, then refresh; summary-only rows still wait for the GET.
    if (sub.cois) {
      selectedSubRef.current = sub
      setSelectedSub(sub)
    }
    void loadDetail(sub.id)
  }

  useEffect(() => {
    load()
  }, [trade, status, search])
  useEffect(() => {
    if (!fieldsReview?.saving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [fieldsReview?.saving])

  const handleDelete = async (s: Subcontractor) => {
    if (!confirm(`Delete ${s.company_name} and its certificates?`)) return
    await apiSubcontractors.delete(s.id)
    if (!currentSession()) return
    if (detailTarget.current === s.id) {
      detailVersion.current++
      detailTarget.current = selectedSubRef.current?.id ?? null
    }
    if (selectedSubRef.current?.id === s.id) {
      detailVersion.current++
      detailTarget.current = null
      selectedSubRef.current = null
      setSelectedSub(null)
    }
    showToast(`${s.company_name} removed`)
    load()
  }

  const closeFieldsReview = (saved = false) => {
    if (fieldsSaving.current && !saved) return
    fieldsVersion.current++
    fieldsSaving.current = false
    originalInFlight.current = false
    setFieldsReview(null)
  }

  const openFieldsReview = async (coi: COI) => {
    if (fieldsSaving.current || !currentSession()) return
    const version = ++fieldsVersion.current
    standaloneViewVersion.current++
    fieldsSaving.current = false
    originalInFlight.current = false
    reviewBlocked.current = false
    setViewingCertificate(null)
    setFieldsReview({ coi, loading: true, details: null, wasEmpty: false, sourceTag: '', reviewRevision: null, editable: false, saving: false, openingOriginal: false, conflicted: false, error: null })
    try {
      const result = await apiCoiFields.get(coi.id, sessionToken)
      if (!currentSession() || version !== fieldsVersion.current) return
      const editable = result.editable === true
      setFieldsReview({ coi, loading: false, details: result.details === null && !editable ? null : editorDetails(result.details), wasEmpty: result.details === null, sourceTag: result.sourceTag, reviewRevision: result.reviewRevision, editable, saving: false, openingOriginal: false, conflicted: false, error: null })
    } catch (err: unknown) {
      if (!currentSession() || version !== fieldsVersion.current) return
      setFieldsReview({ coi, loading: false, details: null, wasEmpty: false, sourceTag: '', reviewRevision: null, editable: false, saving: false, openingOriginal: false, conflicted: false, error: err instanceof Error ? err.message : 'Unable to load field review.' })
    }
  }

  // A fresh URL is bound to the source tag, not to the possibly stale detail
  // row. Keep the editor's draft and its original revision untouched.
  const openFieldsOriginal = async () => {
    const review = fieldsReview
    if (!review?.sourceTag || review.conflicted || reviewBlocked.current || review.loading || review.saving || fieldsSaving.current || originalInFlight.current || !currentSession()) return
    const version = fieldsVersion.current
    originalInFlight.current = true
    setFieldsReview(current => current && { ...current, openingOriginal: true })
    try {
      const result = await apiCoiFields.get(review.coi.id, sessionToken)
      if (!currentSession() || version !== fieldsVersion.current) return
      if (result.sourceTag !== review.sourceTag) {
        reviewBlocked.current = true
        setFieldsReview(current => current && { ...current, editable: false, conflicted: true, error: 'The certificate changed. Close and reopen the review to reload the current document; your unsaved draft cannot be saved.' })
      } else if (!result.certificateUrl) {
        setFieldsReview(current => current && { ...current, error: 'The original certificate is unavailable. Try again later or ask for a new upload.' })
      } else {
        setViewingCertificate({ ...review.coi, certificate_url: result.certificateUrl })
      }
    } catch (err: unknown) {
      if (currentSession() && version === fieldsVersion.current) setFieldsReview(current => current && { ...current, error: err instanceof Error ? err.message : 'Could not refresh the certificate link. Please try again.' })
    } finally {
      if (currentSession() && version === fieldsVersion.current) {
        originalInFlight.current = false
        setFieldsReview(current => current && { ...current, openingOriginal: false })
      }
    }
  }

  const openListOriginal = async (coi: COI) => {
    if (!currentSession()) return
    const version = ++standaloneViewVersion.current
    try {
      const result = await apiCoiFields.get(coi.id, sessionToken)
      if (!currentSession() || version !== standaloneViewVersion.current) return
      if (!result.certificateUrl) { setLoadError('The certificate file is unavailable. Please try again later.'); return }
      setViewingCertificate({ ...coi, certificate_url: result.certificateUrl })
    } catch (err: unknown) {
      if (currentSession() && version === standaloneViewVersion.current) setLoadError(err instanceof Error ? err.message : 'Could not refresh the certificate link. Please try again.')
    }
  }

  const saveFieldsReview = async () => {
    const review = fieldsReview
    if (!review || review.loading || !review.details || !review.sourceTag || !review.reviewRevision || !review.editable || review.conflicted || reviewBlocked.current || review.saving || fieldsSaving.current || originalInFlight.current || !currentSession()) return
    const version = fieldsVersion.current
    fieldsSaving.current = true
    setFieldsReview((current) => current && { ...current, saving: true, error: null })
    try {
      await apiCoiFields.save(review.coi.id, { sourceTag: review.sourceTag, reviewRevision: review.reviewRevision, details: review.details }, sessionToken)
      if (!currentSession() || version !== fieldsVersion.current) return
      closeFieldsReview(true)
      showToast('Document fields saved — not verified')
      void load()
    } catch (err: unknown) {
      if (!currentSession() || version !== fieldsVersion.current) return
      const uncertain = !(err instanceof ApiError) || err.status >= 500
      const noLongerEditable = uncertain || (err instanceof ApiError && [403, 404, 409].includes(err.status))
      if (noLongerEditable) reviewBlocked.current = true
      const message = err instanceof ApiError && err.status === 409
        ? 'The certificate or review changed, possibly because someone else edited it. Close and reopen the review to reload; your unsaved draft cannot be saved.'
        : uncertain ? 'The save outcome is uncertain. Close and reopen the review to check the saved data before making changes again.'
          : err instanceof Error ? err.message : 'Unable to save field review.'
      setFieldsReview((current) => current && { ...current, saving: false, conflicted: (err instanceof ApiError && err.status === 409) || current.conflicted, editable: noLongerEditable ? false : current.editable, error: message })
    } finally {
      if (version === fieldsVersion.current) fieldsSaving.current = false
    }
  }

  const trades = ['all', 'Electrical', 'HVAC', 'Plumbing', 'Roofing', 'Concrete', 'Framing & Structural', 'Drywall', 'Painting']
  const statuses = [
    { key: 'all', label: 'All' },
    { key: 'compliant', label: 'Compliant' },
    { key: 'expiring_soon', label: 'Expiring ≤30d' },
    { key: 'expired', label: 'Expired' },
    { key: 'missing', label: 'Missing' },
    { key: 'pending_review', label: 'Pending review' },
  ]

  if (invalidated || getToken() !== sessionToken) return null

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Subcontractors</h1>
          <p className="text-xs text-slate-500 mt-1">
            Track Certificates of Insurance per subcontractor. Contact information is private to you and never shared with clients.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setAddCoiSub(selectedSub); setAddCoiOpen(true) }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 transition"
          >
            <Upload className="w-3.5 h-3.5" /> Upload COI
          </button>
          <button
            onClick={() => { setEditSub(null); setAddSubOpen(true) }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" /> Add subcontractor
          </button>
        </div>
      </div>

      {loadError && <div role="alert" className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">Unable to refresh subcontractors: {loadError}</div>}

      {/* Filters */}
      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-card space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by company name, contact, or trade…"
              className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex items-center gap-2 overflow-x-auto text-xs pb-1 sm:pb-0">
            {statuses.map((s) => (
              <button
                key={s.key}
                onClick={() => setStatus(s.key)}
                className={`px-3 py-1.5 rounded-full font-semibold transition shrink-0 ${
                  status === s.key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Trade tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs pt-2 border-t border-slate-100">
          {trades.map((t) => (
            <button
              key={t}
              onClick={() => setTrade(t)}
              className={`px-2.5 py-1 rounded-lg font-medium transition shrink-0 ${
                trade === t ? 'bg-brand-50 text-brand-700 font-bold' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              {t === 'all' ? 'All trades' : t}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        {loading ? (
          <p className="text-center text-xs text-slate-400 py-12">Loading subcontractors…</p>
        ) : subs.length === 0 ? (
          <p className="text-center text-xs text-slate-400 italic py-12">No subcontractors match the current filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-wider text-[11px] bg-slate-50/70">
                  <th className="py-3 pl-4 pr-3">Subcontractor</th>
                  <th className="py-3 pr-3">Trade</th>
                  <th className="py-3 pr-3">Contact (private)</th>
                  <th className="py-3 pr-3">Latest COI</th>
                  <th className="py-3 pr-3">Expiration</th>
                  <th className="py-3 pr-3">Status</th>
                  <th className="py-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subs.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openSubcontractor(s)}
                    className="hover:bg-brand-50/30 cursor-pointer transition"
                  >
                    <td className="py-3.5 pl-4 pr-3 font-bold text-slate-900">{s.company_name}</td>
                    <td className="py-3.5 pr-3 text-slate-600">{s.trade}</td>
                    <td className="py-3.5 pr-3 text-slate-500">
                      <div>{s.contact_person || '—'}</div>
                      <div className="text-[11px] text-slate-400 font-['JetBrains_Mono']">
                        {[s.phone, s.email].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="py-3.5 pr-3 text-slate-600">
                      {s.best_coi ? (
                        <>
                          <div className="font-semibold text-slate-800">{s.best_coi.carrier}</div>
                          {s.best_coi.simulated_carrier_connect && <div className="text-amber-800">Simulated — not verified</div>}
                          <div className="text-[11px] text-slate-400 font-['JetBrains_Mono']">{s.best_coi.policy_number || '—'}</div>
                        </>
                      ) : (
                        <span className="text-slate-400 italic">None on file</span>
                      )}
                    </td>
                    <td className="py-3.5 pr-3 font-semibold text-slate-900 font-['JetBrains_Mono']">
                      {s.best_coi?.expiration_date || '—'}
                    </td>
                    <td className="py-3.5 pr-3">
                      <ExpirationBadge status={s.computed_status} daysLeft={s.days_left} />
                    </td>
                    <td className="py-3.5 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => { setRequestSubId(s.id); setRequestModal(true) }}
                          title="Request COI"
                          className="p-1.5 rounded-lg text-brand-600 hover:bg-brand-50"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => { setAddCoiSub(s); setAddCoiOpen(true) }}
                          title={`Upload COI for ${s.company_name}`}
                          aria-label={`Upload COI for ${s.company_name}`}
                          className="inline-flex items-center gap-1 p-1.5 rounded-lg text-brand-600 hover:bg-brand-50 font-semibold"
                        >
                          <Upload className="w-4 h-4" /> Upload COI
                        </button>
                        <button
                          onClick={() => { setEditSub(s); setAddSubOpen(true) }}
                          title="Edit"
                          className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(s)}
                          title="Delete"
                          className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Subcontractor detail drawer */}
      {selectedSub && (
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-card space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
                Subcontractor file · {selectedSub.trade}
              </div>
              <h2 className="text-2xl font-extrabold text-slate-900 mt-1">{selectedSub.company_name}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{selectedSub.notes || 'No internal notes'}</p>
            </div>
            <div className="flex items-center gap-2">
              <ExpirationBadge status={selectedSub.computed_status} daysLeft={selectedSub.days_left} />
              <button
                onClick={() => { detailVersion.current++; detailTarget.current = null; selectedSubRef.current = null; setSelectedSub(null) }}
                className="text-xs font-semibold text-slate-400 hover:text-slate-700"
              >
                Close
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div><span className="text-slate-400">Contact</span><div className="font-bold text-slate-900 mt-0.5">{selectedSub.contact_person || '—'}</div></div>
            <div><span className="text-slate-400">Phone</span><div className="font-bold text-slate-900 mt-0.5 font-['JetBrains_Mono']">{selectedSub.phone || '—'}</div></div>
            <div><span className="text-slate-400">Email</span><div className="font-bold text-slate-900 mt-0.5 truncate">{selectedSub.email || '—'}</div></div>
            <div><span className="text-slate-400">Address</span><div className="font-bold text-slate-900 mt-0.5 truncate">{selectedSub.address || '—'}</div></div>
          </div>

          {/* COIs list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-slate-900">Certificates of Insurance on file</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setAddCoiSub(selectedSub); setAddCoiOpen(true) }}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700"
                >
                  Upload COI
                </button>
                <span className="text-slate-300">·</span>
                <button
                  onClick={() => { setRequestSubId(selectedSub.id); setRequestModal(true) }}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700"
                >
                  Request upload link
                </button>
              </div>
            </div>

            {selectedSub.cois && selectedSub.cois.length > 0 ? (
              <div className="space-y-3">
                {selectedSub.cois.map((c) => (
                  <div key={c.id} className="p-4 rounded-xl border border-slate-200 bg-white">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <span className="font-bold text-slate-900 text-sm">{c.carrier}</span>
                        <span className="text-slate-400 text-xs"> · Policy {c.policy_number || '—'} · AM Best: {c.am_best_rating || 'n/a'}</span>
                        <div className="text-[11px] text-slate-500 mt-0.5 font-['JetBrains_Mono']">
                          Effective {c.effective_date} → Expires {c.expiration_date}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-start sm:self-center">
                        {c.simulated_carrier_connect ? <span className="text-amber-800 font-semibold">Simulated — not verified</span> : <ExpirationBadge status={c.status} showCountdown={false} size="sm" />}
                        <button
                          type="button"
                          onClick={() => void openFieldsReview(c)}
                          className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100"
                        >
                          Review fields
                        </button>
                        {canReviewCertificate(c) && (
                          <button
                            onClick={() => { setReviewCoi({ ...c, company_name: selectedSub.company_name, trade: selectedSub.trade }); }}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100"
                          >
                            Review
                          </button>
                        )}
                      </div>
                    </div>

                    {!canReviewCertificate(c) && (
                      <p className="mt-2 text-[11px] text-slate-600">
                        {isSubOwnedCertificate(c)
                          ? 'Uploaded by the subcontractor. GC review is not available yet. Select Review fields to view structured document data.'
                          : 'GC review is unavailable for this certificate.'}
                      </p>
                    )}

                    {c.certificate_url && !c.simulated_carrier_connect && (
                      <div className="mt-2 text-[11px]">
                        <button
                          type="button"
                          onClick={() => void openListOriginal(c)}
                          className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
                        >
                          View certificate file <FileText className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    {c.coverages && c.coverages.length > 0 && (
                      <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                        {c.coverages.map((cv, i) => (
                          <div key={i} className="p-2 rounded-lg bg-slate-50 border border-slate-100">
                            <div className="font-bold text-slate-800">{cv.type}</div>
                            <div className="text-slate-500">{cv.per_occurrence_limit || 'Limits n/a'}</div>
                            <div className="text-slate-400">
                              {[Boolean(cv.additional_insured) && 'AI ✓', Boolean(cv.waiver_of_subrogation) && 'WOS ✓'].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400 italic">No certificates yet. Upload a COI or request a self-service upload link.</p>
            )}
          </div>

          {/* Upload requests */}
          {selectedSub.upload_requests && selectedSub.upload_requests.length > 0 && (
            <div>
              <h3 className="text-sm font-bold text-slate-900 mb-2">Magic upload links issued</h3>
              <div className="space-y-1.5 text-xs font-['JetBrains_Mono']">
                {selectedSub.upload_requests.map((r) => (
                  <div key={r.id} className="p-2.5 rounded-lg bg-slate-50 flex items-center justify-between">
                    <span className="truncate text-slate-600">/upload/{r.token}</span>
                    <span className={`text-[11px] font-bold ${r.used ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {r.used ? 'Used' : 'Unused'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <SubcontractorModal
        open={addSubOpen}
        onClose={() => setAddSubOpen(false)}
        subcontractor={editSub}
        onSaved={() => { showToast('Subcontractor saved'); load() }}
      />
      <RequestCOIModal
        subcontractors={subs}
        open={requestModal}
        onClose={() => setRequestModal(false)}
        initialSubId={requestSubId}
        onSuccess={() => { showToast('Upload link created'); load() }}
      />
      {addCoiOpen && <AddCOIModal
        subcontractor={addCoiSub}
        onClose={() => setAddCoiOpen(false)}
        onSaved={() => { showToast('COI uploaded — pending review. Open its subcontractor and select Review fields.'); load() }}
      />}
      <COIReviewModal
        coi={reviewCoi}
        open={Boolean(reviewCoi)}
        onClose={() => setReviewCoi(null)}
        onUpdated={() => { showToast('Status updated'); load(); setReviewCoi(null) }}
        gcSettings={gcSettings}
      />
      {viewingCertificate && <CertificateViewer certificate={viewingCertificate} onClose={() => setViewingCertificate(null)} returnLabel="Back to subcontractors" />}
      {fieldsReview && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 sm:p-6">
          <div role="dialog" aria-modal="true" aria-label="Review certificate fields" className="mx-auto my-4 w-full max-w-6xl rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-8">
            {fieldsReview.sourceTag && !fieldsReview.coi.simulated_carrier_connect && (
              <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
                <span className="text-xs text-slate-500">If the link expires, return here and open the certificate again.</span>
                <button type="button" disabled={fieldsReview.saving || fieldsReview.openingOriginal || fieldsReview.conflicted} onClick={() => void openFieldsOriginal()} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {fieldsReview.openingOriginal ? 'Refreshing link…' : 'View certificate file'} <FileText className="h-4 w-4" />
                </button>
              </div>
            )}
            {fieldsReview.loading ? (
              <div className="flex items-center justify-between gap-4">
                <p role="status" className="text-sm text-slate-600">Loading document fields…</p>
                <button type="button" onClick={() => closeFieldsReview()} className="rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">Close</button>
              </div>
            ) : fieldsReview.details ? (
              <>
                {fieldsReview.wasEmpty && fieldsReview.editable && <p role="status" className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">No structured fields have been saved for this certificate yet. Enter only information shown on the document.</p>}
                <CoiFieldsReview
                  details={fieldsReview.details}
                  onChange={(details) => setFieldsReview((current) => current && current.editable && !current.saving && !fieldsSaving.current ? { ...current, details } : current)}
                  onSave={() => void saveFieldsReview()}
                  onClose={() => closeFieldsReview()}
                  saving={fieldsReview.saving || fieldsReview.openingOriginal}
                  editable={fieldsReview.editable}
                  error={fieldsReview.error}
                />
              </>
            ) : (
              <div className="space-y-4">
                <h2 className="text-lg font-bold text-slate-900">Document fields</h2>
                {fieldsReview.error ? <p role="alert" className="text-sm text-rose-700">{fieldsReview.error}</p> : <p role="status" className="text-sm text-slate-600">No structured fields have been saved for this certificate yet. Only its owner can add them.</p>}
                <div className="flex gap-2">
                  <button type="button" onClick={() => closeFieldsReview()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Close</button>
                  {fieldsReview.error && <button type="button" onClick={() => void openFieldsReview(fieldsReview.coi)} className="rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-800">Retry</button>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
