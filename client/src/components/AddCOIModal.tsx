import { Button } from '../components/Button'
import { useEffect, useRef, useState } from 'react'
import { X, Upload, Shield, Camera, FileText, Check } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiCOIs } from '../api'

interface Props {
  subcontractor?: Subcontractor | null
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
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.heic,.heif,.avif,.webp,application/pdf,image/png,image/jpeg,image/heic,image/heif,image/webp,image/*'

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

export function AddCOIModal({ subcontractor, onClose, onSaved }: Props) {
  const [subId, setSubId] = useState(subcontractor?.id || '')
  const [carrier, setCarrier] = useState('')
  const [amBest, setAmBest] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [effective, setEffective] = useState('')
  const [expiration, setExpiration] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [coverages, setCoverages] = useState(EMPTY_COVERAGES)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setSubId(subcontractor?.id || '')
  }, [subcontractor?.id])

  const handlePickedFile = (f: File | null) => {
    if (!f) return
    setError(null)
    if (
      !/\.(pdf|png|jpe?g|heic|heif|avif|webp)$/i.test(f.name) &&
      ![
        'application/pdf',
        'image/png',
        'image/jpeg',
        'image/heic',
        'image/heif',
        'image/heic-sequence',
        'image/avif',
        'image/webp',
      ].includes(f.type)
    ) {
      setError('Choose a PDF, JPEG, PNG, HEIC, or WebP file.')
      return
    }
    if (f.size === 0 || f.size > MAX_FILE_BYTES) {
      setError('The certificate must be non-empty and no larger than 25 MB.')
      return
    }
    setFile(f)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!file) {
      setError('Choose a certificate file to upload.')
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
      fd.append(
        'coverages',
        JSON.stringify(
          coverages
            .filter((c) => c.per.trim() || c.agg.trim() || c.ai || c.wos)
            .map((c) => ({
              type: c.type,
              per_occurrence_limit: c.per.trim(),
              aggregate_limit: c.agg.trim(),
              additional_insured: c.ai,
              waiver_of_subrogation: c.wos,
            })),
        ),
      )
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-coi-title"
        className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Shield className="w-3.5 h-3.5" /> Certificate of Insurance
            </div>
            <h2 id="upload-coi-title" className="text-xl font-extrabold text-slate-900 mt-1">
              Upload COI
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Upload or photograph the certificate you collected. AI reads the insured company, carrier, policy number,
              dates, and limits automatically in the background — details remain pending manual review until validated.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
            className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div role="alert" className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* File acquisition: upload or photo */}
          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-2">Certificate file *</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT}
              onChange={(e) => {
                handlePickedFile(e.target.files?.[0] || null)
                e.target.value = ''
              }}
              className="hidden"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => {
                handlePickedFile(e.target.files?.[0] || null)
                e.target.value = ''
              }}
              className="hidden"
            />

            {!file ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed border-slate-300 hover:border-brand-500 hover:bg-brand-50/40 rounded-2xl bg-slate-50 transition text-center cursor-pointer group"
                >
                  <div className="w-11 h-11 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center group-hover:scale-105 transition">
                    <Upload className="w-5 h-5" />
                  </div>
                  <span className="font-bold text-xs text-slate-800">Choose a file</span>
                  <span className="text-[11px] text-slate-400">PDF, JPEG, PNG, or HEIC up to 25 MB</span>
                </button>
                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed border-slate-300 hover:border-brand-500 hover:bg-brand-50/40 rounded-2xl bg-slate-50 transition text-center cursor-pointer group"
                >
                  <div className="w-11 h-11 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center group-hover:scale-105 transition">
                    <Camera className="w-5 h-5" />
                  </div>
                  <span className="font-bold text-xs text-slate-800">Take a photo</span>
                  <span className="text-[11px] text-slate-400">Use your device camera to capture the page</span>
                </button>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl border border-emerald-200 bg-emerald-50/60">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 text-xs">
                    <div className="font-bold text-slate-900 truncate">{file.name}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {formatBytes(file.size)}
                      {file.type ? ` · ${file.type.split('/')[1]?.toUpperCase()}` : ''}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full">
                    <Check className="w-3 h-3" /> Ready
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs font-semibold text-brand-600 hover:text-brand-700 underline"
                  >
                    Change
                  </button>
                </div>
              </div>
            )}
          </div>

          <details className="group rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs">
            <summary className="cursor-pointer font-bold text-slate-800 list-none flex items-center justify-between select-none">
              <span>Enter details manually (optional)</span>
              <span className="text-[11px] font-normal text-slate-500">Leave blank to let AI extract them</span>
            </summary>
            <p className="text-[11px] text-slate-500 mt-2 mb-3">
              Only the certificate file is required. Any details you enter here will be saved right away; blank fields
              get filled in automatically from the document.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="coi-carrier" className="block font-semibold text-slate-700 mb-1">
                  Insurance carrier
                </label>
                <input
                  id="coi-carrier"
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  placeholder="e.g., Travelers"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-rating" className="block font-semibold text-slate-700 mb-1">
                  AM Best rating
                </label>
                <input
                  id="coi-rating"
                  value={amBest}
                  onChange={(e) => setAmBest(e.target.value)}
                  placeholder="e.g., A Excellent"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-policy" className="block font-semibold text-slate-700 mb-1">
                  Policy number
                </label>
                <input
                  id="coi-policy"
                  value={policyNumber}
                  onChange={(e) => setPolicyNumber(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500 font-['JetBrains_Mono']"
                />
              </div>
              <div>
                <label htmlFor="coi-effective" className="block font-semibold text-slate-700 mb-1">
                  Effective date
                </label>
                <input
                  id="coi-effective"
                  type="date"
                  value={effective}
                  onChange={(e) => setEffective(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label htmlFor="coi-expiration" className="block font-semibold text-slate-700 mb-1">
                  Expiration date
                </label>
                <input
                  id="coi-expiration"
                  type="date"
                  value={expiration}
                  onChange={(e) => setExpiration(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
            <div className="mt-4 border-t border-slate-200 pt-3">
              <div className="font-semibold text-slate-800 mb-2">Coverage lines (optional)</div>
              <p className="text-[11px] text-slate-500 mb-2">Only enter details shown on the certificate.</p>
              <div className="space-y-2 text-xs">
                {coverages.map((c, i) => (
                  <div key={c.type} className="p-3 rounded-xl bg-white border border-slate-200">
                    <div className="font-semibold text-slate-800 text-xs mb-2">{c.type}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
            <Button type="submit" variant="primary" disabled={loading || !file}>
              {loading ? 'Uploading…' : 'Upload COI'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
