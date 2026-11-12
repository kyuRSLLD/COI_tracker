import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import './gc-connections.css'

// These paths are fixed to the V2 contracts. Capabilities are accepted only as raw values.
const CONNECTIONS = '/api/v2/connections'
const METADATA = '/api/v2/self-reported-coi-metadata'
const RAW_QR_TOKEN = /^[A-Za-z0-9_-]{43}$/

type Profile = { id: string; profile_id: string; company_name: string; trade: string; evidence_type: string }
type RecordItem = { id: string; profile_id: string; carrier: string; effective_date: string; expiration_date: string; created_at: string; coverage: { type: string; limitCents: number }[] }
type Result<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T }
type Detector = { detect: (image: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> }
type DetectorConstructor = new (options: { formats: string[] }) => Detector

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function profiles(value: unknown): Profile[] {
  if (!object(value) || !Array.isArray(value.subcontractors)) throw new Error('Invalid response')
  return value.subcontractors.map((p: unknown) => {
    if (!object(p) || typeof p.id !== 'string' || typeof p.profile_id !== 'string' || typeof p.company_name !== 'string' || typeof p.trade !== 'string' || typeof p.evidence_type !== 'string') throw new Error('Invalid response')
    return { id: p.id, profile_id: p.profile_id, company_name: p.company_name, trade: p.trade, evidence_type: p.evidence_type }
  })
}
function records(value: unknown): RecordItem[] {
  if (!object(value) || !Array.isArray(value.records)) throw new Error('Invalid response')
  return value.records.map((r: unknown) => {
    if (!object(r) || typeof r.id !== 'string' || typeof r.profile_id !== 'string' || typeof r.carrier !== 'string' || typeof r.effective_date !== 'string' || typeof r.expiration_date !== 'string' || typeof r.created_at !== 'string' || r.reporting_status !== 'self_reported_unverified' || !Array.isArray(r.coverage)) throw new Error('Invalid response')
    const coverage = r.coverage.map((c: unknown) => {
      if (!object(c) || typeof c.type !== 'string' || typeof c.limitCents !== 'number' || !Number.isSafeInteger(c.limitCents) || c.limitCents < 0) throw new Error('Invalid response')
      return { type: c.type, limitCents: c.limitCents }
    })
    return { id: r.id, profile_id: r.profile_id, carrier: r.carrier, effective_date: r.effective_date, expiration_date: r.expiration_date, created_at: r.created_at, coverage }
  })
}

async function request(path: string, authorizationToken: string, signal: AbortSignal, body?: object): Promise<Response> {
  return fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${authorizationToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  })
}
function loadError(status?: number) {
  if (status === 401) return 'Your session could not be authenticated. Sign in again.'
  if (status === 429) return 'Too many requests. Please wait and try again.'
  return 'This information is unavailable right now. Try refreshing.'
}

function CameraScanner({ onScan, onMessage }: { onScan: (raw: string) => void; onMessage: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    let stopped = false
    let stream: MediaStream | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); stream?.getTracks().forEach(track => track.stop()) }
    const start = async () => {
      const BarcodeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
      if (!BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
        onMessage('Camera QR scanning is not supported in this browser or context. Enter the raw code manually.')
        return
      }
      try {
        const detector = new BarcodeDetector({ formats: ['qr_code'] })
        const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        if (stopped) { acquired.getTracks().forEach(track => track.stop()); return }
        stream = acquired
        if (!video.current) { stop(); return }
        video.current.srcObject = stream
        await video.current.play()
        if (stopped) return
        const scan = async () => {
          if (stopped || !video.current) return
          try {
            const found = await detector.detect(video.current)
            if (stopped) return
            if (found.length && typeof found[0].rawValue === 'string') {
              const raw = found[0].rawValue
              stop()
              onScan(raw)
              return
            }
          } catch {
            if (!stopped) { stop(); onMessage('Camera scanning failed. Enter the raw code manually or try again.') }
            return
          }
          if (!stopped) timer = setTimeout(scan, 250)
        }
        void scan()
      } catch (error) {
        if (stopped) return
        stop()
        const name = error instanceof Error ? error.name : ''
        onMessage(name === 'NotAllowedError' || name === 'PermissionDeniedError'
          ? 'Camera permission was denied. Allow camera access in your browser or enter the raw code manually.'
          : 'The camera could not start. Check browser support and permissions, or enter the raw code manually.')
      }
    }
    void start()
    return stop
  }, [onScan, onMessage])
  return <video ref={video} className="v2gc-video" aria-label="Camera preview for scanning a subcontractor QR code" muted playsInline />
}

