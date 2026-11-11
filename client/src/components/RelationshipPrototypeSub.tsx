import { useEffect, useMemo, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { matchingDisclosures, relationshipPrototypeApi, relationshipPrototypeEnabled, validRelationshipToken } from '../lib/relationshipPrototypeApi'
import type { RelationshipCapability, RelationshipDisclosure, RelationshipInvitePreview, RelationshipSubConnection } from '../lib/relationshipPrototypeApi'

const panel = 'space-y-4 rounded-xl border border-slate-300 bg-white p-4 text-slate-900'
const button = 'min-h-11 rounded-lg border border-slate-400 px-4 py-2 font-semibold disabled:opacity-50'

// Only the caller's existing login JWT is passed in; capabilities stay in component memory.
export function RelationshipPrototypeSub({ authToken }: { authToken: string }) {
  if (!relationshipPrototypeEnabled || !authToken) return null
  return <SubControls key={authToken} authToken={authToken} />
}

function SubControls({ authToken }: { authToken: string }) {
  const api = useMemo(() => relationshipPrototypeApi(authToken), [authToken])
  const [disclosure, setDisclosure] = useState<RelationshipDisclosure | null>(null)
  const [connections, setConnections] = useState<RelationshipSubConnection[] | null>(null)
  const [qrConsent, setQrConsent] = useState(false)
  const [inviteConsent, setInviteConsent] = useState(false)
  const [qr, setQr] = useState<RelationshipCapability | null>(null)
  const [now, setNow] = useState(Date.now())
  const [input, setInput] = useState('')
  const [preview, setPreview] = useState<{ token: string; value: RelationshipInvitePreview } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void api.disclosure().then(d => { if (mounted.current) setDisclosure(d) }).catch(() => { if (mounted.current) setError('Could not load the current disclosure. Consent actions are unavailable.') })
    void api.subConnections().then(r => { if (mounted.current) setConnections(r.connections) }).catch(() => { if (mounted.current) setError('Could not load connections. Please retry.') })
    return () => { mounted.current = false }
  }, [api])
  useEffect(() => {
    if (!qr) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [qr])

  async function run(action: () => Promise<void>, fallback: string) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { await action() } catch { if (mounted.current) setError(fallback) }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  async function reloadDisclosure() {
    setQrConsent(false); setInviteConsent(false); setPreview(null)
    setDisclosure(null)
    const next = await api.disclosure()
    if (mounted.current) setDisclosure(next)
  }
  async function ensureCurrent(): Promise<RelationshipDisclosure | null> {
    const current = await api.disclosure()
    if (!mounted.current) return null
    if (!disclosure || !matchingDisclosures(current, disclosure)) {
      setDisclosure(current); setQrConsent(false); setInviteConsent(false); setPreview(null)
      setError('The disclosure changed. Review it and opt in again.')
      return null
    }
    return current
  }
  async function createQr() {
    if (!qrConsent || !disclosure || qr) return
    await run(async () => {
      const current = await ensureCurrent()
      if (!current) return
      const code = await api.issueQr(current.version)
      if (!validRelationshipToken(code.token) || !code.id || !Number.isFinite(Date.parse(code.expires_at)) || Date.parse(code.expires_at) <= Date.now()) throw new Error('Invalid code')
      if (mounted.current) { setNow(Date.now()); setQr(code); setQrConsent(false) }
    }, 'Unable to issue or display a valid code. If issuance succeeded but the response was lost, that code may remain usable until expiry.')
  }
  async function previewInvite() {
    const token = input.trim()
    setInviteConsent(false); setPreview(null)
    if (!validRelationshipToken(token)) { setError('Enter a valid invitation token, not a link.'); return }
    await run(async () => {
      const current = await api.disclosure()
      if (!mounted.current) return
      const value = await api.previewInvitation(token)
      if (!matchingDisclosures(current, value.disclosure) || !value.gc_user_id || !value.gc_company_name || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()) {
        setDisclosure(current); setQrConsent(false)
        throw new Error('Invalid preview')
      }
      if (mounted.current) { setDisclosure(current); setQrConsent(false); setInput(''); setPreview({ token, value }) }
    }, 'Could not preview this invitation or its disclosure. It may be unavailable or expired.')
  }
  async function acceptInvite() {
    if (!preview || !inviteConsent || !disclosure) return
    await run(async () => {
      const current = await ensureCurrent()
      if (!current || !matchingDisclosures(current, preview.value.disclosure)) return
      await api.acceptInvitation(preview.token, preview.value, current.version)
      if (mounted.current) { setPreview(null); setInviteConsent(false); setNotice('Connection accepted.'); setConnections(null) }
      const result = await api.subConnections()
      if (mounted.current) setConnections(result.connections)
    }, 'Unable to complete or refresh the connection. It may have expired or changed; refresh the list and request a new invitation if needed.')
  }
  const activeQr = qr && Date.parse(qr.expires_at) > now

  return <div className="space-y-4" data-relationship-prototype="sub">
    <div className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm"><strong>Development experiment — synthetic data only.</strong> Do not deploy or use real people, COIs or files. Legacy app routes and client sharing are outside these controls, so this is not an app-wide privacy guarantee. Certificate PDFs, files and file links are unavailable here. Codes are bearer capabilities: anyone holding a code (or any link carrying one) can use it in the applicable flow; never put tokens in URLs, logs or analytics.</div>
    <section className={panel} aria-labelledby="relationship-prototype-qr-title">
      <h2 id="relationship-prototype-qr-title" className="text-lg font-bold">Issue a one-use subcontractor QR</h2>
      {disclosure ? <><div className="whitespace-pre-wrap" data-testid="qr-disclosure-scope">{disclosure.scope}</div><div className="whitespace-pre-wrap" data-testid="qr-disclosure-flow">{disclosure.qr}</div><p className="text-xs">Disclosure version: {disclosure.version}</p></> : <p>Current disclosure unavailable. No code can be issued.</p>}
      {!qr && <><label className="flex gap-2"><input type="checkbox" checked={qrConsent} disabled={!disclosure || busy} onChange={e => setQrConsent(e.target.checked)} />I explicitly agree to the full disclosure above before issuing a QR.</label><button type="button" className={button} disabled={!disclosure || !qrConsent || busy} onClick={() => void createQr()}>Issue one-use QR</button></>}
      {qr && <div className="space-y-2">{activeQr ? <><QRCodeSVG value={qr.token} size={208} marginSize={4} role="img" aria-label="One-use relationship QR containing the bearer token" /><p>Expires: {qr.expires_at}. The first qualifying GC to redeem it connects without another approval.</p><label className="block">Raw bearer token for manual entry <input readOnly value={qr.token} autoComplete="off" className="block w-full rounded border p-2" /></label></> : <p>This QR has expired; it can no longer be used.</p>}
        <button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeCapability(qr.id); if (mounted.current) { setQr(null); setQrConsent(false); setNotice('Code revoked. This does not revoke a connection if already redeemed.') } }, 'Could not revoke the code; it may remain usable until expiry.')}>Revoke or clear this code</button></div>}
      <button type="button" className={button} disabled={busy} onClick={() => void run(reloadDisclosure, 'Could not load the current disclosure.')}>Refresh disclosure</button>
    </section>
    <section className={panel} aria-labelledby="relationship-prototype-invite-title">
      <h2 id="relationship-prototype-invite-title" className="text-lg font-bold">Review a GC invitation</h2>
      {!preview ? <><label className="block">GC invitation bearer token<input value={input} onChange={e => setInput(e.target.value)} autoComplete="off" spellCheck={false} className="block w-full rounded border p-2" /></label><p>Paste the raw token, not a URL. The GC identity is self-asserted, not verified.</p><button type="button" className={button} disabled={busy || !input} onClick={() => void previewInvite()}>Preview invitation</button></> : <>
        <p>General contractor: <strong>{preview.value.gc_company_name}</strong> (account ID: {preview.value.gc_user_id}). Identity is self-asserted, not verified.</p><p>Expires: {preview.value.expires_at}</p>
        {disclosure && <><div className="whitespace-pre-wrap" data-testid="invite-disclosure-scope">{disclosure.scope}</div><div className="whitespace-pre-wrap" data-testid="invite-disclosure-flow">{disclosure.invitation}</div><p className="text-xs">Disclosure version: {disclosure.version}</p></>}
        <label className="flex gap-2"><input type="checkbox" checked={inviteConsent} disabled={busy || !disclosure} onChange={e => setInviteConsent(e.target.checked)} />I explicitly accept the full disclosure above and authorize this identified GC to receive all current and future COI information as described.</label>
        <div className="flex gap-2"><button type="button" className={button} disabled={busy || !inviteConsent || !disclosure} onClick={() => void acceptInvite()}>Accept invitation</button><button type="button" className={button} disabled={busy} onClick={() => { setPreview(null); setInviteConsent(false) }}>Cancel preview</button></div>
      </>}
    </section>
    <section className={panel} aria-labelledby="relationship-prototype-connections-title"><h2 id="relationship-prototype-connections-title" className="text-lg font-bold">Connected general contractors</h2><p>Revocation stops future access through this prototype, invalidates outstanding QR codes, and does not delete COIs or recall information already returned.</p>
      <button type="button" className={button} disabled={busy} onClick={() => void run(async () => { const r = await api.subConnections(); if (mounted.current) setConnections(r.connections) }, 'Could not load connections.')}>Refresh connections</button>
      {connections === null ? <p>Connections unavailable or loading.</p> : connections.length === 0 ? <p>No active connections.</p> : <ul className="space-y-3">{connections.map(c => <li key={c.gc_user_id} className="rounded border p-3"><p><strong>{c.gc_company_name || 'Unavailable GC identity'}</strong> (account ID: {c.gc_user_id})</p><p>Connected: {c.connected_at}</p><button type="button" className={button} disabled={busy} onClick={() => void run(async () => { await api.revokeConnection(c.gc_user_id); if (mounted.current) { setQr(null); setQrConsent(false); setConnections(null); setNotice('Connection revoked; all outstanding QR codes were invalidated.') } const r = await api.subConnections(); if (mounted.current) setConnections(r.connections) }, 'Could not revoke or refresh. Refresh connections before retrying.')}>Revoke connection</button></li>)}</ul>}
    </section>
    {error && <p role="alert" className="rounded bg-rose-50 p-3 text-rose-800">{error}</p>}{notice && <p role="status" className="rounded bg-slate-50 p-3">{notice}</p>}
  </div>
}
