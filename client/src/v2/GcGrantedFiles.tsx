import { useEffect, useId, useRef, useState } from 'react'
import './gc-granted-files.css'

const ROOT = '/api/v2/self-reported-private-files'
const MAX_BYTES = 10 * 1024 * 1024
const PREVIEW_DEADLINE_MS = 30_000
const TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

type GrantedFile = { id: string; coiId: string; mime: string; sizeBytes: number; createdAt: string; reportingStatus: 'self_reported_unverified' }
type Page = { files: GrantedFile[]; nextCursor: string | null }
type Listing = { state: 'loading' | 'error' } | { state: 'ready'; files: GrantedFile[]; cursor: string | null }
type Viewer = { file: GrantedFile; state: 'loading' | 'error' } | { file: GrantedFile; state: 'ready'; url: string }

export type GcGrantedFilesProps = {
  /** In-memory auth-v2 GC bearer token. The host must clear or replace it on every session change. */
  authorizationToken: string
  /** A trusted server limit, if lower than the 10 MiB protocol ceiling. */
  maxFileBytes?: number
}

function parsePage(value: unknown): Page {
  if (!value || typeof value !== 'object') throw new Error('Unavailable')
  const page = value as Record<string, unknown>
  if (!Array.isArray(page.files) || page.files.length > 100 || !(page.nextCursor === null || uuid(page.nextCursor))) throw new Error('Unavailable')
  const files = page.files.map((item: unknown): GrantedFile => {
    if (!item || typeof item !== 'object') throw new Error('Unavailable')
    const f = item as Record<string, unknown>
    if (!uuid(f.id) || !uuid(f.coiId) || typeof f.mime !== 'string' || !TYPES.has(f.mime) || !Number.isSafeInteger(f.sizeBytes) || (f.sizeBytes as number) < 1 || (f.sizeBytes as number) > MAX_BYTES || typeof f.createdAt !== 'string' || f.createdAt.length > 128 || !Number.isFinite(Date.parse(f.createdAt)) || f.reportingStatus !== 'self_reported_unverified') throw new Error('Unavailable')
    return { id: f.id, coiId: f.coiId, mime: f.mime, sizeBytes: f.sizeBytes as number, createdAt: f.createdAt, reportingStatus: 'self_reported_unverified' }
  })
  if (new Set(files.map(f => f.id)).size !== files.length) throw new Error('Unavailable')
  return { files, nextCursor: page.nextCursor as string | null }
}

async function request(token: string, path: string, signal: AbortSignal, after?: string): Promise<Response> {
  const response = await fetch(path, {
    method: after ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(after ? { 'Content-Type': 'application/json' } : {}) },
    ...(after ? { body: JSON.stringify({ after }) } : {}),
    signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error('Unavailable')
  return response
}

// Reject mismatched type, declared length, truncated data and oversized streams before creating a URL.
async function readBounded(response: Response, file: GrantedFile, limit: number, signal: AbortSignal): Promise<Blob> {
  const length = response.headers.get('content-length')
  if (response.headers.get('content-type') !== file.mime || !response.body || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== file.sizeBytes))) {
    await response.body?.cancel()
    throw new Error('Unavailable')
  }
  const reader = response.body.getReader(), chunks: ArrayBuffer[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (signal.aborted) { await reader.cancel(); throw new Error('Unavailable') }
      if (part.done) break
      total += part.value.byteLength
      if (total > file.sizeBytes || total > limit) { await reader.cancel(); throw new Error('Unavailable') }
      chunks.push(new Uint8Array(part.value).buffer)
    }
  } finally { reader.releaseLock() }
  if (total !== file.sizeBytes || signal.aborted) throw new Error('Unavailable')
  return new Blob(chunks, { type: file.mime })
}

