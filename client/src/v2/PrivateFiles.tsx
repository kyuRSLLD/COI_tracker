import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import './private-files.css'

const ROOT = '/api/v2/self-reported-private-files'
const META = '/api/v2/self-reported-coi-metadata'
const MAX = 10 * 1024 * 1024
const MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const uuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 8192

type Document = { id: string; coiId: string; mime: string; sizeBytes: number; createdAt: string; reportingStatus: 'self_reported_unverified' }
type RecordItem = { id: string; carrier: string; effective_date: string; expiration_date: string }
type GC = { gc_user_id: string; gc_name: string | null }
type Disclosure = { version: string; text: string }
type Resource<T> = { state: 'loading' | 'error'; data?: never } | { state: 'ready'; data: T }
export type PrivateFilesProps = { token: string; /** Trusted server limit, if lower than 10 MiB. */ maxFileBytes?: number }

async function request(token: string, path: string, signal: AbortSignal, init: RequestInit = {}) {
  const response = await fetch(path, { ...init, signal, headers: { Authorization: `Bearer ${token}`, ...init.headers }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error('Unavailable')
  return response
}
async function json(token: string, path: string, signal: AbortSignal, body?: object): Promise<any> {
  const response = await request(token, path, signal, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return response.status === 204 ? undefined : response.json()
}
function validFile(v: any): v is Document {
  return uuid(v?.id) && uuid(v?.coiId) && MIME.has(v?.mime) && Number.isSafeInteger(v?.sizeBytes) && v.sizeBytes > 0 && v.sizeBytes <= MAX && text(v?.createdAt) && Number.isFinite(Date.parse(v.createdAt)) && v.reportingStatus === 'self_reported_unverified'
}
function validPage(v: any): v is { files: Document[]; nextCursor: string | null } {
  return Array.isArray(v?.files) && v.files.length <= 100 && v.files.every(validFile) && (v.nextCursor === null || uuid(v.nextCursor))
}

// Read at most the listed size and 10 MiB. Never display an unexpected response type.
async function readPreview(response: Response, file: Document): Promise<Blob> {
  if (response.headers.get('content-type') !== file.mime || !response.body) {
    await response.body?.cancel()
    throw new Error('Unavailable')
  }
  const reader = response.body.getReader(), chunks: ArrayBuffer[] = []
  let total = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > file.sizeBytes || total > MAX) { await reader.cancel(); throw new Error('Unavailable') }
      chunks.push(new Uint8Array(part.value).buffer)
    }
  } finally { reader.releaseLock() }
  if (total !== file.sizeBytes) throw new Error('Unavailable')
  return new Blob(chunks, { type: file.mime })
}

