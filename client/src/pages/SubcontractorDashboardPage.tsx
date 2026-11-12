import { useState, useEffect, useRef } from 'react'
import {
  ShieldCheck, Upload, CheckCircle2, Clock, FileText, AlertTriangle,
  Sparkles, Building2, Award,
} from 'lucide-react'
import { apiSub, getToken } from '../api'
import type { SubcontractorDashboardData, COI } from '../types'
import { CertificateViewer } from '../components/CertificateViewer'
import { SubConnectionQr } from '../components/SubConnectionQr'
import { removeSubConnection } from '../lib/subConnections'

type ConnectedGc = { gc_id: string; company_name: string; email?: string | null; phone?: string | null }
type DashboardData = Omit<SubcontractorDashboardData, 'connected_gcs'> & { connected_gcs: ConnectedGc[] }

export function SubcontractorDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingCertificate, setViewingCertificate] = useState<COI | null>(null)
  const [dataToken, setDataToken] = useState<string | null>(null)
  const [removingGc, setRemovingGc] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [qrVersion, setQrVersion] = useState(0)

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
      const token = getToken()
      const res = await apiSub.my()
      if (!token || getToken() !== token) return
      setData(res as DashboardData)
      setDataToken(token)
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

  const handleRemoveConnection = async (gc: ConnectedGc) => {
    if (!dataToken || removingGc || data?.disconnect_available !== true) return
    if (!window.confirm(`Remove the connection to ${gc.company_name || 'this general contractor'}? They will no longer have future access through this connection. Previously issued download links may work briefly, and files already downloaded cannot be recalled. This will also cancel all your unused connection codes; generate a new code if you want to share again.`)) return
    setRemovingGc(gc.gc_id)
    setError(null)
    setConnectionMessage(null)
    try {
      await removeSubConnection(gc.gc_id, dataToken)
      setViewingCertificate(null)
      setQrVersion(version => version + 1)
      setConnectionMessage('Connection removed. Unused connection codes were canceled.')
      setData(current => current ? { ...current, connected_gcs: (current.connected_gcs || []).filter(item => item.gc_id !== gc.gc_id), cois: current.cois.filter(coi => (coi as COI & { owner_gc_user_id?: string | null }).owner_gc_user_id !== gc.gc_id) } : current)
      await load()
    } catch (err: any) {
      if (err.status === 503 && err.code === 'CONNECTION_REMOVAL_UNAVAILABLE') {
        setData(current => current ? { ...current, disconnect_available: false } : current)
      }
      setError(err.message || 'Unable to remove connection')
    } finally {
      setRemovingGc(null)
    }
  }

  const daysUntil = (d: string): number | null => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
    const date = new Date(`${d}T00:00:00.000Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== d) return null
    return Math.ceil((date.getTime() - Date.now()) / 86400000)
  }

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

        {/* Free subcontractor account banner */}
        <div className="rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-4 flex items-start gap-3 text-xs text-emerald-900">
          <Sparkles className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">Free for subcontractors.</span> Upload your certificate and keep it on file at no charge.
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
                <CheckCircle2 className="w-3.5 h-3.5" /> Certificate submitted — it will appear below.
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
              Carrier connections are not available. Please upload your certificate instead.
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
                const expired = days !== null && days < 0
                const expiring = days !== null && days >= 0 && days <= 30
                const badge = days === null
                  ? { label: 'Expiration not provided', cls: 'bg-slate-50 text-slate-600 border-slate-200' }
                  : expired
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
                        <span>{coi.effective_date || 'Not provided'} → {days === null ? 'Expiration not provided' : coi.expiration_date}</span>
                      </div>
                    </div>

                    {coi.simulated_carrier_connect && (
                      <p className="mt-2 text-amber-800 font-semibold">Simulated carrier connection — not verified. Upload a real certificate instead.</p>
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
              GCs who asked for your COI. View certificates on file or upload a new one.
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

        <section aria-label="Connected general contractors" className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <Building2 className="w-4 h-4 text-slate-700" />
            <h3 className="text-sm font-semibold text-slate-900">Connected general contractors</h3>
          </div>
          <p className="text-xs text-slate-500 mb-3">Remove a connection to stop future access. Previously issued download links may work briefly, and files already downloaded cannot be recalled. Removing a connection also cancels all unused connection codes; generate a new code if you want to share again.</p>
          {data?.disconnect_available !== true && <p role="status" className="text-xs text-amber-800 mb-3">Removing connections is temporarily unavailable. Existing connections remain active; please try again later.</p>}
          {connectionMessage && <p role="status" className="text-xs text-emerald-700 mb-3">{connectionMessage}</p>}
          {(data?.connected_gcs || []).length === 0 ? (
            <p className="text-xs text-slate-500">No connected general contractors.</p>
          ) : (
            <ul className="space-y-2">
              {(data?.connected_gcs || []).map(gc => (
                <li key={gc.gc_id} className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-xl p-3 text-xs">
                  <div>
                    <p className="font-semibold text-slate-900">{gc.company_name || 'General contractor'}</p>
                    {(gc.email || gc.phone) && <p className="text-slate-500 mt-1">{[gc.email, gc.phone].filter(Boolean).join(' · ')}</p>}
                  </div>
                  <button type="button" disabled={data?.disconnect_available !== true || !!removingGc || !gc.gc_id} onClick={() => handleRemoveConnection(gc)}
                    aria-label={`Remove connection to ${gc.company_name || 'general contractor'}`}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50">
                    {removingGc === gc.gc_id ? 'Removing…' : 'Remove connection'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <SubConnectionQr key={qrVersion} />

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-400 py-4">
          Subcontractor portal · need help? Contact your requesting general contractor or sign in with another account.
        </div>
      </main>
      {viewingCertificate && <CertificateViewer certificate={viewingCertificate} onClose={() => setViewingCertificate(null)} returnLabel="Back to dashboard" />}
    </div>
  )
}
