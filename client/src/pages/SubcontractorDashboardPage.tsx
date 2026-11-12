import { useState, useEffect, useRef } from 'react'
import {
  ShieldCheck, Upload, CheckCircle2, Clock, FileText, AlertTriangle,
  Sparkles, Building2, Award,
} from 'lucide-react'
import { apiSub } from '../api'
import type { SubcontractorDashboardData, COI } from '../types'
import { CertificateViewer } from '../components/CertificateViewer'

export function SubcontractorDashboardPage() {
  const [data, setData] = useState<SubcontractorDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingCertificate, setViewingCertificate] = useState<COI | null>(null)

  // quick upload state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [carrier, setCarrier] = useState('')
  const [policyNum, setPolicyNum] = useState('')
  const [expDate, setExpDate] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)

  const load = async () => {
    try {
      setError(null)
      const res = await apiSub.my()
      setData(res)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])
  const handleQuickUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('certificate', file)
      if (carrier) form.append('carrier', carrier)
      if (policyNum) form.append('policy_number', policyNum)
      if (expDate) form.append('expiration_date', expDate)
      await apiSub.quickUpload(form)
      setFile(null)
      setCarrier('')
      setPolicyNum('')
      setExpDate('')
      setUploadSuccess(true)
      setTimeout(() => setUploadSuccess(false), 5000)
      await load()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const daysUntil = (d: string) => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)

  if (loading) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">Loading your insurance portal…</div>
  }

  const sub = data?.subcontractor
  const cois = data?.cois || []

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{sub?.company_name}</h1>
            <p className="text-xs text-slate-500">Subcontractor insurance portal · {sub?.trade}</p>
          </div>
          <span className="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
            {cois.length === 0 ? 'No COI on file' : `${cois.length} certificate on file`}
          </span>
        </div>

        {/* Free first month banner */}
        <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-4 flex items-start gap-3 text-xs text-emerald-900">
          <Sparkles className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">Free for your first month.</span> Submit your insurance paper once — after 30 days it's just a $2 one-time fee to keep your certificate hosted for every contractor who asks.
          </p>
        </div>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
        )}

        {/* Two main actions */}
        <div className="grid md:grid-cols-2 gap-5">
          {/* Action 1: Upload insurance paper */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Upload className="w-4 h-4 text-slate-700" />
              <h2 className="text-sm font-semibold text-slate-900">Upload your insurance paper</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Drop your ACORD certificate (PDF or photo) — you can fill the rest later or let your broker handle it.
            </p>

            <form onSubmit={handleQuickUpload} className="space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,image/png,image/jpeg"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
                  file ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 hover:border-slate-400 bg-slate-50'
                }`}
              >
                <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                {file ? (
                  <p className="text-xs font-semibold text-slate-800">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-slate-700">Click to choose a file, or drag it here</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">ACORD 25 certificate · PDF, PNG, JPG up to 25 MB</p>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Carrier (optional)</label>
                  <input
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                    placeholder="e.g. Liberty Mutual"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Policy # (optional)</label>
                  <input
                    value={policyNum}
                    onChange={(e) => setPolicyNum(e.target.value)}
                    placeholder="e.g. LM-GL-2026-00123"
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Expiration date (optional)</label>
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={!file || uploading}
                className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800 transition"
              >
                {uploading ? 'Uploading…' : file ? 'Upload certificate' : 'Choose a file first'}
              </button>
            </form>

            {uploadSuccess && (
              <div className="mt-3 text-xs text-emerald-700 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Certificate submitted — it will appear below under review.
              </div>
            )}
          </div>

          {/* Carrier connections are intentionally unavailable. */}
          <div className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              <h2 className="text-sm font-semibold text-slate-900">Insurance carrier connections unavailable</h2>
            </div>
            <p className="text-xs text-slate-600 mt-2">
              Carrier connections are not available. Please upload your certificate for review instead.
              No insurance coverage is verified by a carrier connection.
            </p>
          </div>
        </div>

        {/* My certificates */}
        <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">My certificates on file</h3>
              <p className="text-xs text-slate-500">Every COI on file, newest first.</p>
            </div>
            <span className="text-xs text-slate-400">{cois.length} on file</span>
          </div>

          {cois.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
              No certificates on file yet — upload one above.
            </div>
          ) : (
            <div className="space-y-3">
              {cois.map((coi: COI) => {
                const days = daysUntil(coi.expiration_date)
                const expired = days < 0
                const expiring = days >= 0 && days <= 30
                const badge = expired
                  ? { label: 'Expired', cls: 'bg-rose-50 text-rose-700 border-rose-200' }
                  : expiring
                  ? { label: `Expires in ${days}d`, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
                  : { label: `${days}d left`, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
                return (
                  <div key={coi.id} className="border border-slate-200 rounded-xl p-4 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Award className="w-4 h-4 text-slate-500" />
                        <span className="font-semibold text-slate-900">{coi.carrier}</span>
                        {coi.am_best_rating && (
                          <span className="text-[11px] text-slate-400">AM Best: {coi.am_best_rating}</span>
                        )}
                        {!coi.simulated_carrier_connect && <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>}
                        <span className="px-2 py-0.5 rounded-full border text-[11px] font-medium capitalize text-slate-600 bg-slate-50 border-slate-200">
                          {coi.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400 text-[11px]">
                        <span>Pol. {coi.policy_number || '—'}</span>
                        <span>·</span>
                        <span>{coi.effective_date} → {coi.expiration_date}</span>
                      </div>
                    </div>

                    {coi.simulated_carrier_connect && (
                      <p className="mt-2 text-amber-800 font-semibold">Simulated carrier connection — not verified. Upload a real certificate for review.</p>
                    )}
                    {coi.reviewer_notes && !coi.simulated_carrier_connect && (
                      <p className="text-[11px] text-slate-500 mt-2 italic">{coi.reviewer_notes}</p>
                    )}

                    {cois && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {(coi.coverages || []).map((cv) => (
                          <span
                            key={cv.id}
                            className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-700"
                            title={`${cv.type} · per ${cv.per_occurrence_limit} · agg ${cv.aggregate_limit}`}
                          >
                            {cv.type}: {cv.per_occurrence_limit}
                          </span>
                        ))}
                      </div>
                    )}

                    {coi.certificate_url && !coi.simulated_carrier_connect && (
                      <div className="mt-3 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setViewingCertificate(coi)}
                          className="inline-flex items-center gap-1 text-indigo-600 hover:underline"
                        >
                          View uploaded paper ({coi.certificate_name || 'document'}) <FileText className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Requests from contractors */}
        {data && data.requests.length > 0 && (
          <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-slate-700" />
              <h3 className="text-sm font-semibold text-slate-900">Requests from contractors</h3>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              GCs who asked for your COI. Upload once and both sides are covered.
            </p>
            <div className="space-y-2">
              {data.requests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-xl p-3 text-xs">
                  <div>
                    <span className="font-semibold text-slate-900">{r.gc_company_name || r.requested_by_email || 'General contractor'}</span>
                    <span className="text-slate-400 text-[11px] ml-2">requested {new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (cois.length > 0) {
                        alert('Your newest certificate is already on file and visible to this GC.')
                      } else {
                        fileInputRef.current?.click()
                      }
                    }}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
                  >
                    {cois.length > 0 ? 'COI already on file ✓' : 'Upload for this GC'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Public sharing is not currently available. */}
        <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm text-xs">
          <h3 className="text-sm font-semibold text-slate-900">Public COI sharing coming soon</h3>
          <p className="text-slate-600 mt-1">
            Public links, QR codes, and direct email sharing are not available yet. Contractors you join can still view your profile and certificates.
          </p>
        </section>

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-400 py-4">
          Subcontractor portal · need help? Contact your requesting general contractor or sign in with another account.
        </div>
      </main>
      {viewingCertificate && <CertificateViewer certificate={viewingCertificate} onClose={() => setViewingCertificate(null)} returnLabel="Back to dashboard" />}
    </div>
  )
}
