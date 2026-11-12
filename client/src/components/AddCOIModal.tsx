import { useEffect, useState } from 'react'
import { X, Upload, Shield } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiCOIs, apiSubcontractors } from '../api'

interface Props {
  subcontractor: Subcontractor | null
  onClose: () => void
  onSaved: () => void
}

const EMPTY_COVERAGES = [
  { type: 'General Liability', per: '', agg: '', ai: false, wos: false },
  { type: 'Automobile Liability', per: '', agg: '', ai: false, wos: false },
  { type: 'Workers\' Compensation', per: '', agg: '', ai: false, wos: false },
  { type: 'Umbrella Liability', per: '', agg: '', ai: false, wos: false },
]
const MAX_FILE_BYTES = 25 * 1024 * 1024

// Mounted only while open, so each upload starts with a clean form.
export function AddCOIModal({ subcontractor, onClose, onSaved }: Props) {
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
      if (active) setSubs(res.subcontractors)
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
    if (!subs.some((s) => s.id === subId)) {
      setError('Select one of your subcontractors.')
      return
    }
    if (!carrier.trim() || !effective || !expiration) {
      setError('Enter the carrier and policy dates shown on the certificate.')
      return
    }
    if (!file) {
      setError('Choose a certificate file to upload.')
      return
    }
    if (!/\.(pdf|png|jpe?g)$/i.test(file.name) && !['application/pdf', 'image/png', 'image/jpeg'].includes(file.type)) {
      setError('Choose a PDF, JPEG, or PNG file.')
      return
    }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      setError('The certificate must be non-empty and no larger than 25 MB.')
      return
    }
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('subcontractor_id', subId)
      fd.append('carrier', carrier.trim())
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
            <p className="text-xs text-slate-500 mt-1">Upload a certificate you already collected. It will be pending manual review, not verified.</p>
          </div>
          <button type="button" onClick={onClose} disabled={loading} aria-label="Close" className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && <div role="alert" className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}
        {subError && <div role="alert" className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">Unable to load subcontractors: {subError}. Close and try again.</div>}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div className="text-xs">
            <label htmlFor="coi-subcontractor" className="block font-semibold text-slate-700 mb-1">Subcontractor *</label>
            <select id="coi-subcontractor" required value={subId} onChange={(e) => setSubId(e.target.value)} disabled={loadingSubs || !!subError || loading} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500">
              <option value="">{loadingSubs ? 'Loading subcontractors…' : 'Select a subcontractor'}</option>
              {subs.map((s) => <option key={s.id} value={s.id}>{s.company_name} — {s.trade}</option>)}
            </select>
            {!loadingSubs && !subError && subs.length === 0 && <p className="mt-1 text-slate-500">No subcontractors found. Add a subcontractor first.</p>}
            {!loadingSubs && subId && !subs.some((s) => s.id === subId) && <p className="mt-1 text-rose-700">This subcontractor is no longer available. Select another.</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="sm:col-span-2">
              <label htmlFor="coi-carrier" className="block font-semibold text-slate-700 mb-1">Insurance carrier *</label>
              <input id="coi-carrier" required value={carrier} onChange={(e) => setCarrier(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="coi-rating" className="block font-semibold text-slate-700 mb-1">AM Best rating</label>
              <input id="coi-rating" value={amBest} onChange={(e) => setAmBest(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="coi-policy" className="block font-semibold text-slate-700 mb-1">Policy number</label>
              <input id="coi-policy" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-['JetBrains_Mono']" />
            </div>
            <div>
              <label htmlFor="coi-effective" className="block font-semibold text-slate-700 mb-1">Effective date *</label>
              <input id="coi-effective" type="date" required value={effective} onChange={(e) => setEffective(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="coi-expiration" className="block font-semibold text-slate-700 mb-1">Expiration date *</label>
              <input id="coi-expiration" type="date" required value={expiration} onChange={(e) => setExpiration(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
          </div>

          <div>
            <label htmlFor="coi-file" className="block text-xs font-semibold text-slate-700 mb-1">Certificate file *</label>
            <label htmlFor="coi-file" className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-2xl cursor-pointer bg-slate-50 hover:bg-brand-50/30 transition text-center text-xs">
              <Upload className="w-5 h-5 text-slate-400 mb-1" />
              <span className="font-semibold text-slate-700">{file ? file.name : 'Choose a certificate file'}</span>
              <span className="text-[11px] text-slate-400">PDF, JPEG, or PNG up to 25 MB</span>
            </label>
            <input id="coi-file" type="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] || null)} className="mt-2 block w-full text-xs text-slate-600" />
          </div>

          <div>
            <div className="text-xs font-bold text-slate-700 mb-1">Coverage lines (optional)</div>
            <p className="text-xs text-slate-500 mb-2">Only enter details shown on the certificate.</p>
            <div className="space-y-2 text-xs">
              {coverages.map((c, i) => (
                <div key={c.type} className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="font-bold text-slate-900 mb-1">{c.type}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input aria-label={`${c.type} per occurrence`} value={c.per} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], per: e.target.value }; setCoverages(next) }} placeholder="Per occurrence" className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs" />
                    <input aria-label={`${c.type} aggregate`} value={c.agg} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], agg: e.target.value }; setCoverages(next) }} placeholder="Aggregate" className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px]">
                    <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={c.ai} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], ai: e.target.checked }; setCoverages(next) }} /> Additional Insured</label>
                    <label className="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={c.wos} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], wos: e.target.checked }; setCoverages(next) }} /> Waiver of Subrogation</label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={loading} className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={loading || loadingSubs || !!subError || subs.length === 0} className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-60 transition shadow-sm">{loading ? 'Uploading…' : 'Upload COI'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
