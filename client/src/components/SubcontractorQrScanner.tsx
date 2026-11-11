import { useEffect, useId, useRef, useState } from 'react'
import { Camera, QrCode, X } from 'lucide-react'
import jsQR from 'jsqr'
import { parseSubcontractorQr } from '../lib/subcontractorQr'

/** Only display fields returned by the server's authenticated preview endpoint. */
export interface SubcontractorQrPreview {
  companyName: string
  trade?: string | null
}

export interface SubcontractorQrScannerProps {
  /** Fetch a preview for the validated token; do not connect the subcontractor here. */
  onValidToken: (token: string) => Promise<SubcontractorQrPreview>
  /** Connect only after the user explicitly confirms the server-provided preview. */
  onConfirmToken: (token: string) => Promise<void>
  /** Called only after onConfirmToken resolves successfully. */
  onConnected: () => void
  onClose: () => void
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> }
type DetectorConstructor = {
  new (options: { formats: string[] }): Detector
  getSupportedFormats?: () => Promise<string[]>
}
type CameraState = 'idle' | 'requesting' | 'scanning'

const invalidLinkMessage = 'This is not a valid subcontractor connection link for this site. Ask the subcontractor for a new QR code or link.'

/** Mount inside the Add Subcontractor modal when its Scan button is selected. */
export function SubcontractorQrScanner({ onValidToken, onConfirmToken, onConnected, onClose }: SubcontractorQrScannerProps) {
  const id = useId()
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cameraGeneration = useRef(0)
  const operationGeneration = useRef(0)
  const mounted = useRef(true)
  const [cameraState, setCameraState] = useState<CameraState>('idle')
  const [manualLink, setManualLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [preview, setPreview] = useState<{ token: string; company: SubcontractorQrPreview } | null>(null)

  // Invalidating a pending getUserMedia call also stops a stream that resolves later.
  const stopCamera = () => {
    cameraGeneration.current += 1
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    const stream = streamRef.current
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operationGeneration.current += 1
      stopCamera()
    }
  }, [])

  const acceptValue = async (value: string) => {
    stopCamera()
    setCameraState('idle')
    const token = parseSubcontractorQr(value, window.location.origin)
    if (!token) {
      setError(invalidLinkMessage)
      return
    }
    setManualLink('')
    setError(null)
    setPreview(null)
    setLoading(true)
    const operation = ++operationGeneration.current
    try {
      const company = await onValidToken(token)
      if (!mounted.current || operation !== operationGeneration.current) return
      if (!company || typeof company.companyName !== 'string' || !company.companyName.trim()) {
        throw new Error('Missing company name')
      }
      setPreview({ token, company })
    } catch {
      if (mounted.current && operation === operationGeneration.current) {
        setError('Could not find this subcontractor. The link may be invalid or expired; ask for a new one and try again.')
      }
    } finally {
      if (mounted.current && operation === operationGeneration.current) setLoading(false)
    }
  }

  const startCamera = async () => {
    stopCamera()
    const generation = cameraGeneration.current
    setError(null)
    setPreview(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('idle')
      setError('Camera unavailable. Use a secure HTTPS connection and allow camera access, or paste the subcontractor’s link below.')
      return
    }
    setCameraState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      if (!mounted.current || generation !== cameraGeneration.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = stream
      const video = videoRef.current
      if (!video) throw new Error('Camera preview unavailable')
      stream.getTracks().forEach(track => {
        track.onended = () => {
          if (!mounted.current || generation !== cameraGeneration.current) return
          stopCamera()
          setCameraState('idle')
          setError('Camera stopped. Try again or paste the subcontractor’s link below.')
        }
      })
      video.srcObject = stream
      await video.play()
      if (!mounted.current || generation !== cameraGeneration.current) return
      setCameraState('scanning')

      // Native support is optional and may not include QR; jsQR decodes locally otherwise.
      let detector: Detector | null = null
      try {
        const NativeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
        if (NativeDetector && (!NativeDetector.getSupportedFormats || (await NativeDetector.getSupportedFormats()).includes('qr_code'))) {
          detector = new NativeDetector({ formats: ['qr_code'] })
        }
      } catch { /* use the local decoder */ }
      if (!mounted.current || generation !== cameraGeneration.current) return
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      const scan = async () => {
        if (!mounted.current || generation !== cameraGeneration.current) return
        try {
          let value: string | undefined
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
            if (detector) {
              try { value = (await detector.detect(video))[0]?.rawValue }
              catch { detector = null } // Broken native implementations fall back locally.
            }
            if (!detector && context) {
              const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight))
              canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
              canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
              context.drawImage(video, 0, 0, canvas.width, canvas.height)
              const image = context.getImageData(0, 0, canvas.width, canvas.height)
              value = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data
            }
          }
          if (!mounted.current || generation !== cameraGeneration.current) return
          if (value) { void acceptValue(value); return }
          if (!detector && !context) throw new Error('QR decoder unavailable')
          timerRef.current = setTimeout(scan, 200)
        } catch {
          if (!mounted.current || generation !== cameraGeneration.current) return
          stopCamera()
          setCameraState('idle')
          setError('Unable to scan with this camera. Try again or paste the subcontractor’s link below.')
        }
      }
      void scan()
    } catch (err) {
      if (!mounted.current || generation !== cameraGeneration.current) return
      stopCamera()
      setCameraState('idle')
      const denied = err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      setError(denied
        ? 'Camera access was denied. Allow it in your browser settings, or paste the subcontractor’s link below.'
        : 'Camera unavailable. Check your camera and use HTTPS, or paste the subcontractor’s link below.')
    }
  }

  const close = () => {
    operationGeneration.current += 1
    stopCamera()
    onClose()
  }

  const confirm = async () => {
    if (!preview || confirming) return
    const operation = ++operationGeneration.current
    setConfirming(true)
    setError(null)
    try {
      await onConfirmToken(preview.token)
    } catch {
      if (mounted.current && operation === operationGeneration.current) {
        setError('Unable to record this test relationship. Please try again or request a new link.')
      }
      return
    } finally {
      if (mounted.current && operation === operationGeneration.current) setConfirming(false)
    }
    if (!mounted.current || operation !== operationGeneration.current) return
    stopCamera()
    onConnected()
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-brand-600"><QrCode aria-hidden="true" className="h-4 w-4" /> Test connection</div>
          <h3 id={`${id}-title`} className="mt-1 text-lg font-extrabold text-slate-900">Scan subcontractor QR</h3>
          <p className="mt-1 text-sm text-slate-600">Scan the subcontractor’s connection code, or paste their link. Review the company before recording a test relationship.</p>
        </div>
        <button type="button" onClick={close} disabled={confirming} aria-label="Close QR scanner" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50"><X aria-hidden="true" className="h-5 w-5" /></button>
      </div>

      <div className={cameraState === 'idle' ? 'hidden' : 'relative overflow-hidden rounded-xl bg-slate-900'}>
        <video ref={videoRef} autoPlay muted playsInline aria-hidden="true" className="aspect-[4/3] max-h-80 w-full object-cover" />
        {cameraState === 'requesting' && <p className="absolute inset-0 flex items-center justify-center text-sm text-white">Waiting for camera permission…</p>}
      </div>
      {cameraState === 'scanning' && <p role="status" className="text-sm text-slate-600">Point your camera at the subcontractor’s QR code.</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
      {loading && <p role="status" className="text-sm text-slate-600">Looking up subcontractor…</p>}

      {!preview && <>
        <div className="flex flex-wrap gap-2">
          {cameraState === 'idle' ? <button type="button" onClick={() => void startCamera()} disabled={loading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50"><Camera aria-hidden="true" className="h-4 w-4" /> Start camera</button> : <button type="button" onClick={() => { stopCamera(); setCameraState('idle') }} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Stop camera</button>}
        </div>
        <div className="space-y-2 border-t border-slate-100 pt-4">
          <label htmlFor={`${id}-link`} className="block text-sm font-semibold text-slate-700">Or paste the connection link</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input id={`${id}-link`} type="text" inputMode="url" autoComplete="off" spellCheck={false} value={manualLink} onChange={e => setManualLink(e.target.value)} placeholder="https://…/connect-sub#…" className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2 text-base text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <button type="button" disabled={loading || !manualLink} onClick={() => void acceptValue(manualLink)} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Look up</button>
          </div>
          <p className="text-xs text-slate-500">Camera access requires HTTPS and permission. Links are checked locally and never opened.</p>
        </div>
      </>}

      {preview && <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Review subcontractor</p><p className="mt-1 break-words text-base font-bold text-slate-900">{preview.company.companyName}</p>{preview.company.trade && <p className="mt-1 text-sm text-slate-600">{preview.company.trade}</p>}</div>
        <p className="text-sm text-slate-600">This company and trade are self-reported, not independently verified. Confirm the company before recording a test relationship. No live link or COI sharing will be created.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void confirm()} disabled={confirming} className="min-h-11 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50">{confirming ? 'Recording…' : 'Confirm test relationship'}</button>
          <button type="button" disabled={confirming} onClick={() => { setPreview(null); setError(null) }} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Scan another</button>
        </div>
      </div>}
    </section>
  )
}
