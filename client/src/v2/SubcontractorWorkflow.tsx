import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import './subcontractor.css'

type Profile = { profileId: string; evidenceType: string }
type Disclosure = { version: string; text: string }
type QrDisclosure = { version: string; qrText: string }
type Coverage = { type: string; limitCents: number }
type RecordItem = { id: string; profile_id: string; carrier: string; effective_date: string; expiration_date: string; coverage: Coverage[]; created_at: string; reporting_status: string }
type GC = { gc_user_id: string; gc_name: string | null }
type Load<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T }
type Props = { token: string }

// All API paths are fixed, same-origin and query-free. Neither credentials nor
// capabilities are persisted, logged, or sent to third-party QR services.
async function request<T>(token: string, path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error('Request unavailable')
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
function useResource<T>(token: string, path: string, valid: (v: any) => boolean) {
  const [value, setValue] = useState<Load<T>>({ status: 'loading' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setValue({ status: 'loading' })
    request<T>(token, path, undefined, controller.signal).then(data => {
      if (!valid(data)) throw new Error('Invalid response')
      if (!controller.signal.aborted) setValue({ status: 'ready', data })
    }).catch(() => { if (!controller.signal.aborted) setValue({ status: 'error' }) })
    return () => controller.abort()
  }, [token, path, revision])
  return { value, reload: () => setRevision(n => n + 1) }
}
const text = (x: unknown): x is string => typeof x === 'string' && x.length > 0
const profileValid = (v: any) => text(v?.profileId) && text(v?.evidenceType)
const qrConsentValid = (v: any) => text(v?.version) && text(v?.qrText)
const disclosureValid = (v: any) => text(v?.version) && text(v?.text)
const recordsValid = (v: any) => Array.isArray(v?.records) && v.records.every((r: any) => text(r?.id) && text(r?.carrier) && text(r?.effective_date) && text(r?.expiration_date) && Array.isArray(r?.coverage) && r.coverage.every((c: any) => text(c?.type) && Number.isSafeInteger(c?.limitCents)))
const gcsValid = (v: any) => Array.isArray(v?.generalContractors) && v.generalContractors.every((g: any) => text(g?.gc_user_id) && (g.gc_name === null || typeof g.gc_name === 'string'))

function StateNotice<T>({ resource, label }: { resource: ReturnType<typeof useResource<T>>; label: string }) {
  if (resource.value.status === 'loading') return <p role="status">Loading {label}…</p>
  if (resource.value.status === 'error') return <div role="alert"><p>Could not load {label}. Check your session or try again.</p><button type="button" className="secondary" onClick={resource.reload}>Retry {label}</button></div>
  return null
}

function QrConnection({ token, profile }: { token: string; profile: Profile }) {
  const consent = useResource<QrDisclosure>(token, '/api/v2/connections/consent', qrConsentValid)
  const [affirm, setAffirm] = useState(false)
  const [qr, setQr] = useState<{ token: string; expiresAt: string } | null>(null)
  const [blockedUntil, setBlockedUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const lock = useRef(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { if (qr && Date.parse(qr.expiresAt) <= now) { setQr(null); setAffirm(false); setExpired(true) } }, [now, qr])
  const available = !qr && now >= blockedUntil
  async function generate() {
    if (lock.current || !affirm || !available || consent.value.status !== 'ready') return
    lock.current = true; setPending(true); setError(''); setExpired(false)
    try {
      const result = await request<{ token: string; expiresAt: string }>(token, '/api/v2/connections/qr', { profileId: profile.profileId, consentVersion: consent.value.data.version, affirmative: true })
      if (!/^[A-Za-z0-9_-]{43}$/.test(result?.token) || !text(result?.expiresAt) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error('Invalid response')
      setQr(result); setAffirm(false)
    } catch {
      // A lost response may still have minted a capability. Do not automatically retry.
      setBlockedUntil(Date.now() + 5 * 60 * 1000); setNow(Date.now()); setAffirm(false)
      setError('The result could not be confirmed. A code may have been created; wait five minutes before trying again.')
    } finally { lock.current = false; setPending(false) }
  }
  return <section className="v2-card" aria-labelledby="qr-heading">
    <div className="v2-eyebrow">01 / PROFILE CONNECTION</div><h2 id="qr-heading">Connect with a QR code</h2>
    <p>A one-use code expires after five minutes. Any eligible GC who scans it can connect; this is not targeted to a particular GC. A connection alone does not share COI metadata or files.</p>
    <StateNotice resource={consent} label="connection disclosure" />
    {consent.value.status === 'ready' && <><div className="v2-disclosure"><strong>Connection disclosure from server</strong><p>{consent.value.data.qrText}</p></div>
      {!qr && <label className="v2-check"><input type="checkbox" checked={affirm} disabled={!available || pending} onChange={e => setAffirm(e.target.checked)} /> I have read and agree to the exact disclosure above.</label>}
      <button type="button" onClick={generate} disabled={!affirm || pending || !available}>{pending ? 'Generating…' : 'Generate one-use QR'}</button></>}
    {error && <p role="alert">{error}</p>}
    {expired && <p role="status">The QR code expired and is no longer displayed.</p>}
    {!available && !qr && <p role="status">You can try again after {new Date(blockedUntil).toLocaleTimeString()}.</p>}
    {qr && Date.parse(qr.expiresAt) > now && <div className="v2-qr" role="status" aria-live="polite">
      <strong>QR code generated</strong><p>Expires <time dateTime={qr.expiresAt}>{new Date(qr.expiresAt).toLocaleString()}</time>. It may already have been used; the server does not report redemption status here. Show it only to an intended GC and protect it like a password.</p>
      <QRCodeSVG value={qr.token} size={224} marginSize={4} role="img" aria-label="One-use connection QR code" />
    </div>}
    {!qr && now >= blockedUntil && <p className="v2-note">Once expired, affirm the disclosure again to generate another code.</p>}
  </section>
}

function Metadata({ token }: Props) {
  const recordSelectId = useId(), gcSelectId = useId()
  const records = useResource<{ records: RecordItem[] }>(token, '/api/v2/self-reported-coi-metadata/own', recordsValid)
  const gcs = useResource<{ generalContractors: GC[] }>(token, '/api/v2/self-reported-coi-metadata/connected-gcs', gcsValid)
  const consent = useResource<Disclosure>(token, '/api/v2/self-reported-coi-metadata/consent', disclosureValid)
  const [carrier, setCarrier] = useState(''); const [effectiveDate, setEffective] = useState(''); const [expirationDate, setExpiration] = useState('')
  const [coverage, setCoverage] = useState([{ type: '', cents: '' }])
  const [selectedRecord, setSelectedRecord] = useState(''); const [selectedGc, setSelectedGc] = useState(''); const [affirm, setAffirm] = useState(false)
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const lock = useRef(false)
  const selected = records.value.status === 'ready' ? records.value.data.records.find(r => r.id === selectedRecord) : undefined
  const gc = gcs.value.status === 'ready' ? gcs.value.data.generalContractors.find(g => g.gc_user_id === selectedGc) : undefined
  const resetSelection = () => { setAffirm(false); setMessage(''); setError('') }
  async function create(e: FormEvent) {
    e.preventDefault(); if (lock.current) return
    setError(''); setMessage('')
    const trimmedCarrier = carrier.trim(); const entries = coverage.map(c => ({ type: c.type.trim(), limitCents: Number(c.cents) }))
    const dateValid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number(s.slice(0, 4)) >= 1000 && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s
    const labels = entries.map(c => c.type.toLowerCase())
    if (!trimmedCarrier || trimmedCarrier.length > 200 || !dateValid(effectiveDate) || !dateValid(expirationDate) || expirationDate < effectiveDate || entries.some((c, i) => !c.type || c.type.length > 100 || !/^\d+$/.test(coverage[i].cents) || !Number.isSafeInteger(c.limitCents) || c.limitCents > 1000000000000) || new Set(labels).size !== labels.length) { setError('Check the carrier, real dates, unique coverage types and whole-number limits (0–1,000,000,000,000 USD cents).'); return }
    lock.current = true; setBusy('create')
    try {
      const created = await request<{ id: string }>(token, '/api/v2/self-reported-coi-metadata/own', { carrier: trimmedCarrier, effectiveDate, expirationDate, coverage: entries })
      if (!text(created?.id)) throw new Error('Invalid response')
      setCarrier(''); setEffective(''); setExpiration(''); setCoverage([{ type: '', cents: '' }]); setAffirm(false); setMessage('Record submitted. Records are self-reported and unverified.'); records.reload()
    } catch { setError('The record could not be confirmed. Refresh the records before trying again; the request may have succeeded.') }
    finally { lock.current = false; setBusy('') }
  }
  async function share(action: 'grant' | 'revoke') {
    if (lock.current || !selected || !gc || (action === 'grant' && (!affirm || consent.value.status !== 'ready'))) return
    lock.current = true; setBusy(action); setError(''); setMessage('')
    try {
      const payload = action === 'grant' && consent.value.status === 'ready' ? { coiId: selected.id, gcUserId: gc.gc_user_id, consentVersion: consent.value.data.version, affirmative: true } : { coiId: selected.id, gcUserId: gc.gc_user_id }
      await request<void>(token, `/api/v2/self-reported-coi-metadata/${action}`, payload)
      setAffirm(false); setMessage(action === 'grant' ? 'Sharing request recorded for this record and GC account. No files are shared.' : 'Revocation request recorded for this record and GC account. Previously viewed information cannot be recalled.')
    } catch { setAffirm(false); setError('The outcome could not be confirmed. Review your selection and try again if appropriate.') }
    finally { lock.current = false; setBusy('') }
  }
  return <>
    <section className="v2-card" aria-labelledby="record-heading"><div className="v2-eyebrow">02 / INSURANCE INFORMATION</div><h2 id="record-heading">Self-reported COI metadata</h2>
      <p>These details are entered by you and are <strong>not verified</strong>. They are not proof of insurance. Corrections require a new record; sharing does not carry over.</p>
      <form onSubmit={create} className="v2-form">
        <label>Carrier<input value={carrier} onChange={e => setCarrier(e.target.value)} maxLength={200} required /></label>
        <div className="v2-row"><label>Effective date<input type="date" value={effectiveDate} onChange={e => setEffective(e.target.value)} required /></label><label>Expiration date<input type="date" value={expirationDate} onChange={e => setExpiration(e.target.value)} required /></label></div>
        <fieldset><legend>Coverage (USD cents)</legend>{coverage.map((c, i) => <div className="v2-coverage" key={i}>
          <label>Coverage type {i + 1}<input value={c.type} maxLength={100} required onChange={e => setCoverage(old => old.map((v, j) => i === j ? { ...v, type: e.target.value } : v))} /></label>
          <label>Limit in cents {i + 1}<input type="number" min="0" max="1000000000000" step="1" required value={c.cents} onChange={e => setCoverage(old => old.map((v, j) => i === j ? { ...v, cents: e.target.value } : v))} /></label>
          {coverage.length > 1 && <button type="button" className="secondary" onClick={() => setCoverage(old => old.filter((_, j) => i !== j))}>Remove coverage {i + 1}</button>}
        </div>)}<button type="button" className="secondary" disabled={coverage.length >= 12 || !!busy} onClick={() => setCoverage(old => [...old, { type: '', cents: '' }])}>Add coverage</button></fieldset>
        <button type="submit" disabled={!!busy}>{busy === 'create' ? 'Saving…' : 'Save self-reported record'}</button>
      </form>
      <StateNotice resource={records} label="records" />
      {records.value.status === 'ready' && <button type="button" className="secondary" disabled={!!busy} onClick={() => { resetSelection(); records.reload() }}>Refresh records</button>}
      {records.value.status === 'ready' && (records.value.data.records.length === 0 ? <p>No self-reported records yet.</p> : <ul className="v2-list">{records.value.data.records.map(r => <li key={r.id}><strong>{r.carrier}</strong> <span className="v2-badge">Self-reported · unverified</span><br />{r.effective_date} to {r.expiration_date}<br />{r.coverage.map(c => `${c.type}: ${c.limitCents.toLocaleString()} cents`).join(' · ')}<br /><small>Record ID: {r.id}</small></li>)}</ul>)}
      {error && <p role="alert">{error}</p>}
    </section>
    <section className="v2-card" aria-labelledby="sharing-heading"><div className="v2-eyebrow">03 / RECORD-SPECIFIC ACCESS</div><h2 id="sharing-heading">Share or revoke metadata</h2>
      <p>Choose one of your records and one connected GC account. Account names are self-reported; neither a name nor a connection verifies business identity or authority. Metadata consent does not share any file or certificate.</p>
      <StateNotice resource={gcs} label="connected GC accounts" /><StateNotice resource={consent} label="metadata disclosure" />
      {gcs.value.status === 'ready' && <button type="button" className="secondary" disabled={!!busy} onClick={() => { resetSelection(); gcs.reload() }}>Refresh connected GC accounts</button>}
      {gcs.value.status === 'ready' && gcs.value.data.generalContractors.length === 0 && <p>No connected GC accounts available. A profile connection must be made first.</p>}
      {records.value.status === 'ready' && gcs.value.status === 'ready' && <div className="v2-form">
        <div><label htmlFor={recordSelectId}>Record</label><select id={recordSelectId} disabled={!!busy} value={selectedRecord} onChange={e => { setSelectedRecord(e.target.value); resetSelection() }}><option value="">Select a record</option>{records.value.data.records.map(r => <option value={r.id} key={r.id}>{r.carrier} · {r.effective_date} to {r.expiration_date} · {r.id}</option>)}</select></div>
        <div><label htmlFor={gcSelectId}>Connected GC account</label><select id={gcSelectId} disabled={!!busy} value={selectedGc} onChange={e => { setSelectedGc(e.target.value); resetSelection() }}><option value="">Select a connected GC</option>{gcs.value.data.generalContractors.map(g => <option value={g.gc_user_id} key={g.gc_user_id}>{g.gc_name || 'Unnamed account'} · {g.gc_user_id}</option>)}</select></div>
        {selected && gc && <><div className="v2-selection"><strong>Selected record:</strong> {selected.carrier}, {selected.effective_date} to {selected.expiration_date}; ID {selected.id}<br /><strong>Selected GC account:</strong> {gc.gc_name || 'Unnamed account'}; ID {gc.gc_user_id}</div>
          {consent.value.status === 'ready' && <><div className="v2-disclosure"><strong>Metadata disclosure from server</strong><p>{consent.value.data.text}</p></div><label className="v2-check"><input type="checkbox" checked={affirm} onChange={e => setAffirm(e.target.checked)} /> I have read and agree to the exact disclosure above for this record and account.</label><button type="button" disabled={!affirm || !!busy} onClick={() => share('grant')}>{busy === 'grant' ? 'Recording…' : 'Share this record’s metadata'}</button></>}
          <button type="button" className="secondary" disabled={!!busy} onClick={() => share('revoke')}>{busy === 'revoke' ? 'Revoking…' : 'Revoke metadata access for this selection'}</button></>}
      </div>}
      <p className="v2-note">This API does not list your active metadata grants, so this screen cannot show current sharing status. Revocation is idempotent and does not disconnect the profile.</p>
      {message && <p role="status" className="v2-success">{message}</p>}{error && <p role="alert">{error}</p>}
    </section>
  </>
}

function Workflow({ token }: Props) {
  const profile = useResource<Profile>(token, '/api/v2/connections/profile', profileValid)
  return <main className="sub-v2"><header className="v2-header"><span className="v2-eyebrow">SUBCONTRACTOR WORKSPACE / V2</span><h1>Connections & insurance information</h1><p>Control profile connections and decide exactly which self-reported metadata to share.</p></header>
    <section className="v2-card" aria-labelledby="profile-heading"><div className="v2-eyebrow">YOUR PROFILE</div><h2 id="profile-heading">Self-reported, not verified</h2><p>Profile company and trade information is self-reported. Email-control evidence does not verify a business, its authority, or insurance. This API only provides the profile ID and evidence type here.</p><StateNotice resource={profile} label="profile" />{profile.value.status === 'ready' && <p><strong>Profile ID:</strong> {profile.value.data.profileId}<br /><strong>Evidence type:</strong> {profile.value.data.evidenceType}</p>}</section>
    {profile.value.status === 'ready' && <QrConnection token={token} profile={profile.value.data} />}
    <Metadata token={token} />
    <section className="v2-card" aria-labelledby="file-heading"><div className="v2-eyebrow">DOCUMENTS</div><h2 id="file-heading">File upload</h2><p><strong>Not available yet.</strong> No certificate upload, file access, or file sharing is provided by this interface.</p><button type="button" disabled>Upload not available yet</button></section>
  </main>
}
export function SubcontractorWorkflow({ token }: Props) {
  if (!token) return <main className="sub-v2"><p role="alert">An authorization token must be supplied by the host.</p></main>
  // New credentials reset all transient state, including any QR capability.
  return <Workflow key={token} token={token} />
}
export default SubcontractorWorkflow