/** Mount with a current GC access token. Do not persist it; replace/unmount on logout. */
export function GcConnections({ authorizationToken, connectionOnly = false }: { authorizationToken: string; connectionOnly?: boolean }) {
  // A credential or mode change destroys visible data and aborts outstanding work.
  return <GcConnectionsSession key={`${authorizationToken}:${connectionOnly}`} authorizationToken={authorizationToken} connectionOnly={connectionOnly} />
}

function GcConnectionsSession({ authorizationToken, connectionOnly }: { authorizationToken: string; connectionOnly: boolean }) {
  const instanceId = useId()
  const [subs, setSubs] = useState<Result<Profile[]>>({ state: 'loading' })
  const [metadata, setMetadata] = useState<Result<RecordItem[]>>({ state: 'loading' })
  const [manual, setManual] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const redeemController = useRef<AbortController | null>(null)
  const redeeming = useRef(false)
  const alive = useRef(false)

  const refresh = useCallback(() => {
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    setSubs({ state: 'loading' })
    setMetadata({ state: 'loading' })
    const load = async <T,>(path: string, parse: (value: unknown) => T, update: (value: Result<T>) => void) => {
      try {
        const response = await request(path, authorizationToken, controller.signal)
        if (!response.ok) { if (!controller.signal.aborted) update({ state: 'error', message: loadError(response.status) }); return }
        const data = parse(await response.json())
        if (!controller.signal.aborted) update({ state: 'ready', value: data })
      } catch {
        if (!controller.signal.aborted) update({ state: 'error', message: loadError() })
      }
    }
    void load(`${CONNECTIONS}/subcontractors`, profiles, setSubs)
    if (!connectionOnly) void load(`${METADATA}/granted`, records, setMetadata)
  }, [authorizationToken, connectionOnly])

  useEffect(() => {
    alive.current = true
    if (authorizationToken) refresh()
    else { setSubs({ state: 'error', message: 'A GC session is required.' }); setMetadata({ state: 'error', message: 'A GC session is required.' }) }
    return () => { alive.current = false; loadController.current?.abort(); redeemController.current?.abort() }
  }, [authorizationToken, refresh])

  const redeem = useCallback(async (raw: string) => {
    setScanning(false)
    setManual('')
    if (redeeming.current) return
    if (raw.length !== 43 || !RAW_QR_TOKEN.test(raw)) {
      setMessage({ kind: 'alert', text: 'Invalid code format. Use only the raw 43-character code; links and query strings are not accepted.' })
      return
    }
    if (!authorizationToken) { setMessage({ kind: 'alert', text: 'A GC session is required.' }); return }
    redeeming.current = true
    const controller = new AbortController()
    redeemController.current = controller
    setBusy(true)
    setMessage({ kind: 'status', text: 'Connecting subcontractor…' })
    try {
      const response = await request(`${CONNECTIONS}/qr/redeem`, authorizationToken, controller.signal, { token: raw })
      if (controller.signal.aborted || !alive.current) return
      if (response.status === 204) {
        setMessage({ kind: 'status', text: connectionOnly ? 'Connected. Refreshing your subcontractors.' : 'Connected. Refreshing your subcontractors and granted metadata.' })
        refresh()
      } else if (response.status === 404) {
        setMessage({ kind: 'alert', text: 'This code is unavailable. It may have expired, already been used, been revoked, or be invalid. Ask the subcontractor for a new code.' })
      } else if (response.status === 401) {
        setMessage({ kind: 'alert', text: 'Your session could not be authenticated. Sign in again.' })
      } else if (response.status === 429) {
        setMessage({ kind: 'alert', text: 'Too many requests. Please wait and ask for a new code if needed.' })
      } else {
        setMessage({ kind: 'alert', text: 'The connection could not be confirmed. The code may have been consumed; refresh your list before requesting a new code.' })
      }
    } catch {
      if (!controller.signal.aborted && alive.current) setMessage({ kind: 'alert', text: 'The connection could not be confirmed. The code may have been consumed; refresh your list before requesting a new code.' })
    } finally {
      redeeming.current = false
      if (!controller.signal.aborted && alive.current) setBusy(false)
    }
  }, [authorizationToken, connectionOnly, refresh])
  const cameraMessage = useCallback((text: string) => { setScanning(false); setMessage({ kind: 'alert', text }) }, [])

  return <main className="v2gc">
    <header className="v2gc-header">
      <div><p className="v2gc-eyebrow">GC workflow · V2</p><h1>Subcontractor connections</h1><p>{connectionOnly ? 'Connect using a subcontractor’s one-time raw QR code. This connection-only interface does not upload or access files or insurance metadata, and does not verify insurance. Existing grants are not changed.' : 'Connect using a subcontractor’s one-time raw QR code. A connection shares a profile only; COI metadata requires a separate explicit grant.'}</p></div>
      <button type="button" className="v2gc-secondary" onClick={refresh} disabled={!authorizationToken}>Refresh list</button>
    </header>
    <section className="v2gc-panel" aria-labelledby={`${instanceId}-connect-heading`}>
      <h2 id={`${instanceId}-connect-heading`}>Connect a subcontractor</h2>
      <p>Scan the code directly, or enter the raw 43-character code. Do not enter a URL. Codes can be used only once.</p>
      {!scanning ? <button type="button" onClick={() => { setMessage(null); setScanning(true) }} disabled={busy || !authorizationToken}>Start camera</button> : <><CameraScanner onScan={redeem} onMessage={cameraMessage} /><button type="button" className="v2gc-secondary" onClick={() => setScanning(false)}>Stop camera</button></>}
      <form onSubmit={event => { event.preventDefault(); void redeem(manual) }} autoComplete="off" className="v2gc-form">
        <label htmlFor={`${instanceId}-manual`}>Raw one-time code</label>
        <div className="v2gc-form-row"><input id={`${instanceId}-manual`} type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={manual} onChange={event => setManual(event.target.value)} disabled={busy} /><button type="submit" disabled={busy || !authorizationToken}>Connect</button></div>
      </form>
      {message && <p className={`v2gc-message ${message.kind}`} role={message.kind}>{message.text}</p>}
    </section>
    <section aria-labelledby={`${instanceId}-subs-heading`}>
      <div className="v2gc-section-heading"><h2 id={`${instanceId}-subs-heading`}>Connected subcontractors</h2><span className="v2gc-badge">SELF-REPORTED</span></div>
      <p>Profile details are self-reported. Email control does not verify a company, authority, or insurance. No documents are available here.</p>
      {subs.state === 'loading' && <p role="status">Loading connected profiles…</p>}
      {subs.state === 'error' && <p role="alert">Connected profiles: {subs.message}</p>}
      {subs.state === 'ready' && subs.value.length === 0 && <p>No connected subcontractors are currently available.</p>}
      {subs.state === 'ready' && subs.value.map(sub => <article className="v2gc-panel v2gc-profile" key={sub.profile_id}>
        <h3>{sub.company_name}</h3><span className="v2gc-badge">SELF-REPORTED</span>
        <dl><div><dt>Trade</dt><dd>{sub.trade}</dd></div><div><dt>Profile ID</dt><dd>{sub.profile_id}</dd></div><div><dt>Evidence</dt><dd>{sub.evidence_type === 'fresh_self_asserted_email_control_v1' ? 'Email control only' : 'Unrecognized evidence type'}</dd></div></dl>
        {!connectionOnly && <><h4>Separately granted COI metadata</h4>
        {metadata.state === 'loading' && <p role="status">Loading granted metadata…</p>}
        {metadata.state === 'error' && <p role="alert">Granted metadata: {metadata.message}</p>}
        {metadata.state === 'ready' && metadata.value.filter(record => record.profile_id === sub.profile_id).length === 0 && <p>No explicitly granted metadata is currently available for this profile.</p>}
        {metadata.state === 'ready' && metadata.value.filter(record => record.profile_id === sub.profile_id).map(record => <div className="v2gc-record" key={record.id}>
          <p><strong>SELF-REPORTED · UNVERIFIED</strong></p>
          <dl><div><dt>Carrier</dt><dd>{record.carrier}</dd></div><div><dt>Effective date</dt><dd>{record.effective_date}</dd></div><div><dt>Expiration date</dt><dd>{record.expiration_date}</dd></div><div><dt>Record ID</dt><dd>{record.id}</dd></div><div><dt>Reported at</dt><dd>{record.created_at}</dd></div></dl>
          <p>Reported coverage:</p><ul>{record.coverage.map((item, index) => <li key={index}>{item.type}: {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(item.limitCents / 100)}</li>)}</ul>
          <p>These details are not proof of coverage. No certificate or document access is provided.</p>
        </div>)}</>}
      </article>)}
    </section>
  </main>
}