function Session({ token, limit }: { token: string; limit: number }) {
  const id = useId()
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [paging, setPaging] = useState(false)
  const listRequest = useRef<AbortController | null>(null)
  const pageRequest = useRef<AbortController | null>(null)
  const viewRequest = useRef<AbortController | null>(null)
  const objectUrl = useRef<string | null>(null)
  const active = useRef(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const refreshButton = useRef<HTMLButtonElement>(null)

  function discardPreview() {
    viewRequest.current?.abort(); viewRequest.current = null
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null
  }
  function closeViewer(restoreFocus = true) {
    discardPreview(); setViewer(null)
    if (restoreFocus) {
      const target = opener.current
      requestAnimationFrame(() => { if (target?.isConnected) target.focus(); else refreshButton.current?.focus() })
    }
  }
  function load() {
    listRequest.current?.abort(); pageRequest.current?.abort(); pageRequest.current = null
    closeViewer(false); setPaging(false); setListing({ state: 'loading' })
    const controller = new AbortController(); listRequest.current = controller
    void (async () => {
      try {
        const response = await request(token, `${ROOT}/granted/list`, controller.signal)
        const page = parsePage(await response.json())
        if (active.current && !controller.signal.aborted && listRequest.current === controller) setListing({ state: 'ready', files: page.files, cursor: page.nextCursor })
      } catch {
        if (active.current && !controller.signal.aborted && listRequest.current === controller) setListing({ state: 'error' })
      }
    })()
  }
  useEffect(() => {
    active.current = true; load()
    return () => {
      active.current = false
      listRequest.current?.abort(); pageRequest.current?.abort(); discardPreview()
    }
  }, [])
  useEffect(() => {
    if (viewer && dialog.current && !dialog.current.open) { dialog.current.showModal(); back.current?.focus() }
  }, [viewer])

  async function more() {
    if (listing.state !== 'ready' || !listing.cursor || pageRequest.current) return
    const cursor = listing.cursor, controller = new AbortController()
    pageRequest.current = controller; setPaging(true)
    try {
      const response = await request(token, `${ROOT}/granted/list`, controller.signal, cursor)
      const page = parsePage(await response.json())
      if (page.nextCursor === cursor) throw new Error('Unavailable')
      if (active.current && !controller.signal.aborted && pageRequest.current === controller) {
        setListing(old => old.state === 'ready' ? { state: 'ready', files: [...old.files, ...page.files.filter(f => !old.files.some(previous => previous.id === f.id))], cursor: page.nextCursor } : old)
      }
    } catch {
      if (active.current && !controller.signal.aborted && pageRequest.current === controller) setListing({ state: 'error' })
    } finally {
      if (pageRequest.current === controller) { pageRequest.current = null; if (active.current) setPaging(false) }
    }
  }
  async function open(file: GrantedFile, button: HTMLElement) {
    discardPreview(); opener.current = button
    const controller = new AbortController(); viewRequest.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, PREVIEW_DEADLINE_MS)
    let onAbort: () => void = () => {}
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Unavailable'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    setViewer({ file, state: 'loading' })
    try {
      const blob = await Promise.race([stopped, (async () => {
        const response = await request(token, `${ROOT}/granted/${file.id}`, controller.signal)
        return readBounded(response, file, limit, controller.signal)
      })()])
      if (active.current && !controller.signal.aborted && viewRequest.current === controller) {
        const url = URL.createObjectURL(blob); objectUrl.current = url
        setViewer({ file, state: 'ready', url })
      }
    } catch {
      if (active.current && (!controller.signal.aborted || timedOut) && viewRequest.current === controller) {
        // Any authorization or transport failure invalidates the old list; never claim access still exists.
        pageRequest.current?.abort(); pageRequest.current = null; setPaging(false)
        setListing({ state: 'error' }); setViewer({ file, state: 'error' })
      }
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort)
      if (viewRequest.current === controller) viewRequest.current = null
    }
  }

  return <main className="gc-files">
    <header className="gcf-header"><div><p className="gcf-kicker">GC WORKSPACE / PRIVATE FILES</p><h1>Shared certificate files</h1><p>Only files separately shared with this GC account are listed. A profile connection or metadata consent alone does not share a file.</p></div><button ref={refreshButton} type="button" className="gcf-secondary" onClick={load}>Refresh list</button></header>
    <section className="gcf-panel" aria-labelledby={`${id}-heading`}>
      <div className="gcf-title"><div><p className="gcf-kicker">FILE-SPECIFIC CONSENT</p><h2 id={`${id}-heading`}>Files from the last list response</h2></div><span className="gcf-badge">SELF-REPORTED · UNVERIFIED</span></div>
      <p>File contents and insurance are self-reported, not verified. The list is not a live access guarantee: sharing may change at any time. Access is checked again when you open a file.</p>
      {listing.state === 'loading' && <p role="status">Loading shared files…</p>}
      {listing.state === 'error' && <p role="alert">Files are unavailable or access may have changed. Refresh the list and check your session.</p>}
      {listing.state === 'ready' && (listing.files.length === 0 ? <p>No separately shared files were returned.</p> : <ul className="gcf-list">{listing.files.map(file => <li key={file.id}><div><strong>{file.mime === 'application/pdf' ? 'PDF document' : 'Image document'}</strong><p>File ID: <span>{file.id}</span><br />Record ID: <span>{file.coiId}</span><br />{file.sizeBytes.toLocaleString()} bytes · {new Date(file.createdAt).toLocaleString()}</p>{file.sizeBytes > limit && <p>This file exceeds the configured preview limit.</p>}</div><button type="button" disabled={file.sizeBytes > limit} onClick={event => void open(file, event.currentTarget)} aria-label={`View file ${file.id}`}>View file</button></li>)}</ul>)}
      {listing.state === 'ready' && listing.cursor && <button type="button" className="gcf-secondary" onClick={() => void more()} disabled={paging}>{paging ? 'Loading…' : 'Load more files'}</button>}
      <p className="gcf-note">Pages are not a snapshot. Previously delivered bytes cannot be recalled after access is revoked. A preview does not verify coverage or guarantee file safety.</p>
    </section>
    {viewer && <dialog ref={dialog} className="gcf-dialog" aria-labelledby={`${id}-viewer`} onCancel={event => { event.preventDefault(); closeViewer() }}><div className="gcf-dialog-head"><div><p className="gcf-kicker">PRIVATE PREVIEW</p><h2 id={`${id}-viewer`}>Self-reported document</h2></div><button ref={back} type="button" className="gcf-secondary" onClick={() => closeViewer()}>Back to files</button></div>
      <p>File {viewer.file.id} · Unverified. Bytes already delivered cannot be recalled if sharing is revoked.</p>
      {viewer.state === 'loading' && <p role="status">Loading private preview…</p>}
      {viewer.state === 'error' && <p role="alert">This file is unavailable or access may have changed. Go back and refresh the list.</p>}
      {viewer.state === 'ready' && (viewer.file.mime === 'application/pdf' ? <><p>Some browsers may not display PDFs in a sandboxed preview.</p><iframe title="Self-reported PDF preview" sandbox="" referrerPolicy="no-referrer" src={viewer.url} /></> : <img alt="Self-reported document preview" src={viewer.url} />)}
    </dialog>}
  </main>
}

/** Unmounted prototype: server authorization remains authoritative. */
export function GcGrantedFiles({ authorizationToken, maxFileBytes = MAX_BYTES }: GcGrantedFilesProps) {
  if (!authorizationToken) return <main className="gc-files"><p role="alert">A GC session is required.</p></main>
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_BYTES) return <main className="gc-files"><p role="alert">Invalid preview size limit.</p></main>
  return <Session key={`${authorizationToken}:${maxFileBytes}`} token={authorizationToken} limit={maxFileBytes} />
}
export default GcGrantedFiles
