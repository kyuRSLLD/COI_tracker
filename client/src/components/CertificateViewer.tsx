import { useContext, useEffect, useRef, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Download, X, FileText, Layers, ExternalLink, Printer } from 'lucide-react'
import type { COI } from '../types'
import { getToken, getStoredUser, SESSION_CHANGED_EVENT } from '../api'
import { ConnectionSession } from './ConnectionOptions'
import { AcordCertificateForm } from './AcordCertificateForm'

type Certificate = COI & {
  certificate_url?: string | null
  certificate_name?: string | null
  certificate_mime?: string | null
  company_name?: string
  sub_company_name?: string
}

type PreviewKind = 'image' | 'pdf' | 'unsupported'

export function certificatePreviewKind(certificate: Certificate): PreviewKind {
  const mime = certificate.certificate_mime?.split(';')[0].trim().toLowerCase()
  if (mime && mime !== 'application/octet-stream') {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) return 'image'
    return mime === 'application/pdf' ? 'pdf' : 'unsupported'
  }
  const name = certificate.certificate_name || certificate.certificate_url?.split(/[?#]/)[0] || ''
  if (/\.(jpe?g|png|gif|webp)$/i.test(name)) return 'image'
  if (/\.pdf$/i.test(name)) return 'pdf'
  return 'unsupported'
}

export function safeCertificateUrl(url?: string | null): string | null {
  if (!url || !url.trim() || url.trim().startsWith('#')) return null
  try {
    const parsed = new URL(url, window.location.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

interface Props {
  certificate: Certificate
  onClose: () => void
  returnLabel: string
  onEdit?: () => void
  initialMode?: 'form' | 'file'
}

export function CertificateViewer({ certificate, onClose, returnLabel, onEdit, initialMode }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnRef = useRef<HTMLButtonElement>(null)
  const { token: sessionToken } = useContext(ConnectionSession)
  const bearerToken = sessionToken || getToken() || ''

  // Build the same-origin document proxy URL (avoids S3 CORS + attachment-disposition issues).
  const docProxyUrl = useMemo(() => {
    if (!certificate.id) return null
    const base = `/api/coi-fields/${encodeURIComponent(certificate.id)}/document`
    return bearerToken ? `${base}?token=${encodeURIComponent(bearerToken)}` : base
  }, [certificate.id, bearerToken])

  const signedUrl = safeCertificateUrl(certificate.certificate_url)
  const fileUrl = docProxyUrl || signedUrl
  const kind = certificatePreviewKind(certificate)
  const hasFile = Boolean(certificate.certificate_key || certificate.certificate_url)

  // PDF copy rule: subs/GCs cannot download PDFs of their own unverified certificates;
  // GCs and Admin may download PDFs even for unverified certificates of their subs.
  const currentUser = getStoredUser()
  const role = currentUser?.role
  const isVerified = certificate.status === 'compliant'
  const isGc = role === 'gc' || role === 'pro_gc'
  const isSub = role === 'sub'
  const isOwnCoi =
    (isSub && (certificate.owner_sub_user_id === currentUser?.id || certificate.owner_gc_user_id == null)) ||
    (isGc && (certificate.owner_gc_user_id === currentUser?.id || Boolean((certificate as any).is_company_coi)))
  const canDownloadPdf = isOwnCoi ? isVerified : isVerified || isGc || role === 'admin' || role === 'staff'

  const hasExtractedData = useMemo(() => {
    const rd: any = certificate.review_details
    return Boolean(
      (rd && (rd.producer || rd.insured || (rd.policies && rd.policies.length) || (rd.insurers && rd.insurers.length))) ||
      certificate.carrier || certificate.policy_number || certificate.expiration_date,
    )
  }, [certificate])

  // Default: show the ACORD certificate form first whenever extracted fields exist.
  const [viewMode, setViewMode] = useState<'form' | 'file'>(() => {
    if (initialMode) return initialMode
    if (hasExtractedData) return 'form'
    return hasFile ? 'file' : 'form'
  })

  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [downloadError, setDownloadError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [pdfSource, setPdfSource] = useState<{ url: string; sandboxed: boolean } | null>(null)
  const [imageSource, setImageSource] = useState<string | null>(null)

  const local = !!fileUrl && new URL(fileUrl, window.location.href).origin === window.location.origin &&
    /^\/uploads\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(new URL(fileUrl, window.location.href).pathname)

  const fetchCertificate = (signal?: AbortSignal) => {
    if (!fileUrl) throw new Error('Certificate unavailable')
    if (local && (!sessionToken || getToken() !== sessionToken)) {
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
      throw new Error('Session changed')
    }
    const isSameOrigin = new URL(fileUrl, window.location.href).origin === window.location.origin
    return fetch(fileUrl, {
      credentials: 'same-origin',
      signal,
      headers: {
        ...(isSameOrigin && bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
      ...(isSameOrigin ? { redirect: 'follow' as const } : {}),
    })
  }

  useEffect(() => {
    const dialog = dialogRef.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog?.showModal()
    returnRef.current?.focus()
    return () => {
      dialog?.close()
      document.body.style.overflow = oldOverflow
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [])

  // PDF loading: fetch bytes → blob object URL with application/pdf mime.
  useEffect(() => {
    if (viewMode !== 'file' || kind !== 'pdf' || !fileUrl) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    setStatus('loading')
    setPdfSource(null)
    const loadPdf = async () => {
      let response: Response
      try {
        response = await fetchCertificate(controller.signal)
      } catch {
        if (!controller.signal.aborted) {
          if (docProxyUrl) setPdfSource({ url: docProxyUrl, sandboxed: false })
          else if (signedUrl) setPdfSource({ url: signedUrl, sandboxed: true })
          setStatus('loaded')
        }
        return
      }
      try {
        if (!response.ok) throw new Error('PDF unavailable')
        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted || (local && getToken() !== sessionToken)) return
        const header = new TextDecoder().decode(bytes.slice(0, 1024))
        if (!header.includes('%PDF-')) throw new Error('Not a PDF')
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
        setPdfSource({ url: objectUrl, sandboxed: false })
        setStatus('loaded')
      } catch {
        if (!controller.signal.aborted) setStatus('error')
      }
    }
    void loadPdf()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [viewMode, kind, fileUrl, local, sessionToken, docProxyUrl, signedUrl, bearerToken])

  // Image loading: fetch bytes → raster object URL
  useEffect(() => {
    if (viewMode !== 'file' || kind !== 'image' || !fileUrl) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    setStatus('loading')
    setImageSource(null)
    void (async () => {
      try {
        const response = await fetchCertificate(controller.signal)
        if (!response.ok) throw new Error('Image unavailable')
        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted || getToken() !== sessionToken) return
        const mime = certificate.certificate_mime?.split(';')[0].trim().toLowerCase()
        const type = mime && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)
          ? mime : /\.jpe?g$/i.test(certificate.certificate_name || '') ? 'image/jpeg'
            : /\.gif$/i.test(certificate.certificate_name || '') ? 'image/gif'
              : /\.webp$/i.test(certificate.certificate_name || '') ? 'image/webp' : 'image/png'
        objectUrl = URL.createObjectURL(new Blob([bytes], { type }))
        setImageSource(objectUrl)
        setStatus('loaded')
      } catch {
        if (!controller.signal.aborted) setStatus('error')
      }
    })()
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [viewMode, kind, fileUrl, local, sessionToken, certificate.certificate_mime, certificate.certificate_name, bearerToken])

  const download = async () => {
    const dlUrl = docProxyUrl ? `${docProxyUrl}&download=1` : (signedUrl || fileUrl)
    if (!dlUrl) return
    setDownloading(true)
    setDownloadError(false)
    try {
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = certificate.certificate_name || 'certificate'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      setDownloadError(true)
    } finally {
      setTimeout(() => setDownloading(false), 800)
    }
  }

  const fileLabel = kind === 'pdf' ? 'PDF' : kind === 'image' ? 'Image' : 'File'
  const fileBadge = kind === 'pdf' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-slate-100 text-slate-700 border-slate-200'

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="certificate-viewer-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/70 sm:inset-4 sm:m-auto sm:h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-6xl sm:rounded-2xl print:static print:h-auto print:max-h-none print:w-auto print:max-w-none print:shadow-none print:rounded-none"
    >
      <div className="flex h-full min-h-0 flex-col print:h-auto print:overflow-visible">
        {/* Header */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5 print:hidden">
          <button
            ref={returnRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> {returnLabel}
          </button>
          <div className="min-w-0 flex-1">
            <h2 id="certificate-viewer-title" className="text-sm font-bold">Certificate of Insurance</h2>
            <p className="truncate text-xs text-slate-500" title={certificate.certificate_name || 'Uploaded certificate'}>
              {certificate.sub_company_name || certificate.company_name || certificate.certificate_name || 'Uploaded certificate'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close certificate viewer"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        {/* Tab bar */}
        <div className="shrink-0 flex items-center justify-between gap-2 px-4 border-b border-slate-200 bg-slate-50 text-xs print:hidden">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setViewMode('form')}
              className={`inline-flex items-center gap-1.5 px-3 py-2.5 font-semibold border-b-2 -mb-px transition ${
                viewMode === 'form' ? 'border-indigo-600 text-indigo-700 bg-white' : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> Certificate form (ACORD 25)
            </button>
            <button
              type="button"
              onClick={() => setViewMode('file')}
              className={`inline-flex items-center gap-1.5 px-3 py-2.5 font-semibold border-b-2 -mb-px transition ${
                viewMode === 'file' ? 'border-indigo-600 text-indigo-700 bg-white' : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5" /> Original file
              {hasFile && <span className={`text-[10px] px-1.5 py-0.2 rounded border font-mono ${fileBadge}`}>{fileLabel}</span>}
              {!hasFile && <span className="text-[10px] px-1.5 py-0.2 rounded border font-mono bg-slate-100 text-slate-400">none</span>}
            </button>
          </div>
          <div className="flex items-center gap-1.5 py-1">
            {docProxyUrl && canDownloadPdf && (
              <a
                href={docProxyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 font-medium"
                title="Open the real PDF/image file inline in a new tab"
              >
                Open file in new tab <ExternalLink className="w-3 h-3 text-slate-400" />
              </a>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 font-medium"
            >
              <Printer className="w-3 h-3 text-slate-400" /> Print
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-2 sm:p-4 print:p-0 print:overflow-visible print:bg-white">
          {viewMode === 'form' && (
            <div className="mx-auto max-w-5xl">
              <AcordCertificateForm
                coi={certificate as any}
                extracted={(certificate as any).review_details || null}
                docProxyUrl={docProxyUrl}
                fileUrl={fileUrl}
                hasFile={hasFile}
                onOpenFile={hasFile ? () => setViewMode('file') : undefined}
                onEdit={onEdit}
              />
            </div>
          )}

          {viewMode === 'file' && (
            <div className="h-full flex flex-col">
              {!hasFile || kind === 'unsupported' ? (
                <div className="mx-auto max-w-xl rounded-xl bg-white p-5 text-sm text-slate-700 space-y-2">
                  <p role="status">No previewable file is attached to this certificate. The certificate data can still be viewed and printed as the ACORD form above.</p>
                  <button type="button" onClick={() => setViewMode('form')} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline">
                    ← Back to certificate form view
                  </button>
                </div>
              ) : (
                <>
                  {status === 'loading' && <p role="status" className="mb-3 text-sm text-slate-600">Loading certificate file…</p>}
                  {status === 'error' && (
                    <div className="mb-3 rounded-xl bg-white p-4 text-sm text-rose-700 space-y-2 border border-rose-200">
                      <p role="alert">The file could not be displayed inline. You can still download the original, or view the complete extracted data in the <strong>Certificate form</strong> tab above.</p>
                      <button type="button" onClick={() => setViewMode('form')} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline">
                        ← Switch to certificate form view
                      </button>
                    </div>
                  )}
                  {kind === 'image' && imageSource && (
                    <img
                      src={imageSource}
                      alt={certificate.certificate_name ? `Certificate: ${certificate.certificate_name}` : 'Uploaded certificate'}
                      className="mx-auto h-auto max-w-full rounded bg-white shadow-sm"
                    />
                  )}
                  {kind === 'pdf' && pdfSource && (
                    <iframe
                      src={pdfSource.url}
                      title="Certificate PDF preview"
                      sandbox={pdfSource.sandboxed ? '' : undefined}
                      onError={() => setStatus('error')}
                      className="h-full min-h-[70vh] w-full rounded border border-slate-200 bg-white"
                    />
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-5 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <p>
              {viewMode === 'form'
                ? 'This form view is rendered from extracted certificate fields. The original PDF/image can be opened via the “Original file” tab.'
                : 'If the PDF does not render, use the “Certificate form” tab above, or download the original file below.'}
            </p>
            {hasFile && (
              hasFile && (
                canDownloadPdf ? (
                  <button
                    type="button"
                    onClick={download}
                    disabled={downloading}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Download aria-hidden="true" className="h-4 w-4" /> {downloading ? 'Downloading…' : 'Download original PDF'}
                  </button>
                ) : isOwnCoi ? (
                  <span className="text-xs text-slate-400 italic">
                    PDF copy available once this certificate is verified.
                  </span>
                ) : null
              )
            )}
          </div>
          {downloadError && (
            <p role="alert" className="mt-2 text-xs text-rose-700">Download was blocked or the file is unavailable. Try another browser or ask for a new upload.</p>
          )}
        </footer>
      </div>
    </dialog>,
    document.body,
  )
}
export default CertificateViewer
