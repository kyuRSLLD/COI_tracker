import { useState, useEffect, useLayoutEffect, useRef, useContext } from 'react'
import {
  ShieldCheck, Upload, CheckCircle2, Clock, FileText, AlertTriangle,
  Sparkles, Building2, Award,
} from 'lucide-react'
import { apiCoiFields, apiSub, getToken, SESSION_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from '../api'
import type { SubcontractorDashboardData, COI } from '../types'
import { CertificateViewer } from '../components/CertificateViewer'
import { SubConnectionQr } from '../components/SubConnectionQr'
import { removeSubConnection } from '../lib/subConnections'
import { ConnectionSession } from '../components/ConnectionOptions'
import { CoiFieldsReview } from '../components/CoiFieldsReview'
import { emptyCoiFields, type CoiFields } from '../lib/coiFields'
import { extractCoiImage } from '../lib/coiOcr'

type ConnectedGc = { gc_id: string; company_name: string; email?: string | null; phone?: string | null }
type DashboardData = Omit<SubcontractorDashboardData, 'connected_gcs'> & { connected_gcs: ConnectedGc[] }

// The server may return a partial review; normalize without borrowing values
// from legacy COI columns, which remain independently authoritative.
function normalizeFields(value: CoiFields | null): CoiFields {
  const empty = emptyCoiFields()
  if (!value) return empty
  return {
    ...empty, ...value,
    producer: { ...empty.producer, ...value.producer },
    insured: { ...empty.insured, ...value.insured },
    insurers: (value.insurers || []).map(item => ({ letter: item.letter ?? '', name: item.name ?? '', naic: item.naic ?? '' })),
    policies: (value.policies || []).map(item => ({
      type: item.type ?? '', insurerLetter: item.insurerLetter ?? '', policyNumber: item.policyNumber ?? '',
      effectiveDate: item.effectiveDate ?? '', expirationDate: item.expirationDate ?? '',
      limits: (item.limits || []).map(limit => ({ label: limit.label ?? '', amount: limit.amount ?? '' })),
    })),
  }
}

type ReviewState = {
  version: number
  coi: COI
  file: File | null
  uploadSourceTag: string | null
  imageUrl?: string
  loading: boolean
  details: CoiFields | null
  sourceTag: string | null
  reviewRevision: string | null
  editable: boolean
  saving: boolean
  openingOriginal: boolean
  conflicted: boolean
  error: string | null
  progress: string | null
  ocrCanApply: boolean
  ocrCanRetry: boolean
  ocrText?: string
  warnings: string[]
}

export function SubcontractorDashboardPage() {
  const { token, role } = useContext(ConnectionSession)
  if (!token || token !== getToken() || role !== 'sub') return null
  return <SessionDashboard key={token} sessionToken={token} />
}

function SessionDashboard({ sessionToken }: { sessionToken: string }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewingCertificate, setViewingCertificate] = useState<COI | null>(null)
  const [dataToken, setDataToken] = useState<string | null>(null)
  const [removingGc, setRemovingGc] = useState<string | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null)
  const [qrVersion, setQrVersion] = useState(0)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [carrier, setCarrier] = useState('')
  const [policyNum, setPolicyNum] = useState('')
  const [expDate, setExpDate] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const [reviewSaved, setReviewSaved] = useState(false)
  const [review, setReview] = useState<ReviewState | null>(null)
  const active = useRef(true)
  const reviewVersion = useRef(0)
  const reviewEdited = useRef(false)
  const previewUrl = useRef<string | null>(null)
  const ocrController = useRef<AbortController | null>(null)
  const reviewController = useRef<AbortController | null>(null)
  const uploadInFlight = useRef(false)
  const selectionVersion = useRef(0)
  const saveInFlight = useRef(false)
  const originalInFlight = useRef(false)
  const reviewBlocked = useRef(false)
  const standaloneViewVersion = useRef(0)

  const sessionValid = () => active.current && getToken() === sessionToken
  const currentReview = (version: number) => sessionValid() && reviewVersion.current === version
  const updateReview = (version: number, update: (current: ReviewState) => ReviewState) => {
    setReview(current => current && current.version === version && currentReview(version) ? update(current) : current)
  }
  const revokePreview = () => {
    ocrController.current?.abort()
    ocrController.current = null
    reviewController.current?.abort()
    reviewController.current = null
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
    previewUrl.current = null
  }
  const closeReview = (saved = false) => {
    if (saveInFlight.current && !saved) return
    ++reviewVersion.current
    saveInFlight.current = false
    originalInFlight.current = false
    reviewEdited.current = false
    revokePreview()
    setReview(null)
    setViewingCertificate(null)
  }

  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false; ++reviewVersion.current; revokePreview() }
  }, [])
  useEffect(() => {
    const invalidate = (event: Event) => {
      const expired = event.type === SESSION_EXPIRED_EVENT && (event as CustomEvent<string>).detail === sessionToken
      if (!expired && getToken() === sessionToken) return
      active.current = false
      ++reviewVersion.current
      revokePreview()
      setReview(null); setViewingCertificate(null); setFile(null)
      setCarrier(''); setPolicyNum(''); setExpDate(''); setData(null); setDataToken(null)
      setUploadSuccess(false); setReviewSaved(false); setError(null); setConnectionMessage(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    window.addEventListener('storage', invalidate)
    window.addEventListener(SESSION_CHANGED_EVENT, invalidate)
    window.addEventListener(SESSION_EXPIRED_EVENT, invalidate)
    return () => {
      window.removeEventListener('storage', invalidate)
      window.removeEventListener(SESSION_CHANGED_EVENT, invalidate)
      window.removeEventListener(SESSION_EXPIRED_EVENT, invalidate)
    }
  }, [sessionToken])

  const load = async () => {
    try {
      if (!sessionValid()) return
      const res = await apiSub.my(sessionToken)
      if (!sessionValid()) return
      setData(res as DashboardData)
      setDataToken(sessionToken)
    } catch (err: any) {
      if (sessionValid()) setError(err.message)
    } finally {
      if (sessionValid()) setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (!review?.saving) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [review?.saving])

  const runOcr = async (version: number, selectedFile: File, mayApply: boolean) => {
    if (!currentReview(version) || ocrController.current) return
    updateReview(version, current => ({ ...current, progress: 'Preparing image…', ocrCanRetry: false }))
    const controller = new AbortController()
    ocrController.current = controller
    try {
      const extracted = await extractCoiImage(selectedFile, (progress) => {
        if (!currentReview(version) || controller.signal.aborted) return
        const percent = Number.isFinite(progress) ? ` ${Math.round(progress * 100)}%` : ''
        updateReview(version, current => ({ ...current, progress: `Reading image…${percent}` }))
      }, { signal: controller.signal })
      if (!currentReview(version) || controller.signal.aborted) return
      updateReview(version, current => {
        const canApply = mayApply && !reviewEdited.current
        return {
          ...current, progress: null, ocrText: extracted.rawText, ocrCanRetry: !extracted.rawText.trim(), warnings: [
            ...extracted.warnings,
            ...(!canApply ? ['Extracted text is shown for reference; existing or manually edited details were not replaced.'] : []),
          ],
          details: canApply ? normalizeFields(extracted.details) : current.details,
        }
      })
    } catch {
      if (!currentReview(version) || controller.signal.aborted) return
      updateReview(version, current => ({ ...current, progress: null, ocrCanRetry: true,
        warnings: ['Could not extract text from this image. You can enter the details manually.'] }))
    } finally {
      if (ocrController.current === controller) ocrController.current = null
    }
  }

  const loadReview = async (version: number, coi: COI, selectedFile: File | null, uploadSourceTag: string | null) => {
    if (!currentReview(version)) return
    updateReview(version, current => ({ ...current, loading: true, error: null }))
    try {
      const result = await apiCoiFields.get(coi.id, sessionToken, reviewController.current?.signal)
      if (!currentReview(version)) return
      if (selectedFile && (!uploadSourceTag || uploadSourceTag !== result.sourceTag)) {
        reviewBlocked.current = true
        updateReview(version, current => ({ ...current, loading: false, file: null, imageUrl: undefined,
          details: normalizeFields(result.details), sourceTag: result.sourceTag, reviewRevision: result.reviewRevision,
          editable: false, conflicted: true, error: 'The uploaded file could not be matched to the current certificate. Close and reopen the review to reload the current document. The uploaded image was not previewed or extracted.' }))
        return
      }
      if (selectedFile && ['image/png', 'image/jpeg'].includes(selectedFile.type.toLowerCase())) {
        try { previewUrl.current = URL.createObjectURL(selectedFile) } catch { /* Preview is optional. */ }
      }
      updateReview(version, current => ({
        ...current, loading: false, details: normalizeFields(result.details), sourceTag: result.sourceTag, reviewRevision: result.reviewRevision,
        imageUrl: previewUrl.current || undefined,
        editable: result.editable, ocrCanApply: result.details === null, error: null,
      }))
      // Only a freshly uploaded PNG or JPEG is sent to local OCR. Existing saved
      // reviews are never replaced by OCR, nor are manual edits made in flight.
      if (!selectedFile || !result.editable) return
      if (!['image/png', 'image/jpeg'].includes(selectedFile.type.toLowerCase())) {
        updateReview(version, current => ({ ...current, warnings: ['Automatic extraction is available for PNG and JPEG images only. Enter the details manually.'] }))
        return
      }
      void runOcr(version, selectedFile, result.details === null)
    } catch (err: any) {
      if (!currentReview(version)) return
      updateReview(version, current => ({ ...current, loading: false, error: err?.message || 'Could not load the review. Please try again.' }))
    }
  }

  const openReview = (coi: COI, selectedFile: File | null = null, uploadSourceTag: string | null = null) => {
    if (!sessionValid() || !coi.id || saveInFlight.current) return
    ++reviewVersion.current
    const version = reviewVersion.current
    ++standaloneViewVersion.current
    reviewEdited.current = false
    saveInFlight.current = false
    originalInFlight.current = false
    reviewBlocked.current = false
    revokePreview()
    reviewController.current = new AbortController()
    setViewingCertificate(null)
    setReview({ version, coi, file: selectedFile, uploadSourceTag, loading: true, details: null,
      sourceTag: null, reviewRevision: null, editable: false, saving: false, openingOriginal: false, conflicted: false, error: null, progress: null, ocrCanApply: false, ocrCanRetry: false, warnings: [] })
    void loadReview(version, coi, selectedFile, uploadSourceTag)
  }

  // Refresh short-lived URLs at the moment of use without replacing the draft
  // or its original revision with newer review data from this lookup.
  const openOriginal = async () => {
    if (!review?.sourceTag || review.conflicted || reviewBlocked.current || review.loading || review.saving || saveInFlight.current || originalInFlight.current || !currentReview(review.version)) return
    const { version, coi, sourceTag } = review
    originalInFlight.current = true
    updateReview(version, current => ({ ...current, openingOriginal: true }))
    try {
      const result = await apiCoiFields.get(coi.id, sessionToken, reviewController.current?.signal)
      if (!currentReview(version)) return
      if (result.sourceTag !== sourceTag) {
        reviewBlocked.current = true
        ocrController.current?.abort()
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
        previewUrl.current = null
        updateReview(version, current => ({ ...current, editable: false, conflicted: true, file: null, imageUrl: undefined, progress: null, ocrCanRetry: false,
          error: 'The certificate changed. Close and reopen the review to reload the current document; your unsaved draft cannot be saved.' }))
      } else if (!result.certificateUrl) {
        updateReview(version, current => ({ ...current, error: 'The original certificate is unavailable. Try again later or ask for a new upload.' }))
      } else {
        setViewingCertificate({ ...coi, certificate_url: result.certificateUrl })
      }
    } catch (err: any) {
      if (currentReview(version)) updateReview(version, current => ({ ...current, error: err?.message || 'Could not refresh the certificate link. Please try again.' }))
    } finally {
      if (currentReview(version)) {
        originalInFlight.current = false
        updateReview(version, current => ({ ...current, openingOriginal: false }))
      }
    }
  }

  const saveReview = async () => {
    if (!review || !review.details || !review.sourceTag || !review.reviewRevision || !review.editable || review.conflicted || reviewBlocked.current || review.saving || saveInFlight.current || originalInFlight.current || !currentReview(review.version)) return
    const version = review.version
    const { coi, sourceTag, reviewRevision, details } = review
    reviewEdited.current = true // prevent late OCR replacing the saved snapshot
    saveInFlight.current = true
    updateReview(version, current => ({ ...current, saving: true, error: null }))
    try {
      await apiCoiFields.save(coi.id, { sourceTag, reviewRevision, details }, sessionToken, reviewController.current?.signal)
      if (!currentReview(version)) return
      closeReview(true)
      setReviewSaved(true)
      void load()
    } catch (err: any) {
      if (!currentReview(version)) return
      const conflict = err?.status === 409
      const uncertain = !err?.status || err.status >= 500
      const stopEditing = conflict || uncertain || err?.status === 403 || err?.status === 404
      if (stopEditing) reviewBlocked.current = true
      if (stopEditing) ocrController.current?.abort()
      if (conflict && previewUrl.current) {
        URL.revokeObjectURL(previewUrl.current)
        previewUrl.current = null
      }
      updateReview(version, current => ({ ...current, saving: false,
        conflicted: conflict || current.conflicted,
        file: conflict ? null : current.file, imageUrl: conflict ? undefined : current.imageUrl,
        editable: stopEditing ? false : current.editable,
        progress: stopEditing ? null : current.progress,
        ocrCanRetry: stopEditing ? false : current.ocrCanRetry,
        error: conflict
          ? 'The certificate or review changed, possibly because someone else edited it. Close and reopen the review to reload; your unsaved draft cannot be saved.'
          : uncertain ? 'The save outcome is uncertain. Close and reopen the review to check the saved data before making changes again.'
            : (err?.message || 'Could not save the review. Your edits are still here; please try again.') }))
    } finally {
      if (currentReview(version)) saveInFlight.current = false
    }
  }

  const handleQuickUpload = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!file || !sessionValid() || uploadInFlight.current) return
    const selectedFile = file
    const selection = selectionVersion.current
    const previousReview = reviewVersion.current
    uploadInFlight.current = true
    setUploading(true)
    setUploadSuccess(false)
    setReviewSaved(false)
    setError(null)
    try {
      const form = new FormData()
      form.append('certificate', selectedFile)
      if (carrier) form.append('carrier', carrier)
      if (policyNum) form.append('policy_number', policyNum)
      if (expDate) form.append('expiration_date', expDate)
      const coi = await apiSub.quickUpload(form, sessionToken)
      if (!sessionValid()) return
      if (selectionVersion.current === selection) {
        setFile(null); setCarrier(''); setPolicyNum(''); setExpDate('')
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
      setUploadSuccess(true)
      if (coi?.id && selectionVersion.current === selection && reviewVersion.current === previousReview) openReview(coi, selectedFile, coi.fields_source_tag ?? null)
      else if (coi?.id) { /* A newer selection or review wins; reopen this upload from the list. */ }
      else setError('Upload completed, but the review could not be opened. Refresh the list and open the certificate review there.')
      void load()
    } catch (err: any) {
      if (sessionValid()) setError(err.message || 'Upload failed. Please try again.')
    } finally {
      uploadInFlight.current = false
      if (sessionValid()) setUploading(false)
    }
  }

  const openDashboardOriginal = async (coi: COI) => {
    if (!sessionValid()) return
    const version = ++standaloneViewVersion.current
    try {
      const result = await apiCoiFields.get(coi.id, sessionToken)
      if (!sessionValid() || version !== standaloneViewVersion.current) return
      if (!result.certificateUrl) { setError('The certificate file is unavailable. Please try again later.'); return }
      setViewingCertificate({ ...coi, certificate_url: result.certificateUrl })
    } catch (err: any) {
      if (sessionValid() && version === standaloneViewVersion.current) setError(err?.message || 'Could not refresh the certificate link. Please try again.')
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
      if (!sessionValid()) return
      setViewingCertificate(null)
      setQrVersion(version => version + 1)
      setConnectionMessage('Connection removed. Unused connection codes were canceled.')
      setData(current => current ? { ...current, connected_gcs: (current.connected_gcs || []).filter(item => item.gc_id !== gc.gc_id), cois: current.cois.filter(coi => (coi as COI & { owner_gc_user_id?: string | null }).owner_gc_user_id !== gc.gc_id) } : current)
      await load()
    } catch (err: any) {
      if (!sessionValid()) return
      if (err.status === 503 && err.code === 'CONNECTION_REMOVAL_UNAVAILABLE') {
        setData(current => current ? { ...current, disconnect_available: false } : current)
      }
      setError(err.message || 'Unable to remove connection')
    } finally {
      if (sessionValid()) setRemovingGc(null)
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

  if (review) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-5xl">
          {review.loading || !review.details ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <h1 className="text-xl font-bold text-slate-900">Review document data</h1>
              {review.loading ? <p role="status" className="mt-3 text-sm text-slate-600">Loading review…</p> : <>
                <p role="alert" className="mt-3 text-sm text-rose-700">{review.error || 'Could not load review.'}</p>
                <p className="mt-2 text-sm text-slate-600">Retry the review without uploading again, or return to the dashboard.</p>
                <button type="button" onClick={() => openReview(review.coi, review.file, review.uploadSourceTag)} className="mt-4 mr-3 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Retry review</button>
              </>}
              <button type="button" onClick={() => closeReview()} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Back to dashboard</button>
            </div>
          ) : <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <button type="button" disabled={review.saving} onClick={() => closeReview()} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Back to dashboard</button>
              <button type="button" disabled={review.saving || review.openingOriginal || review.conflicted} onClick={() => void openOriginal()} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">{review.openingOriginal ? 'Refreshing link…' : 'View original certificate'}</button>
              <span className="text-xs text-slate-500">If the link expires, return here and open the certificate again.</span>
            </div>
            {review.imageUrl && <details className="mb-4 rounded-xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer text-sm font-semibold">Preview uploaded image</summary><img src={review.imageUrl} alt="Uploaded certificate" className="mt-3 max-h-[60vh] max-w-full" /></details>}
            {review.progress && <p role="status" aria-live="polite" className="mb-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{review.progress} You may enter details manually while extraction runs.</p>}
            {review.ocrCanRetry && review.file && !review.progress && <button type="button" disabled={review.saving} onClick={() => {
              if (review.file && currentReview(review.version) && !saveInFlight.current) void runOcr(review.version, review.file, review.ocrCanApply)
            }} className="mb-4 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Retry image extraction</button>}
            <CoiFieldsReview details={review.details} onChange={details => {
              if (!currentReview(review.version) || review.saving || !review.editable || saveInFlight.current) return
              reviewEdited.current = true
              updateReview(review.version, current => ({ ...current, details }))
            }} onSave={() => void saveReview()} onClose={() => closeReview()} saving={review.saving || review.openingOriginal} editable={review.editable}
              error={review.error} ocrText={review.ocrText} ocrWarnings={review.warnings} />
          </>}
        </div>
        {viewingCertificate && <CertificateViewer certificate={viewingCertificate} onClose={() => setViewingCertificate(null)} returnLabel="Back to review" />}
      </main>
    )
  }

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
        {reviewSaved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">Document data saved. These details are not independently verified.</p>}

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
                onChange={(e) => { ++selectionVersion.current; closeReview(); setFile(e.target.files?.[0] || null); setUploadSuccess(false) }}
                disabled={uploading}
                className="hidden"
              />
              <div
                onClick={() => { if (!uploading) fileInputRef.current?.click() }}
                className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
                  file ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300 hover:border-slate-400 bg-slate-50'
                }`}
              >
                <FileText className="w-8 h-8 text-slate-400 mx-auto mb-2" />
                {file ? (
                  <p className="text-xs font-semibold text-slate-800">{file.name} ({(file.size / 1024).toFixed(0)} KB)</p>
                ) : (
                  <>
                    <p className="text-xs font-semibold text-slate-700">Click to choose a file</p>
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
                <CheckCircle2 className="w-3.5 h-3.5" /> Certificate submitted. You can review its document data below.
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

                    <button type="button" onClick={() => openReview(coi)}
                      className="mt-3 mr-3 text-[11px] font-semibold text-indigo-700 hover:underline">
                      Review document data
                    </button>
                    {coi.certificate_url && !coi.simulated_carrier_connect && (
                      <div className="mt-3 text-[11px]">
                        <button
                          type="button"
                          onClick={() => void openDashboardOriginal(coi)}
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
