import { useEffect, useState } from 'react'
import { X, CheckCircle2, FileQuestion, Ban, FileText, ShieldCheck } from 'lucide-react'
import type { COI, GCSettings } from '../types'
import { apiCOIs } from '../api'
import { CertificateViewer } from './CertificateViewer'

interface Props {
  coi: COI | null
  open: boolean
  onClose: () => void
  onUpdated: () => void
  gcSettings?: GCSettings
}

export function COIReviewModal({ coi, open, onClose, onUpdated, gcSettings }: Props) {
  const [notes, setNotes] = useState(coi?.reviewer_notes || '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewingCertificate, setViewingCertificate] = useState(false)

  useEffect(() => {
    if (!open) setViewingCertificate(false)
  }, [open])

  if (!open || !coi) return null

  const applyStatus = async (status: string) => {
    setLoading(true)
    setError(null)
    try {
      await apiCOIs.review(coi.id, { status, reviewer_notes: notes })
      onUpdated()
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const reqCoverages = [
    { label: 'General Liability', req: gcSettings?.required_gl_limit || '$1M/$2M' },
    { label: 'Auto Liability', req: gcSettings?.required_auto_limit || '$1M' },
    { label: 'Workers\' Comp', req: gcSettings?.required_wc_limit || 'Statutory' },
    { label: 'Umbrella / Excess', req: gcSettings?.required_umbrella_limit || '$5M' },
  ]

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-xl w-full p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <ShieldCheck className="w-3.5 h-3.5" /> COI verification
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-1">Review certificate</h2>
            <p className="text-xs text-slate-500 mt-1">
              {coi.company_name} — {coi.trade || 'subcontractor'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}

        {/* Policy summary */}
        <div className="mt-5 grid grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-xl bg-slate-50">
            <div className="text-slate-400">Insurance carrier</div>
            <div className="font-bold text-slate-900 mt-0.5">{coi.carrier}</div>
            <div className="text-slate-500 text-[11px] mt-0.5">AM Best: {coi.am_best_rating || 'n/a'}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-50">
            <div className="text-slate-400">Policy number</div>
            <div className="font-bold text-slate-900 mt-0.5 font-['JetBrains_Mono']">{coi.policy_number || 'n/a'}</div>
            <div className="text-slate-500 text-[11px] mt-0.5">
              {coi.effective_date} → {coi.expiration_date}
            </div>
          </div>
        </div>

        {/* Document attachment */}
        {coi.certificate_url && (
          <div className="mt-3 p-3 rounded-xl bg-brand-50 border border-brand-200 flex items-center justify-between text-xs">
            <div>
              <div className="font-bold text-brand-900">Certificate document</div>
              <div className="text-brand-800/80 text-[11px]">
                {coi.certificate_name || 'Uploaded COI'}
                {coi.certificate_size ? ` · ${(coi.certificate_size / 1024 / 1024).toFixed(1)} MB` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setViewingCertificate(true)}
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:text-brand-900 underline"
            >
              Open <FileText className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Coverages table */}
        <div className="mt-4">
          <div className="text-xs font-bold text-slate-700 mb-2">Coverages listed on certificate</div>
          {coi.coverages && coi.coverages.length > 0 ? (
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden text-xs">
              {coi.coverages.map((cv, i) => (
                <div key={i} className="p-3 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-slate-900">{cv.type}</div>
                    <div className="text-[11px] text-slate-500">
                      {cv.per_occurrence_limit && `Per occurrence: ${cv.per_occurrence_limit}`}
                      {cv.aggregate_limit && ` · Agg: ${cv.aggregate_limit}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    {Boolean(cv.additional_insured) && (
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                        Add'l Insured ✓
                      </span>
                    )}
                    {Boolean(cv.waiver_of_subrogation) && (
                      <span className="px-2 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200">
                        Waiver ✓
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">No per-line coverages captured for this COI.</p>
          )}
        </div>

        {/* GC requirements checklist */}
        <div className="mt-4 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <div className="font-bold text-slate-700 mb-1">Your company requirements to verify against</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
            {reqCoverages.map((r) => (
              <div key={r.label}>• {r.label}: {r.req}</div>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-slate-700 mb-1">Reviewer notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="e.g. Limits verified. Endorsement page looks good."
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
          >
            Close
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => applyStatus('rejected')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-300 hover:bg-rose-100 disabled:opacity-60 transition"
          >
            <Ban className="w-3.5 h-3.5" /> Reject
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => applyStatus('needs_revision')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-300 hover:bg-orange-100 disabled:opacity-60 transition"
          >
            <FileQuestion className="w-3.5 h-3.5" /> Request revision
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => applyStatus('compliant')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 transition shadow-sm"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve & mark compliant
          </button>
        </div>
      </div>
      {viewingCertificate && <CertificateViewer certificate={coi} onClose={() => setViewingCertificate(false)} returnLabel="Back to review" />}
    </div>
  )
}
