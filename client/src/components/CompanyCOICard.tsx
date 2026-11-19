import { useEffect, useState, useRef } from 'react'
import {
  ShieldCheck,
  Upload,
  CheckCircle2,
  ExternalLink,
  Copy,
  Printer,
  Calendar,
  AlertCircle,
  FileText,
} from 'lucide-react'
import { apiCompanyCOI, type CompanyCOIResponse } from '../api'
import { formatDisplayDate, isExpiredDate, daysFromNow } from '../lib/date'
import { coiExpiryAllExpired, isPartiallyExpired } from '../lib/coiExpiry'
import { COIReviewModal } from './COIReviewModal'

export function CompanyCOICard() {
  const [data, setData] = useState<CompanyCOIResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [reviewModalOpen, setReviewModalOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const reload = async () => {
    try {
      setError(null)
      const res = await apiCompanyCOI.get()
      setData(res)
    } catch (err: any) {
      setError(err?.message || 'Unable to load company certificate')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  const handleUpload = async (file: File) => {
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('certificate', file)
      await apiCompanyCOI.upload(form)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleValidate = async () => {
    setValidating(true)
    setError(null)
    try {
      await apiCompanyCOI.validate()
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Validation failed')
    } finally {
      setValidating(false)
    }
  }

  const handleShare = async () => {
    setSharing(true)
    setError(null)
    try {
      await apiCompanyCOI.share(90)
      await reload()
    } catch (err: any) {
      setError(err?.message || 'Unable to create share link')
    } finally {
      setSharing(false)
    }
  }

  const copyShare = async () => {
    if (!data?.share?.url) return
    const full = window.location.origin + data.share.url
    await navigator.clipboard.writeText(full)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const coi = data?.coi
  const expired = coiExpiryAllExpired(coi?.expiration_date, coi?.review_details?.policies)
  const days = daysFromNow(coi?.expiration_date)
  const isValidated = coi?.status === 'compliant'

  const statusBadge = () => {
    if (expired) {
      return (
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
          Expired
        </span>
      )
    }
    if (isPartiallyExpired(coi?.expiration_date, coi?.review_details?.policies)) {
      return (
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
          Partially expired
        </span>
      )
    }
    if (isValidated) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" /> Validated
        </span>
      )
    }
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
        Pending validation
      </span>
    )
  }

  return (
    <section className="bg-white rounded-3xl p-6 shadow-sm border border-slate-200">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,image/*,.heic,.heif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleUpload(f)
        }}
      />

      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-4 border-b border-slate-100">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand-100 text-brand-700 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
              Company certificate
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-0.5">
              {data?.company_name || 'Your company'} — COI on file
            </h2>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              Keep your own Certificate of Insurance on file so you can validate it and share verified coverage
              with other general contractors and clients.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {coi ? (
            <>
              {coi.certificate_url && (
                <a
                  href={coi.certificate_url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
                >
                  <FileText className="w-4 h-4 text-slate-400" /> View certificate
                </a>
              )}
              <button
                type="button"
                onClick={() => setReviewModalOpen(true)}
                className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
              >
                Review document data
              </button>
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
              >
                <Upload className="w-4 h-4" /> {uploading ? 'Uploading…' : 'Upload new version'}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
            >
              <Upload className="w-4 h-4" /> {uploading ? 'Uploading…' : 'Upload your COI'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-slate-400 py-6 text-center">Loading company certificate…</p>
      ) : !coi ? (
        <div className="mt-6 rounded-2xl border-2 border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
          <p className="font-semibold text-slate-700">No company certificate on file yet.</p>
          <p className="mt-1">
            Upload your company&rsquo;s Certificate of Insurance so other GCs and clients can verify your coverage.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="rounded-2xl border border-slate-200 p-3 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Carrier</div>
              <div className="font-bold text-slate-800 text-sm mt-0.5 truncate">{coi.carrier || '—'}</div>
              {coi.policy_number && (
                <div className="text-slate-500 font-mono text-[11px] mt-0.5 truncate">
                  Policy {coi.policy_number}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 p-3 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Coverage dates</div>
              <div className="font-bold text-slate-800 text-sm mt-0.5 flex items-center gap-1.5 flex-wrap">
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
                <span>{formatDisplayDate(coi.effective_date)}</span>
                <span className="text-slate-400">→</span>
                <span>{formatDisplayDate(coi.expiration_date)}</span>
              </div>
              {days != null && (
                <div className={`text-[11px] mt-0.5 ${expired ? 'text-rose-600 font-semibold' : 'text-slate-500'}`}>
                  {expired ? 'Policy expired' : `${days} days remaining`}
                </div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 p-3 bg-slate-50 flex flex-col justify-between">
              <div>
                <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Status</div>
                <div className="mt-1">{statusBadge()}</div>
              </div>
              {!isValidated && !expired && (
                <button
                  type="button"
                  disabled={validating}
                  onClick={handleValidate}
                  className="mt-2 min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {validating ? 'Validating…' : 'Validate your COI'}
                </button>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 p-3 bg-slate-50 flex flex-col justify-between">
              <div>
                <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Share link</div>
                {data?.share ? (
                  <p className="text-[11px] text-slate-500 mt-1">Active — expires {formatDisplayDate(data.share.expires_at)}</p>
                ) : (
                  <p className="text-[11px] text-slate-500 mt-1">Create a link other GCs can view</p>
                )}
              </div>
              <button
                type="button"
                disabled={sharing}
                onClick={handleShare}
                className="mt-2 min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-brand-700 border border-brand-300 hover:bg-brand-50 transition"
              >
                {sharing ? 'Creating…' : data?.share ? 'Replace share link' : 'Create share link'}
              </button>
            </div>
          </div>

          {data?.share && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-bold text-emerald-900">Shareable company COI link</span>
                <span className="text-[11px] text-emerald-800">
                  Other GCs and clients see your validated insurance record — no login required.
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={window.location.origin + data.share.url}
                  className="flex-1 rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-mono text-slate-800 select-all min-w-0"
                />
                <button
                  type="button"
                  onClick={copyShare}
                  className="min-h-[44px] inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs text-brand-700 font-semibold">
                <a href={data.share.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  Open share page <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <a
                  href={`mailto:?subject=${encodeURIComponent(
                    `${data?.company_name || 'Our company'} — Certificate of Insurance`,
                  )}&body=${encodeURIComponent(
                    `Hi,\n\nPlease find our Certificate of Insurance here:\n${window.location.origin + data.share.url}\n\nThank you.`,
                  )}`}
                  className="hover:underline"
                >
                  Email the link
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {coi && (
        <COIReviewModal
          coi={coi}
          open={reviewModalOpen}
          onClose={() => {
            setReviewModalOpen(false)
            reload()
          }}
          onUpdated={() => {
            setReviewModalOpen(false)
            reload()
          }}
        />
      )}
    </section>
  )
}
