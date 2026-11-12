import { useLayoutEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

export type CameraQrScannerProps = {
  /** Change this whenever the verified parent session changes; never include it in the decoded result. */
  sessionKey: string | null
  /** Receives the complete validated SafeCOI connection URL, not just its token. */
  onDecoded: (value: string) => void
  onClose: () => void
}

type ScannerStatus = 'idle' | 'requesting' | 'scanning' | 'decoded' | 'error'

// Keep this in sync with tokenFromQr in ConnectionOptions. Never navigate to a QR URL.
const SAFE_COI_LINK = /^https:\/\/(?:www\.)?safecoi\.com\/connect-sub#[A-Za-z0-9_-]{43}(?![\s\S])/
const SCAN_INTERVAL_MS = 150
const MAX_FRAME_DIMENSION = 1280

function cameraErrorMessage(error: unknown): string {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'Camera permission was denied or blocked. Allow camera access in your browser settings, then try again, or upload a screenshot instead.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No suitable camera was found. Connect a camera and try again, or upload a screenshot instead.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'The camera could not be started. Close other apps using it and try again, or upload a screenshot instead.'
  }
  return 'Could not use the camera. Please try again or upload a screenshot instead.'
}

/** A local-only QR reader. Mount it for the current session and supply a new sessionKey on session changes. */
export function CameraQrScanner({ sessionKey, onDecoded, onClose }: CameraQrScannerProps) {
  const [status, setStatus] = useState<ScannerStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [invalidCode, setInvalidCode] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameRef = useRef<number | null>(null)
  const detachTracksRef = useRef<(() => void) | null>(null)
  const generationRef = useRef(0)
  const startingRef = useRef(false)
  const callbacksRef = useRef({ onDecoded, onClose })
  callbacksRef.current = { onDecoded, onClose }

  const supported = typeof window !== 'undefined' && window.isSecureContext &&
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  // Also invalidates an unresolved getUserMedia/play promise; a late stream is stopped on arrival.
  const stop = () => {
    generationRef.current++
    startingRef.current = false
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    detachTracksRef.current?.()
    detachTracksRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  // Layout cleanup makes a committed session change invalidate the old camera before paint.
  useLayoutEffect(() => {
    setStatus('idle')
    setError(null)
    setInvalidCode(false)
    return stop
  }, [sessionKey])

  const close = () => {
    stop()
    setStatus('idle')
    setError(null)
    setInvalidCode(false)
    callbacksRef.current.onClose()
  }

  const start = async () => {
    if (!supported || !sessionKey || startingRef.current || streamRef.current) return
    startingRef.current = true
    const generation = ++generationRef.current
    setStatus('requesting')
    setError(null)
    setInvalidCode(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })
      if (generation !== generationRef.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      streamRef.current = stream
      const cameraEnded = () => {
        if (generation !== generationRef.current) return
        stop()
        setStatus('error')
        setError('Camera access ended. Please try again or upload a screenshot instead.')
      }
      const tracks = stream.getTracks()
      tracks.forEach(track => track.addEventListener('ended', cameraEnded))
      detachTracksRef.current = () => tracks.forEach(track => track.removeEventListener('ended', cameraEnded))
      const video = videoRef.current
      if (!video) throw new Error('Video unavailable')
      video.srcObject = stream
      await video.play()
      if (generation !== generationRef.current) return
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Canvas unavailable')
      startingRef.current = false
      setStatus('scanning')
      let lastScan = 0
      let showedInvalid = false
      const scan = (timestamp: number) => {
        if (generation !== generationRef.current) return
        if (timestamp - lastScan >= SCAN_INTERVAL_MS && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          lastScan = timestamp
          let decodedValue: string | null = null
          try {
            const scale = Math.min(1, MAX_FRAME_DIMENSION / Math.max(video.videoWidth, video.videoHeight))
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
            const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
            if (code && SAFE_COI_LINK.test(code.data)) {
              decodedValue = code.data
            } else if (code && !showedInvalid) {
              showedInvalid = true
              setInvalidCode(true)
            }
          } catch {
            if (generation !== generationRef.current) return
            stop()
            setStatus('error')
            setError('Could not read camera frames. Please try again or upload a screenshot instead.')
            return
          }
          if (decodedValue !== null) {
            stop()
            setStatus('decoded')
            setInvalidCode(false)
            callbacksRef.current.onDecoded(decodedValue)
            return
          }
        }
        frameRef.current = requestAnimationFrame(scan)
      }
      frameRef.current = requestAnimationFrame(scan)
    } catch (err) {
      if (generation !== generationRef.current) return
      stop()
      setStatus('error')
      setError(cameraErrorMessage(err))
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 p-3 text-xs text-slate-700" aria-label="Camera QR scanner">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-900">Scan a subcontractor QR code</h3>
        <button type="button" onClick={close} className="rounded-lg px-2 py-1 font-semibold text-slate-700 underline">Close scanner</button>
      </div>
      {!supported ? (
        <p role="status">Camera scanning is unavailable in this browser or on this connection. Use a secure HTTPS page with a supported browser, or upload a screenshot instead.</p>
      ) : !sessionKey ? (
        <p role="status">A verified session is required before using the camera.</p>
      ) : (
        <>
          <p>The camera starts only when you choose Start camera. Video is processed on this device and is not uploaded.</p>
          <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" className={`w-full max-w-md rounded-lg bg-slate-900 ${status === 'scanning' || status === 'requesting' ? 'block' : 'hidden'}`} />
          {status === 'requesting' && <p role="status">Waiting for camera access…</p>}
          {status === 'scanning' && <p role="status">Point the camera at the subcontractor’s SafeCOI connection QR code.</p>}
          {status === 'decoded' && <p role="status">Connection QR detected. Camera stopped.</p>}
          {invalidCode && status === 'scanning' && <p role="status">That QR code is not a SafeCOI subcontractor connection code. Try another.</p>}
          {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">{error}</p>}
          {(status === 'idle' || status === 'error' || status === 'decoded') && <button type="button" onClick={() => void start()} className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-800">{status === 'idle' ? 'Start camera' : 'Try camera again'}</button>}
        </>
      )}
    </section>
  )
}
