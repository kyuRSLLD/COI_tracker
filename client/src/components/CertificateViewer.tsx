import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Download, X } from 'lucide-react'
import type { COI } from '../types'

type Certificate = Pick<COI, 'certificate_url' | 'certificate_name' | 'certificate_mime'>
type PreviewKind = 'image' | 'pdf' | 'unsupported'

// Only raster images and PDFs are previewed. In particular, SVG and HTML are not.
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
}

export function CertificateViewer({ certificate, onClose, returnLabel }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnRef = useRef<HTMLButtonElement>(null)
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [downloadError, setDownloadError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [pdfSource, setPdfSource] = useState<{ url: string; sandboxed: boolean } | null>(null)
  const url = safeCertificateUrl(certificate.certificate_url)
  const kind = certificatePreviewKind(certificate)

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

  useEffect(() => {
    if (kind !== 'pdf' || !url) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    setStatus('loading')
    setPdfSource(null)
    const loadPdf = async () => {
      let response: Response
      try {
        response = await fetch(url, { credentials: 'same-origin', signal: controller.signal })
      } catch {
        if (!controller.signal.aborted) {
          // Signed cross-origin URLs may not allow fetch/CORS. Some browsers can
          // still display a PDF in this script-free sandbox; others cannot.
          setPdfSource({ url, sandboxed: true })
          setStatus('loaded')
        }
        return
      }
      try {
        if (!response.ok) throw new Error('PDF unavailable')
        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted) return
        const header = new TextDecoder().decode(bytes.slice(0, 1024))
        if (!header.includes('%PDF-')) throw new Error('Not a PDF')
        // The blob's fixed type prevents a mislabeled HTML response from being
        // interpreted as HTML, while allowing native PDF viewers to work.
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
  }, [kind, url])

  // Frame load events do not reliably report PDF renderer failures, so guidance
  // remains visible even after loading.
  const download = async () => {
    if (!url) return
    setDownloading(true)
    setDownloadError(false)
    try {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('Download failed')
      // Force a download instead of navigating to potentially executable HTML.
      const blob = new Blob([await response.arrayBuffer()], { type: 'application/octet-stream' })
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = certificate.certificate_name || 'certificate'
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    } catch {
      setDownloadError(true)
    } finally {
      setDownloading(false)
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="certificate-viewer-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      className="fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/70 sm:inset-4 sm:m-auto sm:h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:max-w-6xl sm:rounded-2xl"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
          <button ref={returnRef} type="button" onClick={onClose} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" /> {returnLabel}
          </button>
          <div className="min-w-0 flex-1">
            <h2 id="certificate-viewer-title" className="text-sm font-bold">Certificate document</h2>
            <p className="truncate text-xs text-slate-500" title={certificate.certificate_name || 'Uploaded certificate'}>{certificate.certificate_name || 'Uploaded certificate'}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close certificate viewer" className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-3 sm:p-5">
          {!url || kind === 'unsupported' ? (
            <p role="status" className="mx-auto max-w-xl rounded-xl bg-white p-5 text-sm text-slate-700">This file cannot be previewed here. Please ask for a PDF or a JPG, PNG, GIF, or WebP image.</p>
          ) : (
            <>
              {status === 'loading' && <p role="status" className="mb-3 text-sm text-slate-600">Loading certificate…</p>}
              {status === 'error' && <p role="alert" className="mb-3 rounded-xl bg-white p-4 text-sm text-rose-700">The certificate could not be displayed. The link may have expired or the file may be unavailable.</p>}
              {kind === 'image' ? (
                <img src={url} alt={certificate.certificate_name ? `Certificate: ${certificate.certificate_name}` : 'Uploaded certificate'} onLoad={() => setStatus('loaded')} onError={() => setStatus('error')} className="mx-auto h-auto max-w-full rounded bg-white shadow-sm" />
              ) : pdfSource && (
                <iframe src={pdfSource.url} title="Certificate PDF preview" sandbox={pdfSource.sandboxed ? '' : undefined} onError={() => setStatus('error')} className="h-full min-h-[60vh] w-full rounded border border-slate-200 bg-white" />
              )}
            </>
          )}
        </div>
        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <p>{kind === 'pdf' && url ? 'If the PDF does not appear, your browser may not support this preview. Try downloading it or use another browser.' : 'If the preview is unavailable, try downloading the file or ask for a new upload.'}</p>
            {url && <button type="button" onClick={download} disabled={downloading} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Download aria-hidden="true" className="h-4 w-4" /> {downloading ? 'Downloading…' : 'Download original'}</button>}
          </div>
          {downloadError && <p role="alert" className="mt-2 text-xs text-rose-700">Download was blocked or the link expired. Try another browser or ask for a new upload.</p>}
        </footer>
      </div>
    </dialog>,
    document.body,
  )
}
