import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import confetti from 'canvas-confetti'
import { Shield, Upload, CheckCircle2, AlertCircle, FileText, ArrowRight, ArrowLeft } from 'lucide-react'
import type { UploadValidationPayload, COI } from '../types'
import { apiUploadPortal } from '../api'

const DEFAULT_COVERAGES = [
  { type: 'General Liability', per: '$1,000,000', agg: '$2,000,000', ai: true, wos: true },
  { type: 'Automobile Liability', per: '$1,000,000', agg: '$1,000,000', ai: true, wos: false },
  { type: 'Workers\' Compensation', per: 'Statutory', agg: 'Statutory', ai: false, wos: true },
  { type: 'Umbrella Liability', per: '$5,000,000', agg: '$5,000,000', ai: true, wos: false },
]

export function UploadPortalPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<UploadValidationPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(1)

  // policy
  const [carrier, setCarrier] = useState('')
  const [amBest, setAmBest] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [effective, setEffective] = useState(new Date().toISOString().slice(0, 10))
  const [expiration, setExpiration] = useState(() => {
    const d = new Date()
    d.setFullYear(d.getFullYear() + 1)
    return d.toISOString().slice(0, 10)
  })
  const [coverages, setCoverages] = useState(DEFAULT_COVERAGES)
  const [file, setFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState<COI | null>(null)
  const [myHistory, setMyHistory] = useState<COI[] | null>(null)

  useEffect(() => {
    if (!token) return
    apiUploadPortal.validate(token)
      .then((payload) => {
        setData(payload)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

  const submit = async () => {
    if (!token || !carrier.trim()) return
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('carrier', carrier.trim())
      fd.append('am_best_rating', amBest.trim())
      fd.append('policy_number', policyNumber.trim())
      fd.append('effective_date', effective)
      fd.append('expiration_date', expiration)
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
      const res = await apiUploadPortal.submit(token, fd)
      setSubmitted(res.coi)
      confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const loadHistory = async () => {
    if (!token) return
    const res = await apiUploadPortal.myCOIs(token)
    setMyHistory(res.cois)
  }

  if (loading) return <div className="max-w-md mx-auto px-4 py-16 text-center text-xs text-slate-400">Verifying link…</div>
  if (error || !data) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-700 flex items-center justify-center mx-auto text-xl font-bold">!</div>
        <h2 className="text-xl font-extrabold text-slate-900 mt-4">Invalid upload link</h2>
        <p className="text-xs text-slate-500 mt-2">{error || 'This link may have expired or is not valid.'}</p>
        <p className="text-xs text-slate-400 mt-4">Please contact {data?.gc.company_name || 'your general contractor'} for a new link.</p>
      </div>
    )
  }

  const { subcontractor, gc, request } = data

  const reqCoverages = [
    { label: 'General Liability', req: gc.required_gl_limit || '$1M/$2M' },
    { label: 'Auto Liability', req: gc.required_auto_limit || '$1M' },
    { label: 'Workers\' Comp', req: gc.required_wc_limit || 'Statutory' },
    { label: 'Umbrella / Excess', req: gc.required_umbrella_limit || '$5M' },
  ]

  return (
    <div className="min-h-screen bg-slate-50 py-10">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-brand-50 text-brand-700 border border-brand-200">
            <FileText className="w-3.5 h-3.5" /> Certificate of Insurance Self-Service
          </div>
          <h1 className="text-3xl font-extrabold text-slate-900 mt-3">Upload your COI</h1>
          <p className="text-xs text-slate-500 mt-1">
            Requested by <strong>{gc.company_name}</strong> · four quick steps, about 2 minutes
          </p>
          <p className="text-[11px] text-emerald-700 font-mono mt-1">
            Free for your first month — no payment information required
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 text-xs font-semibold">
          {['1 · Company details', '2 · Policy info', '3 · Certificate file', '4 · Review & submit'].map((l, i) => (
            <span
              key={l}
              className={`px-3 py-1.5 rounded-full ${
                step === i + 1 ? 'bg-brand-600 text-white' : i + 1 < step ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-500'
              }`}
            >
              {l}
            </span>
          ))}
        </div>

        {/* Success screen */}
        {submitted ? (
          <div className="bg-white rounded-3xl p-8 sm:p-12 border border-slate-200 shadow-card text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto text-2xl font-bold">✓</div>
            <h2 className="text-2xl font-extrabold text-slate-900">Certificate submitted — thank you!</h2>
            <p className="text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
              We received your COI (carrier: <strong>{carrier}</strong>, policy #{policyNumber || 'n/a'}). The <strong>{gc.company_name}</strong> compliance team will review coverage limits and confirm — no further action needed from you.
            </p>
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 max-w-md mx-auto font-['JetBrains_Mono']">
              Expiration on file: {expiration} · status: pending GC review
            </div>
            <div className="pt-2">
              <button
                onClick={loadHistory}
                className="text-xs font-bold text-brand-600 hover:underline"
              >
                View all submissions from {subcontractor.company_name} →
              </button>
            </div>
            {myHistory && (
              <div className="mt-4 text-left divide-y divide-slate-100 border rounded-2xl border-slate-200 overflow-hidden text-xs">
                {myHistory.map((c) => (
                  <div key={c.id} className="p-3 flex justify-between">
                    <div>
                      <div className="font-bold">{c.carrier} · #{c.policy_number}</div>
                      <div className="text-[11px] text-slate-400">{c.effective_date} → {c.expiration_date}</div>
                    </div>
                    <span className="font-semibold text-slate-600">{c.simulated_carrier_connect ? 'Simulated — not verified' : c.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Wizard */}
            <div className="md:col-span-2 bg-white rounded-3xl p-7 border border-slate-200 shadow-card">
              {/* STEP 1 */}
              {step === 1 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Company details</h2>
                    <p className="text-xs text-slate-500">These details are shown for reference only. This upload link saves certificate information, not subcontractor profile or contact changes.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Company name</label>
                      <input readOnly value={subcontractor.company_name} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-slate-100 text-slate-600" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Trade</label>
                      <input readOnly value={subcontractor.trade} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-slate-100 text-slate-600" />
                    </div>
                  </div>
                  <div className="flex justify-end pt-2">
                    <button onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700">
                      Next: policy info <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 2 */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Policy information</h2>
                    <p className="text-xs text-slate-500">Copy values from the top-middle section of your ACORD certificate.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="sm:col-span-2">
                      <label className="block font-semibold text-slate-700 mb-1">Insurance carrier *</label>
                      <input required value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. Liberty Mutual, Travelers" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-semibold" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">AM Best rating</label>
                      <input value={amBest} onChange={(e) => setAmBest(e.target.value)} placeholder="A (Excellent)" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Policy number</label>
                      <input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} placeholder="LM-GL-2025-44912" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Effective date *</label>
                      <input type="date" required value={effective} onChange={(e) => setEffective(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Expiration date *</label>
                      <input type="date" required value={expiration} onChange={(e) => setExpiration(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-bold" />
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-slate-700 mb-2">Coverage lines (adjust to match your certificate)</div>
                    <div className="space-y-2 text-xs">
                      {coverages.map((c, i) => (
                        <div key={c.type} className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                          <div className="font-bold text-slate-900 mb-1">{c.type}</div>
                          <div className="grid grid-cols-2 gap-2">
                            <input value={c.per} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], per: e.target.value }; setCoverages(next) }} placeholder="Per occurrence" className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs" />
                            <input value={c.agg} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], agg: e.target.value }; setCoverages(next) }} placeholder="Aggregate" className="rounded-lg border border-slate-300 px-2 py-1 bg-white text-xs" />
                          </div>
                          <div className="mt-2 flex items-center gap-4 text-[11px]">
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                              <input type="checkbox" checked={c.ai} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], ai: e.target.checked }; setCoverages(next) }} />
                              <span>Additional Insured</span>
                            </label>
                            <label className="inline-flex items-center gap-1 cursor-pointer">
                              <input type="checkbox" checked={c.wos} onChange={(e) => { const next = [...coverages]; next[i] = { ...next[i], wos: e.target.checked }; setCoverages(next) }} />
                              <span>Waiver of Subrogation</span>
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-between pt-2">
                    <button onClick={() => setStep(1)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                      <ArrowLeft className="w-3.5 h-3.5" /> Back
                    </button>
                    <button disabled={!carrier.trim()} onClick={() => setStep(3)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50">
                      Next: certificate file <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3 */}
              {step === 3 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Attach certificate of insurance</h2>
                    <p className="text-xs text-slate-500">PDF, PNG, JPG up to 25MB — endorsement pages included in one file are fine.</p>
                  </div>
                  <label className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-slate-300 hover:border-brand-500 rounded-2xl cursor-pointer bg-slate-50 hover:bg-brand-50/30 transition text-center text-xs">
                    <Upload className="w-8 h-8 text-slate-400 mb-2" />
                    <span className="font-semibold text-slate-700">
                      {file ? file.name : 'Drag & drop or tap to choose file'}
                    </span>
                    <span className="text-[11px] text-slate-400 mt-1">ACORD certificate PDF / photo</span>
                    <input type="file" accept=".pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="hidden" />
                  </label>
                  <div className="flex justify-between pt-2">
                    <button onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                      <ArrowLeft className="w-3.5 h-3.5" /> Back
                    </button>
                    <button onClick={() => setStep(4)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700">
                      Next: review <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 4 */}
              {step === 4 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Review & submit</h2>
                    <p className="text-xs text-slate-500">Double check before submitting. You'll receive a confirmation email.</p>
                  </div>
                  <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 overflow-hidden text-xs">
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Company</span><span className="font-bold">{subcontractor.company_name}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Carrier / Policy</span><span>{carrier} · {policyNumber || '—'}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Period</span><span className="font-['JetBrains_Mono']">{effective} → {expiration}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">File attached</span><span>{file ? file.name : 'None (you can still submit)'}</span></div>
                  </div>
                  <div className="flex justify-between pt-2">
                    <button onClick={() => setStep(3)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100">
                      <ArrowLeft className="w-3.5 h-3.5" /> Back
                    </button>
                    <button disabled={submitting} onClick={submit} className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50">
                      <CheckCircle2 className="w-3.5 h-3.5" /> {submitting ? 'Submitting…' : 'Submit certificate'}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* GC requirements sidebar */}
            <div className="space-y-4">
              <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-card text-xs space-y-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
                  Required coverages
                </div>
                <div className="font-bold text-slate-900">{gc.company_name} project standard</div>
                <div className="space-y-1.5 text-slate-600">
                  {reqCoverages.map((r) => (
                    <div key={r.label}>• {r.label}: <strong>{r.req}</strong></div>
                  ))}
                </div>
                <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                  Renewal reminders begin {gc.expiration_warning_days} days before policy expiration.
                </div>
              </div>

              {gc.additional_insured_wording && (
                <div className="bg-amber-50 rounded-3xl p-6 border border-amber-200 text-xs space-y-2 text-amber-950">
                  <div className="font-bold flex items-center gap-1">
                    <AlertCircle className="w-4 h-4 text-amber-700" /> Additional insured wording
                  </div>
                  <p className="text-[11px] text-amber-900/90 leading-relaxed font-['JetBrains_Mono']">
                    {gc.additional_insured_wording}
                  </p>
                </div>
              )}

              <div className="text-center text-[11px] text-slate-400">
                Questions? {gc.email && <a href={`mailto:${gc.email}`} className="underline">{gc.email}</a>}
                {gc.phone && <span> · {gc.phone}</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
