import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import confetti from 'canvas-confetti'
import { Upload, CheckCircle2, FileText, ArrowRight, ArrowLeft } from 'lucide-react'
import { apiUploadPortal } from '../api'

type UploadInfo = {
  subcontractor: { company_name: string; trade: string | null }
  gc: { company_name: string }
  expiresAt?: string | null
}

const COVERAGE_TYPES = ['General Liability', 'Automobile Liability', 'Workers\' Compensation', 'Umbrella Liability']

export function UploadPortalPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<UploadInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [step, setStep] = useState(1)

  // policy
  const [carrier, setCarrier] = useState('')
  const [amBest, setAmBest] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [effective, setEffective] = useState('')
  const [expiration, setExpiration] = useState('')
  const [coverages, setCoverages] = useState(() => COVERAGE_TYPES.map((type) => ({ type, per: '', agg: '', ai: false, wos: false })))
  const [file, setFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!token) return
    apiUploadPortal.validate(token)
      .then((payload) => {
        // The shared API type still describes the older, broader response.
        const request = payload.request as unknown as { expires_at?: string | null }
        setData({ subcontractor: payload.subcontractor, gc: { company_name: payload.gc.company_name || '' }, expiresAt: request?.expires_at })
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

  const submit = async () => {
    if (!token || !carrier.trim() || !effective || !expiration || submitting) return
    setSubmitting(true)
    setSubmitError(null)
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
          coverages.filter((c) => c.per.trim() || c.agg.trim() || c.ai || c.wos).map((c) => ({
            type: c.type,
            per_occurrence_limit: c.per.trim(),
            aggregate_limit: c.agg.trim(),
            additional_insured: c.ai,
            waiver_of_subrogation: c.wos,
          }))
        )
      )
      if (file) fd.append('certificate', file)
      await apiUploadPortal.submit(token, fd)
      setSubmitted(true)
      confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } })
    } catch (err: any) {
      setSubmitError(err.message || 'Unable to submit certificate. Please ask for a new link.')
    } finally {
      setSubmitting(false)
    }
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

  const { subcontractor, gc } = data

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
            Requested by <strong>{gc.company_name}</strong> · four steps
          </p>
          {!submitted && data.expiresAt && <p className="text-[11px] text-slate-500 mt-1">Link expires: {data.expiresAt}</p>}
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
            <h2 className="text-2xl font-extrabold text-slate-900">Submission received — thank you!</h2>
            <p className="text-xs text-slate-600 max-w-md mx-auto leading-relaxed">
              Your submission was received (carrier: <strong>{carrier}</strong>, policy #{policyNumber || 'not provided'}). It is pending review by <strong>{gc.company_name}</strong>.
            </p>
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 max-w-md mx-auto font-['JetBrains_Mono']">
              Expiration on file: {expiration} · status: pending GC review
            </div>
            <p className="text-xs text-slate-500">This link can be used only once. Contact {gc.company_name} if you need to submit another certificate.</p>
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
                      <input readOnly value={subcontractor.trade || ''} className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-slate-100 text-slate-600" />
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
                      <label htmlFor="upload-carrier" className="block font-semibold text-slate-700 mb-1">Insurance carrier *</label>
                      <input id="upload-carrier" required value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. Liberty Mutual, Travelers" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-semibold" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">AM Best rating</label>
                      <input value={amBest} onChange={(e) => setAmBest(e.target.value)} placeholder="e.g. A (Excellent)" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">Policy number</label>
                      <input value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} placeholder="e.g. LM-GL-2025-44912" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" />
                    </div>
                    <div>
                      <label htmlFor="upload-effective" className="block font-semibold text-slate-700 mb-1">Effective date *</label>
                      <input id="upload-effective" type="date" required value={effective} onChange={(e) => setEffective(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" />
                    </div>
                    <div>
                      <label htmlFor="upload-expiration" className="block font-semibold text-slate-700 mb-1">Expiration date *</label>
                      <input id="upload-expiration" type="date" required value={expiration} onChange={(e) => setExpiration(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-bold" />
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-bold text-slate-700 mb-2">Coverage lines (optional; enter only what is on your certificate)</div>
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
                    <button disabled={!carrier.trim() || !effective || !expiration} onClick={() => setStep(3)} className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50">
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
                      {file ? file.name : 'Tap or click to choose file'}
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
                    <p className="text-xs text-slate-500">Double check before submitting. This link can be used only once.</p>
                  </div>
                  <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 overflow-hidden text-xs">
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Company</span><span className="font-bold">{subcontractor.company_name}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Carrier / Policy</span><span>{carrier} · {policyNumber || '—'}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">Period</span><span className="font-['JetBrains_Mono']">{effective} → {expiration}</span></div>
                    <div className="p-3 flex justify-between"><span className="text-slate-400">File attached</span><span>{file ? file.name : 'None (you can still submit)'}</span></div>
                  </div>
                  {submitError && <p role="alert" className="text-xs text-rose-700">{submitError}</p>}
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

            {/* Requirements are not supplied by this upload link. */}
            <div className="space-y-4">
              <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-card text-xs space-y-3">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
                  Insurance requirements
                </div>
                <p className="text-slate-600">Requirements are not included in this link. Contact {gc.company_name} for the applicable insurance requirements.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
