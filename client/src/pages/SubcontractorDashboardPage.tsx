import { useState, useEffect, useRef } from 'react'
import {
  Upload, LogIn, CheckCircle2, FileText, RefreshCw, Building2, Award, Camera,
} from 'lucide-react'
import { apiSub } from '../api'
import type { SubCarrier, QuickUploadResult } from '../api'
import type { SubcontractorDashboardData, COI } from '../types'
import { DraftReviewPanel } from '../components/DraftReviewPanel'
import { CertificateViewer } from '../components/CertificateViewer'

const MAX_FILE_SIZE = 25 * 1024 * 1024

export function SubcontractorDashboardPage() {
  const [data, setData] = useState<SubcontractorDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingCertificate, setViewingCertificate] = useState<COI | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ id: string; status: string; ocrStatus?: string | null } | null>(null)
  const [refreshingOcr, setRefreshingOcr] = useState<string | null>(null)
  const [ocrError, setOcrError] = useState<string | null>(null)

  const [carriers, setCarriers] = useState<SubCarrier[]>([])
  const [carriersLoading, setCarriersLoading] = useState(true)
  const [carriersError, setCarriersError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)

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
  useEffect(() => {
    let active = true
    apiSub.carriers()
      .then((result) => { if (active) setCarriers(result.carriers) })
      .catch(() => { if (active) setCarriersError('Could not load the carrier directory. Please upload a certificate or ask your broker for one.') })
      .finally(() => { if (active) setCarriersLoading(false) })
    return () => { active = false }
  }, [])

  const selectFile = (selected: File | null) => {
    setUploadResult(null)
    setFileError(null)
    if (!selected) return
    const supportedType = ['application/pdf', 'image/png', 'image/jpeg'].includes(selected.type)
      || (!selected.type && /\.(pdf|png|jpe?g)$/i.test(selected.name))
    if (!supportedType) {
      setFile(null)
      setFileError('Choose a PDF, PNG, or JPG file.')
    } else if (selected.size > MAX_FILE_SIZE) {
      setFile(null)
      setFileError('The file must be 25 MB or smaller.')
    } else {
      setFile(selected)
    }
  }

  const handleQuickUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || uploading) return
    setUploading(true)
    setFileError(null)
    setUploadResult(null)
    try {
      const form = new FormData()
      form.append('certificate', file)
      const result = await apiSub.quickUpload(form)
      setFile(null)
      setUploadResult({ id: result.id, status: result.status, ocrStatus: result.ocr_status })
      await load()
    } catch (err: any) {
      setFileError(err.message || 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const refreshOcr = async (id: string) => {
    if (refreshingOcr) return
    setRefreshingOcr(id)
    setOcrError(null)
    try {
      const result = await apiSub.ocrStatus(id)
      setUploadResult((current) => current?.id === id ? { ...current, status: result.status, ocrStatus: result.ocr_status } : current)
      await load()
    } catch (err: any) {
      setOcrError(err.message || 'Could not refresh text extraction status.')
    } finally {
      setRefreshingOcr(null)
    }
  }

  const handleCarrierConnect = async (carrier: SubCarrier) => {
    if (carrier.status !== 'available' || connecting) return
    setConnecting(carrier.id)
    setConnectionMessage(null)
    try {
      await apiSub.carrierConnect(carrier.id)
      setConnectionMessage('The connection request returned. A connection or coverage verification has not been confirmed here.')
    } catch (err: any) {
      setConnectionMessage(err.message || 'The connection request could not be started. Please upload a certificate instead.')
    } finally {
      setConnecting(null)
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

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
        )}

        {/* Two main actions */}
        <div className="grid md:grid-cols-2 gap-5">
          <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm" aria-labelledby="upload-heading">
            <div className="flex items-center gap-2 mb-1">
              <Upload className="w-4 h-4 text-slate-700" />
              <h2 id="upload-heading" className="text-sm font-semibold text-slate-900">Upload your insurance certificate</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Upload your certificate as a PDF or photo. If you don't have it, ask your broker for a copy first.
            </p>
            <form onSubmit={handleQuickUpload} className="space-y-3">
              <input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                className="hidden" onChange={(e) => { selectFile(e.target.files?.[0] || null); e.target.value = '' }} />
              <input ref={cameraInputRef} type="file" accept="image/png,image/jpeg" capture="environment"
                className="hidden" onChange={(e) => { selectFile(e.target.files?.[0] || null); e.target.value = '' }} />
              <div
                onDragEnter={(e) => { e.preventDefault(); setDragging(true) }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragging(true) }}
                onDragLeave={(e) => { e.preventDefault(); if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (!uploading) selectFile(e.dataTransfer.files?.[0] || null) }}
                className={`border-2 border-dashed rounded-xl p-5 text-center transition ${dragging || file ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 bg-slate-50'}`}
              >
                <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                <p className="text-xs font-semibold text-slate-700 break-all">{file ? `${file.name} (${(file.size / 1024).toFixed(0)} KB)` : 'Drag and drop a file here'}</p>
                <p className="text-[11px] text-slate-500 mt-1">PDF, PNG or JPG · maximum 25 MB</p>
                <div className="flex flex-wrap justify-center gap-2 mt-3">
                  <button type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50">
                    {file ? 'Choose a different file' : 'Choose a file'}
                  </button>
                  <button type="button" disabled={uploading} onClick={() => cameraInputRef.current?.click()}
                    className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50 inline-flex items-center gap-1.5">
                    <Camera className="w-3.5 h-3.5" /> Take a photo
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 mt-2">Camera availability depends on your device and browser.</p>
              </div>
              {fileError && <p role="alert" className="text-xs text-rose-700">{fileError}</p>}
              <button type="submit" disabled={!file || uploading}
                className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white disabled:opacity-40 hover:bg-slate-800 transition">
                {uploading ? 'Uploading…' : 'Upload certificate'}
              </button>
              <p className="text-[11px] text-slate-500">A file is required. Uploading saves a private draft; it is not shared with a contractor unless you give permission below. Uploading does not verify coverage.</p>
            </form>
            {uploadResult && (
              <div role="status" className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 space-y-1">
                <p className="flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Private draft uploaded. Share it with a contractor only if you choose to below. Review status: {uploadResult.status ? uploadResult.status.replace(/_/g, ' ') : 'not reported'}.</p>
                <p>{uploadResult.ocrStatus === 'not_configured'
                  ? 'Automatic text extraction is not configured.'
                  : uploadResult.ocrStatus ? `Text extraction status: ${uploadResult.ocrStatus.replace(/_/g, ' ')}.` : 'Text extraction status was not reported.'} Extraction is separate from review and approval.</p>
              </div>
            )}
          </section>

          <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm" aria-labelledby="carriers-heading">
            <div className="flex items-center gap-2 mb-1">
              <LogIn className="w-4 h-4 text-indigo-600" />
              <h2 id="carriers-heading" className="text-sm font-semibold text-slate-900">Connect an insurance company</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">Connection options are shown only when provided by the carrier directory. We do not ask for your insurance password here.</p>
            {carriersLoading ? <p className="text-xs text-slate-500">Loading carriers…</p> : carriersError ? (
              <p role="alert" className="text-xs text-rose-700">{carriersError}</p>
            ) : carriers.length === 0 ? (
              <p className="text-xs text-slate-500">No carrier connections are currently listed.</p>
            ) : (
              <ul className="space-y-2">
                {carriers.map((carrier) => (
                  <li key={carrier.id} className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 rounded-xl p-3">
                    <span className="text-xs font-semibold text-slate-800">{carrier.name}</span>
                    <button type="button" onClick={() => handleCarrierConnect(carrier)}
                      disabled={carrier.status !== 'available' || !!connecting}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                      {connecting === carrier.id && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                      {carrier.status !== 'available' ? 'Not connected yet' : connecting === carrier.id ? 'Starting…' : 'Connect'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {connectionMessage && <p role="status" className="text-xs text-slate-700 mt-3">{connectionMessage}</p>}
            <p className="text-xs text-slate-500 mt-4">Can't connect? Upload a certificate above, or ask your broker to provide a copy for upload.</p>
          </section>
        </div>

        <DraftReviewPanel key={uploadResult?.id || 'no-upload'} role="sub" />

        {/* My certificates */}
        <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">My certificates on file</h3>
              <p className="text-xs text-slate-500">Every COI on file, newest first.</p>
            </div>
            <span className="text-xs text-slate-400">{cois.length} on file</span>
          </div>

          {ocrError && <p role="alert" className="text-xs text-rose-700 mb-3">{ocrError}</p>}
          {cois.length === 0 ? (
            <div className="border border-dashed border-slate-200 rounded-xl p-8 text-center text-xs text-slate-400">
              No certificates on file yet — upload a certificate above, or ask your broker for a copy.
            </div>
          ) : (
            <div className="space-y-3">
              {cois.map((coi: COI & Partial<QuickUploadResult>) => {
                const parsedExpiry = coi.expiration_date ? Date.parse(coi.expiration_date) : NaN
                const days = Number.isFinite(parsedExpiry) ? daysUntil(coi.expiration_date) : null
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
                        <span className="font-semibold text-slate-900">{coi.carrier || 'Carrier not provided'}</span>
                        {coi.am_best_rating && (
                          <span className="text-[11px] text-slate-400">AM Best: {coi.am_best_rating}</span>
                        )}
                        {!coi.simulated_carrier_connect && <span className={`px-2 py-0.5 rounded-full border text-[11px] font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>}
                        <span className="px-2 py-0.5 rounded-full border text-[11px] font-medium capitalize text-slate-600 bg-slate-50 border-slate-200">
                          {coi.status ? coi.status.replace(/_/g, ' ') : 'Status not reported'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-slate-400 text-[11px]">
                        <span>Pol. {coi.policy_number || '—'}</span>
                        <span>·</span>
                        <span>{coi.effective_date || 'Start date not provided'} → {coi.expiration_date || 'Expiration not provided'}</span>
                      </div>
                    </div>

                    {coi.ocr_status && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                        <span>Text extraction: {coi.ocr_status.replace(/_/g, ' ')} · Review and approval are separate.</span>
                        {coi.ocr_status === 'processing' && (
                          <button type="button" onClick={() => refreshOcr(coi.id)} disabled={!!refreshingOcr}
                            className="font-semibold text-indigo-700 hover:underline disabled:opacity-50">
                            {refreshingOcr === coi.id ? 'Refreshing…' : 'Refresh extraction status'}
                          </button>
                        )}
                      </div>
                    )}
                    {coi.simulated_carrier_connect && (
                      <p className="mt-2 text-amber-800 font-semibold">Simulated carrier connection — not verified. Upload a real certificate for review.</p>
                    )}
                    {coi.reviewer_notes && !coi.simulated_carrier_connect && (
                      <p className="text-[11px] text-slate-500 mt-2 italic">{coi.reviewer_notes}</p>
                    )}

                    {!coi.simulated_carrier_connect && (
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
              Contractors who requested a certificate. Upload a copy if you have one.
            </p>
            <div className="space-y-2">
              {data.requests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 rounded-xl p-3 text-xs">
                  <div>
                    <span className="font-semibold text-slate-900">{r.gc_company_name || r.requested_by_email || 'General contractor'}</span>
                    <span className="text-slate-400 text-[11px] ml-2">requested {new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  <button type="button" onClick={() => document.getElementById('upload-heading')?.scrollIntoView({ behavior: 'smooth' })}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-900 text-white hover:bg-slate-800">
                    Go to upload
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Footer info */}
        <div className="text-center text-[11px] text-slate-400 py-4">
          Subcontractor portal · need help? Contact your requesting general contractor or sign in with another account.
        </div>
      </main>
      {viewingCertificate && <CertificateViewer certificate={viewingCertificate} onClose={() => setViewingCertificate(null)} returnLabel="Back to dashboard" />}
    </div>
  )
}
