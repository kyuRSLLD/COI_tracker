import { useState } from 'react'
import { X, Upload, Shield } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiCOIs } from '../api'

interface Props {
  subcontractor: Subcontractor | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}

const DEFAULT_COVERAGES = [
  { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: true, wos: true },
  { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: true, wos: false },
  { type: 'Workers\' Compensation', per: 'Statutory', agg: 'Statutory', ai: false, wos: true },
  { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: true, wos: false },
]

export function AddCOIModal({ subcontractor, open, onClose, onSaved }: Props) {
  const [carrier, setCarrier] = useState('')
  const [amBest, setAmBest] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10))
  const [expiration, setExpiration] = useState(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [file, setFile] = useState<File | null>(null)
  const [coverages, setCoverages] = useState(DEFAULT_COVERAGES)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open || !subcontractor) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!carrier.trim()) return
    setLoading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('subcontractor_id', subcontractor.id)
      fd.append('carrier', carrier.trim())
      fd.append('am_best_rating', amBest.trim())
      fd.append('policy_number', policyNumber.trim())
      fd.append('effective_date', effective)
      fd.append('expiration_date', expiration)
      fd.append('status', 'compliant')
      fd.append(
        'coverages',
        JSON.stringify(
          coverages.map((c) => ({
            type: c.type,
            per_occurrence_limit: c.per,
            aggregate_limit: c.agg,
            additional_insured: c.ai,
            waiver_of_subrogation: c.wos,
          }))
        )
      )
      if (file) fd.append('certificate', file)
      await apiCOIs.create(fd)
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
      <div className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Shield className="w-3.5 h-3.5" /> Certificate of Insurance
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-1">Add COI</h2>
            <p className="text-xs text-slate-500 mt-1">
              For {subcontractor.company_name} — {subcontractor.trade}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="sm:col-span-2">
              <label className="block font-semibold text-slate-700 mb-1">Insurance carrier *</label>
              <input
                required
                value={carrier}
                onChange={(e) => setCarrier(e.target.value)}
                placeholder="e.g. Travelers, Liberty Mutual, The Hartford"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">AM Best rating</label>
              <input
                value={amBest}
                onChange={(e) => setAmBest(e.target.value)}
                placeholder="A+ (Superior)"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Policy number</label>
              <input
                value={policyNumber}
                onChange={(e) => setPolicyNumber(e.target.value)}
                placeholder="TRV-2025-10492"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-['JetBrains_Mono']"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Effective date *</label>
              <input
                type="date"
                required
                value={effective}
                onChange={(e) => setEffective(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Expiration date *</label>
              <input
                type="date"
                required
                value={expiration}
                onChange={(e) => setExpiration(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-bold"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Certificate file (PDF or image)</label>
            <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-2xl cursor-pointer bg-slate-50 hover:bg-brand-50/30 transition text-center text-xs">
              <Upload className="w-5 h-5 text-slate-400 mb-1" />
              <span className="font-semibold text-slate-700">
                {file ? file.name : 'Click to attach ACORD certificate'}
              </span>
              <span className="text-[11px] text-slate-400">PDF, PNG, JPG up to 25MB</span>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
              />
            </label>
          </div>

          <div>
            <div className="text-xs font-bold text-slate-700 mb-2">Coverage lines</div>
            <div className="space-y-2 text-xs">
              {coverages.map((c, i) => (
                <div key={c.type} className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                  <div className="font-bold text-slate-900 mb-1">{c.type}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
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
                  <div className="mt-2 flex items-center gap-4 text-[11px]">
                    <label className="inline-flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={c.ai}
                        onChange={(e) => {
                          const next = [...coverages]
                          next[i] = { ...next[i], ai: e.target.checked }
                          setCoverages(next)
                        }}
                      />
                      <span>Additional Insured</span>
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
                      />
                      <span>Waiver of Subrogation</span>
                    </label>
                  </div>
                </div>
              ))}
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
              {loading ? 'Saving…' : 'Save COI'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