function Workspace({ token, maxFileBytes }: { token: string; maxFileBytes: number }) {
  const uploadId = useId(), pickerId = useId(), fileId = useId(), gcId = useId()
  const [records, setRecords] = useState<Resource<RecordItem[]>>({ state: 'loading' })
  const [gcs, setGcs] = useState<Resource<GC[]>>({ state: 'loading' })
  const [disclosure, setDisclosure] = useState<Resource<Disclosure>>({ state: 'loading' })
  const [files, setFiles] = useState<Resource<Document[]>>({ state: 'loading' })
  const [cursor, setCursor] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [record, setRecord] = useState(''), [picked, setPicked] = useState<File | null>(null)
  const [selectedFile, setSelectedFile] = useState(''), [selectedGc, setSelectedGc] = useState('')
  const [affirm, setAffirm] = useState(false), [busy, setBusy] = useState('')
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [preview, setPreview] = useState<{ url: string; file: Document } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const controllers = useRef(new Set<AbortController>())
  const active = useRef(false), lock = useRef(false), pageLock = useRef(false)
  const actionController = useRef<AbortController | null>(null), previewController = useRef<AbortController | null>(null)
  const objectUrl = useRef<string | null>(null), input = useRef<HTMLInputElement>(null)
  const newController = () => { const c = new AbortController(); controllers.current.add(c); return c }
  const finish = (c: AbortController) => controllers.current.delete(c)
  const closePreview = () => {
    previewController.current?.abort(); previewController.current = null
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    objectUrl.current = null; setPreview(null); setPreviewLoading(false)
  }
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      controllers.current.forEach(c => c.abort()); controllers.current.clear()
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
      objectUrl.current = null
    }
  }, [])
  useEffect(() => {
    const c = newController()
    setRecords({ state: 'loading' }); setGcs({ state: 'loading' }); setDisclosure({ state: 'loading' }); setFiles({ state: 'loading' }); setCursor(null)
    setAffirm(false); setSelectedFile(''); setSelectedGc('')
    const load = async <T,>(path: string, validate: (x: any) => T, set: (v: Resource<T>) => void) => {
      try { const value = validate(await json(token, path, c.signal)); if (!c.signal.aborted && active.current) set({ state: 'ready', data: value }) }
      catch { if (!c.signal.aborted && active.current) set({ state: 'error' }) }
    }
    void load(`${META}/own`, v => {
      if (!Array.isArray(v?.records) || !v.records.every((r: any) => uuid(r?.id) && text(r?.carrier) && text(r?.effective_date) && text(r?.expiration_date))) throw new Error()
      return v.records as RecordItem[]
    }, setRecords)
    void load(`${META}/connected-gcs`, v => {
      if (!Array.isArray(v?.generalContractors) || !v.generalContractors.every((g: any) => text(g?.gc_user_id) && (g.gc_name === null || typeof g.gc_name === 'string'))) throw new Error()
      return v.generalContractors as GC[]
    }, setGcs)
    void load(`${ROOT}/consent`, v => { if (!text(v?.version) || !text(v?.text)) throw new Error(); return { version: v.version, text: v.text } }, setDisclosure)
    void (async () => {
      try {
        const page = await json(token, `${ROOT}/own/list`, c.signal)
        if (!validPage(page)) throw new Error()
        if (!c.signal.aborted && active.current) { setCursor(page.nextCursor); setFiles({ state: 'ready', data: page.files }) }
      } catch { if (!c.signal.aborted && active.current) setFiles({ state: 'error' }) }
    })()
    return () => { c.abort(); finish(c) }
  }, [token, revision])
  const refresh = () => { closePreview(); setError(''); setMessage(''); setRevision(x => x + 1) }
  async function more() {
    if (!cursor || pageLock.current || files.state !== 'ready') return
    pageLock.current = true; setBusy('page'); setError(''); const c = newController()
    try {
      const page = await json(token, `${ROOT}/own/list`, c.signal, { after: cursor })
      if (!validPage(page) || page.nextCursor === cursor) throw new Error()
      if (!c.signal.aborted && active.current) { setFiles(old => old.state === 'ready' ? { state: 'ready', data: [...old.data, ...page.files.filter(f => !old.data.some(x => x.id === f.id))] } : old); setCursor(page.nextCursor) }
    } catch { if (!c.signal.aborted && active.current) setError('Could not load more files. Try again.') }
    finally { finish(c); pageLock.current = false; if (active.current) setBusy('') }
  }
  async function upload(e: FormEvent) {
    e.preventDefault(); setError(''); setMessage('')
    if (lock.current || !records.data?.some(r => r.id === record)) return
    if (!picked || !MIME.has(picked.type) || picked.size < 1 || picked.size > maxFileBytes) { setError(`Choose a nonempty PDF, JPEG, PNG, or WebP file no larger than ${maxFileBytes.toLocaleString()} bytes.`); return }
    lock.current = true; setBusy('upload'); const c = newController(); actionController.current = c
    try {
      const res = await request(token, `${ROOT}/own/${record}`, c.signal, { method: 'PUT', headers: { 'Content-Type': picked.type }, body: picked })
      const result = await res.json(); if (!uuid(result?.id)) throw new Error()
      if (!c.signal.aborted && active.current) { setPicked(null); if (input.current) input.current.value = ''; setMessage('Upload recorded. The file is self-reported and unverified; scanning does not verify insurance or guarantee safety.'); setRevision(x => x + 1) }
    } catch { if (active.current) setError('Upload outcome could not be confirmed. Refresh the list before trying again; a retry creates a separate file.') }
    finally { finish(c); actionController.current = null; lock.current = false; if (active.current) setBusy('') }
  }
  const chosen = files.data?.find(f => f.id === selectedFile), gc = gcs.data?.find(g => g.gc_user_id === selectedGc)
  async function share(kind: 'grant' | 'revoke') {
    if (lock.current || !chosen || !gc || (kind === 'grant' && (!affirm || disclosure.state !== 'ready'))) return
    lock.current = true; setBusy(kind); setError(''); setMessage(''); const c = newController(); actionController.current = c
    try {
      const body = kind === 'grant' && disclosure.state === 'ready' ? { fileId: chosen.id, gcUserId: gc.gc_user_id, consentVersion: disclosure.data.version, affirmative: true } : { fileId: chosen.id, gcUserId: gc.gc_user_id }
      await json(token, `${ROOT}/${kind}`, c.signal, body)
      if (!c.signal.aborted && active.current) { setAffirm(false); setMessage(kind === 'grant' ? 'Share request recorded for this file and GC account.' : 'Revocation request recorded for this file and GC account. Previously delivered bytes cannot be recalled.') }
    } catch { if (active.current) { setAffirm(false); setError('The sharing outcome could not be confirmed. Check your selection before trying again.') } }
    finally { finish(c); actionController.current = null; lock.current = false; if (active.current) setBusy('') }
  }
  async function openPreview(file: Document) {
    closePreview(); setError(''); const c = newController(); previewController.current = c; setPreviewLoading(true)
    try {
      const response = await request(token, `${ROOT}/own/${file.id}`, c.signal)
      const blob = await readPreview(response, file)
      if (!c.signal.aborted && active.current && previewController.current === c) { const url = URL.createObjectURL(blob); objectUrl.current = url; setPreview({ url, file }) }
    } catch { if (!c.signal.aborted && active.current) setError('Preview is unavailable. Refresh the file list and try again.') }
    finally { finish(c); if (previewController.current === c) { previewController.current = null; if (active.current) setPreviewLoading(false) } }
  }
  const resetSelection = () => { setAffirm(false); setError(''); setMessage('') }
  return <main className="private-files">
    <header><p className="pf-eyebrow">SUBCONTRACTOR / PRIVATE DOCUMENTS</p><h1>Your self-reported files</h1><p>Keep a private file with a self-reported record, then choose whether to share that specific file with one connected GC.</p></header>
    <section className="pf-card" aria-labelledby={uploadId}><h2 id={uploadId}>Upload a file</h2><p>PDF, JPEG, PNG or WebP; maximum {maxFileBytes.toLocaleString()} bytes. Uploading does not share the file. Scanning does not verify insurance or guarantee a file is safe.</p>
      {records.state === 'loading' && <p role="status">Loading your records…</p>}{records.state === 'error' && <p role="alert">Could not load your records. Refresh and check your session.</p>}
      {records.state === 'ready' && records.data.length === 0 && <p>You need a self-reported COI record before uploading.</p>}
      <form onSubmit={upload} className="pf-form"><label>Self-reported COI record<select value={record} disabled={records.state !== 'ready' || !!busy} onChange={e => setRecord(e.target.value)}><option value="">Select a record</option>{records.data?.map(r => <option key={r.id} value={r.id}>{r.carrier} · {r.effective_date} to {r.expiration_date} · {r.id}</option>)}</select></label>
        <label htmlFor={pickerId}>File</label><input ref={input} id={pickerId} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={!!busy} onChange={e => { setPicked(e.target.files?.[0] || null); setError('') }} />
        <div className="pf-actions"><button type="submit" disabled={!record || !picked || !!busy}>{busy === 'upload' ? 'Uploading…' : 'Upload private file'}</button>{busy === 'upload' && <button type="button" className="pf-secondary" onClick={() => actionController.current?.abort()}>Cancel upload</button>}</div>
      </form></section>
    <section className="pf-card"><div className="pf-section-head"><div><p className="pf-eyebrow">YOUR FILES</p><h2>Ready files</h2></div><button type="button" className="pf-secondary" disabled={!!busy} onClick={refresh}>Refresh</button></div><p>Only your ready files are listed. The API does not provide original filenames. A new upload is a separate file.</p>
      {files.state === 'loading' && <p role="status">Loading files…</p>}{files.state === 'error' && <p role="alert">Could not load your files. Refresh and check your session.</p>}
      {files.state === 'ready' && (files.data.length === 0 ? <p>No ready files yet.</p> : <ul className="pf-list">{files.data.map(f => <li key={f.id}><div><strong>{f.mime}</strong> <span className="pf-badge">Self-reported · unverified</span><p>File ID: {f.id}<br />Record ID: {f.coiId}<br />{f.sizeBytes.toLocaleString()} bytes · {new Date(f.createdAt).toLocaleString()}</p></div><button type="button" className="pf-secondary" onClick={() => openPreview(f)} aria-label={`Preview file ${f.id}`}>Preview</button></li>)}</ul>)}
      {cursor && <button type="button" className="pf-secondary" onClick={more} disabled={!!busy}>{busy === 'page' ? 'Loading…' : 'Load more files'}</button>}
      {(preview || previewLoading) && <div className="pf-preview" aria-label="Own file preview"><div className="pf-section-head"><h3>Private preview</h3><button type="button" className="pf-secondary" onClick={closePreview}>Close preview</button></div>{previewLoading && <p role="status">Loading preview…</p>}{preview && <><p>File {preview.file.id}. Preview is not a safety or insurance verification.</p>{preview.file.mime === 'application/pdf' ? <iframe title="Private PDF preview" sandbox="" referrerPolicy="no-referrer" src={preview.url} /> : <img alt="Your private document preview" src={preview.url} />}</>}</div>}
    </section>
    <section className="pf-card" aria-labelledby={fileId}><p className="pf-eyebrow">FILE-SPECIFIC ACCESS</p><h2 id={fileId}>Share or revoke a file</h2><p>Profile or metadata consent does not share files. Each file and connected GC requires a separate grant. GC names are self-reported and do not verify business identity or authority.</p>
      {gcs.state === 'loading' && <p role="status">Loading connected GC accounts…</p>}{gcs.state === 'error' && <p role="alert">Could not load connected GC accounts. Refresh and check your session.</p>}{gcs.state === 'ready' && gcs.data.length === 0 && <p>No connected GC accounts available.</p>}
      {disclosure.state === 'loading' && <p role="status">Loading file disclosure…</p>}{disclosure.state === 'error' && <p role="alert">Could not load the file disclosure. Sharing is unavailable; refresh to retry.</p>}
      <div className="pf-form"><label>Ready file<select value={selectedFile} disabled={files.state !== 'ready' || !!busy} onChange={e => { setSelectedFile(e.target.value); resetSelection() }}><option value="">Select a ready file</option>{files.data?.map(f => <option key={f.id} value={f.id}>{f.mime} · {f.id}</option>)}</select></label>
        <label htmlFor={gcId}>Connected GC account</label><select id={gcId} value={selectedGc} disabled={gcs.state !== 'ready' || !!busy} onChange={e => { setSelectedGc(e.target.value); resetSelection() }}><option value="">Select a connected GC</option>{gcs.data?.map(g => <option key={g.gc_user_id} value={g.gc_user_id}>{g.gc_name || 'Unnamed account'} · {g.gc_user_id}</option>)}</select>
        {chosen && gc && <><div className="pf-selection"><strong>File:</strong> {chosen.id}<br /><strong>Connected GC:</strong> {gc.gc_name || 'Unnamed account'} · {gc.gc_user_id}</div>
          {disclosure.state === 'ready' && <><div className="pf-disclosure"><strong>File disclosure from server</strong><p>{disclosure.data.text}</p></div><label className="pf-check"><input type="checkbox" checked={affirm} disabled={!!busy} onChange={e => setAffirm(e.target.checked)} /> I have read and agree to the exact disclosure above for this file and GC account.</label><button type="button" disabled={!affirm || !!busy} onClick={() => share('grant')}>{busy === 'grant' ? 'Recording…' : 'Share this file'}</button></>}
          <button type="button" className="pf-secondary" disabled={!!busy} onClick={() => share('revoke')}>{busy === 'revoke' ? 'Revoking…' : 'Revoke access to this file'}</button></>}
      </div><p className="pf-note">The API does not list your active file grants, so current sharing status cannot be shown. Revoking does not disconnect the profile.</p>
    </section>
    {message && <p role="status" className="pf-message">{message}</p>}{error && <p role="alert" className="pf-error">{error}</p>}
  </main>
}

/** Standalone, unmounted component. The host must supply an authenticated sub token in memory. */
export function PrivateFiles({ token, maxFileBytes = MAX }: PrivateFilesProps) {
  if (!token) return <main className="private-files"><p role="alert">An authorization token must be supplied by the host.</p></main>
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX) return <main className="private-files"><p role="alert">Invalid file size limit.</p></main>
  return <Workspace key={token} token={token} maxFileBytes={maxFileBytes} />
}
export default PrivateFiles
