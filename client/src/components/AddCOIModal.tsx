import { Button } from '../components/Button'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Upload, Shield } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiCOIs, apiSubcontractors } from '../api'

interface Props {
  subcontractor: Subcontractor | null
  onClose: () => void
  onSaved: () => void
  onAddSub?: () => void
}

const EMPTY_COVERAGES = [
  { type: 'General Liability', per: '', agg: '', ai: false, wos: false },
  { type: 'Automobile Liability', per: '', agg: '', ai: false, wos: false },
  { type: "Workers' Compensation", per: '', agg: '', ai: false, wos: false },
  { type: 'Umbrella Liability', per: '', agg: '', ai: false, wos: false },
]

const MAX_FILE_BYTES = 25 * 1024 * 1024

// Mounted only while open, so each upload starts with a clean form.
export function AddCOIModal({ subcontractor, onClose, onSaved, onAddSub }: Props) {
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const [subId, setSubId] = useState(subcontractor?.id || '')
  const [loadingSubs, setLoadingSubs] = useState(true)
  const [subError, setSubError] = useState<string | null>(null)
  const [carrier, setCarrier] = useState('')
  const [amBest, setAmBest] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [effective, setEffective] = useState('')
  const [expiration, setExpiration] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [coverages, setCoverages] = useState(EMPTY_COVERAGES)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    // Do not use the page's filtered list: the server returns only this GC's connections.
    apiSubcontractors.list().then((res) => {
      if (active) {
        setSubs(res.subcontractors)
        if (res.subcontractors.length === 1 && !subId) {
          setSubId(res.subcontractors[0].id)
        }
      }
    }).catch((err: unknown) => {
      if (active) setSubError(err instanceof Error ? err.message : 'Unable to load subcontractors.')
    }).finally(() => {
      if (active) setLoadingSubs(false)
    })
    return () => { active = false }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (subId && !subs.some((s) => s.id === subId)) {
      setError('Select one of your subcontractors.')
      return
    }
    if (!file) {
      setError('Choose a certificate file to upload.')
      return
    }
    if (
      !/\.(pdf|png|jpe?g|heic|heif)$/i.test(file.name) &&
      !['application/pdf', 'image/png', 'image/jpeg', 'image/heic'].includes(file.type)
    ) {
      setError('Choose a PDF, JPEG, PNG, or HEIC file.')
      return
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError('The certificate must be non-empty and no larger than 25 MB.')
      return
    }
    if (effective && expiration && effective > expiration) {
      setError('Effective date must be on or before expiration date.')
      return
    }
    setLoading(true)
    try {
      const fd = new FormData()
      if (subId) fd.append('subcontractor_id', subId)
      fd.append('carrier', carrier.trim() || 'Not provided')
      fd.append('am_best_rating', amBest.trim())
      fd.append('policy_number', policyNumber.trim())
      fd.append('effective_date', effective)
      fd.append('expiration_date', expiration)
      fd.append('status', 'pending_review')
      fd.append('coverages', JSON.stringify(coverages
        .filter((c) => c.per.trim() || c.agg.trim() || c.ai || c.wos)
        .map((c) => ({
          type: c.type,
          per_occurrence_limit: c.per.trim(),
          aggregate_limit: c.agg.trim(),
          additional_insured: c.ai,
          waiver_of_subrogation: c.wos,
        }))))
      fd.append('certificate', file)
      await apiCOIs.create(fd)
      onSaved()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to upload the certificate. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="upload-coi-title" className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Shield className="w-3.5 h-3.5" /> Certificate of Insurance
            </div>
            <h2 id="upload-coi-title" className="text-xl font-extrabold text-slate-900 mt-1">Upload COI</h2>
            <p className="text-xs text-slate-500 mt-1">
              Upload a certificate you collected. AI extracts carrier, policy number, dates, and limits automatically in the background — details remain pending manual review until validated.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={loading} aria-label="Close" className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && <div role="alert" className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}
        {subError && <div role="alert" className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">Unable to load subcontractors: {subError}. Close and try again.</div>}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div className="text-xs">
            <label htmlFor="coi-subcontractor" className="block font-semibold text-slate-700 mb-1">Subcontractor (optional)</label>
            <select
              id="coi-subcontractor"
              value={subId}
              onChange={(e) => setSubId(e.target.value)}
              disabled={loadingSubs || !!subError || loading}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">{loadingSubs ? 'Loading subcontractors…' : (subs.length === 0 ? '— Auto-detect from certificate (AI will create the subcontractor) —' : '— Auto-detect from certificate (or pick a subcontractor) —')}</option>
              {subs.map((s) => <option key={s.id} value={s.id}>{s.company_name} — {s.trade}</option>)}
            </select>
            {!loadingSubs && !subError && subs.length === 0 && (
              <div className="mt-2 p-3 rounded-xl bg-amber-50 text-amber-800 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 border border-amber-200">
                <span>No subcontractors yet. Leave blank and AI will read the insured company name to create one automatically, or add one first.</span>
                {onAddSub ? (
                  <button type="button" onClick={() => { onClose(); onAddSub() }} className="font-semibold underline whitespace-nowrap">
                    Add a subcontractor
                  </button>
                ) : (
                  <Link to="/subcontractors" onClick={onClose} className="font-semibold underline whitespace-nowrap">
                    Go to Subcontractors
                  </Link>
                )}
              </div>
            )}
            {!loadingSubs && subId && !subs.some((s) => s.id === subId) && (
              <p className="mt-1 text-rose-700">This subcontractor is no longer available. Select another.</p>
            )}
          </div>

          <div>
            <label htmlFor="coi-file" className="block text-xs font-semibold text-slate-700 mb-1">Certificate file *</label>
            <label htmlFor="coi-file" className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-2xl cursor-pointer bg-slate-50 hover:bg-brand-50/30 transition text-center text-xs">
              <Upload className="w-5 h-5 text-slate-400 mb-1" />
              <span className="font-semibold text-slate-700">{file ? file.name : 'Choose a certificate file'}</span>
              <span className="text-[11px] text-slate-400">PDF, JPEG, PNG, or HEIC up to 25 MB</span>
            </label>
            <input
              id="coi-file"
              type="file"
              required
              accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,application/pdf,image/png,image/jpeg,image/heic"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-2 block w-full text-xs text-slate-600"
            />
          </div>

          <details className="group rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs">
            <summary className="cursor-pointer font-bold text-slate-800 list-none flex items-center justify-between select-none">
              <span>Enter details manually (optional)</span>
              <span className="text-[11px] font-normal text-slate-500">Leave blank to let AI extract them</span>
            </summary>
            <p className="text-[11px] text-slate-500 mt-2 mb-3">
              Only the certificate file is required. Any details you enter here will be saved right away; blank fields get filled in automatically from the document.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="coi-carrier" className="block font-semibold text-slate-700 mb-1">Insurance carrier</label>
                <input
                  id="coi-carrier"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  placeholder="e.g., Travelers"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-rating" className="block font-semibold text-slate-700 mb-1">AM Best rating</label>
                <input
                  id="coi-rating"
                  value={amBest}
                  onChange={(e) => setAmBest(e.target.value)}
                  placeholder="e.g., A Excellent"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-policy" className="block font-semibold text-slate-700 mb-1">Policy number</label>
                <input
                  id="coi-policy"
                  value={policyNumber}
                  onChange={(e) => setPolicyNumber(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-['JetBrains_Mono']"
                />
              </div>
              <div>
                <label htmlFor="coi-effective" className="block font-semibold text-slate-700 mb-1">Effective date</label>
                <input
                  id="coi-effective"
                  type="date"
                  value={effective}
                  onChange={(e) => setEffective(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-expiration" className="block font-semibold text-slate-700 mb-1">Expiration date</label>
                <input
                  id="coi-expiration"
                  type="date"
                  value={expiration}
                  onChange={(e) => setExpiration(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-200">
              <div className="font-bold text-slate-700 mb-1">Coverage lines (optional)</div>
              <p className="text-[11px] text-slate-500 mb-2">Only enter details shown on the certificate.</p>
              <div className="space-y-2 text-xs">
                {coverages.map((c, i) => (
                  <div key={c.type} className="p-3 rounded-xl bg-white border border-slate-200">
                    <div className="font-bold text-slate-900 mb-1">{c.type}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        aria-label={`${c.type} per occurrence`}
                        value={c.per}
                        onChange={(e) => {
                          const next = [...coverages]
                          next[i] = { ...next[i], per: e.target.value }
                          setCoverages(next)
                        }}
                        placeholder="Per occurrence"
                        className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs"
                      />
                      <input
                        aria-label={`${c.type} aggregate`}
                        value={c.agg}
                        onChange={(e) => {
                          const next = [...coverages]
                          next[i] = { ...next[i], agg: e.target.value }
                          setCoverages(next)
                        }}
                        placeholder="Aggregate"
                        className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs"
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px]">
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={c.ai}
                          onChange={(e) => {
                            const next = [...coverages]
                            next[i] = { ...next[i], ai: e.target.checked }
                            setCoverages(next)
                          }}
                        />{' '}
                        Additional Insured
                      </label>
                      <label className="inline-flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={c.wos}
                          onChange={(e) => {
                            const next = [...coverages]
                            next[i] = { ...next[i], wos: e.target.checked }
                            setCoverages(next)
                          }}
                        />{' '}
                        Waiver of Subrogation
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || loadingSubs || !!subError || !file}
            >
              {loading ? 'Uploading…' : 'Upload COI'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
