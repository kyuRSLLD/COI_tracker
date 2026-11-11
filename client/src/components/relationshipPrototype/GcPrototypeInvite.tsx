import { useEffect, useId, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { getStoredUser } from '../../api'
import { gcPrototypeApi, relationshipPrototypeEnabled } from './gcPrototypeApi'

// The integrator supplies an isolated recipient route, after installing synchronous
// fragment capture/removal before any scripts. Never reuse the staged invite route.
function invitationUrl(path: string, token: string): string {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path) || path === '/invite-sub' || path === '/connect-sub') throw new Error('Invalid recipient route')
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid capability')
  const { origin, protocol, hostname } = window.location
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))) throw new Error('Secure origin required')
  return `${origin}${path}#${token}`
}

type Invite = { id: string; url: string; expires: number }

export function GcPrototypeInvite({ invitePath }: { invitePath?: string }) {
  const id = useId()
  const [invite, setInvite] = useState<Invite | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const [expired, setExpired] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject] = useState('Synthetic relationship prototype invitation')
  const [message, setMessage] = useState('Please review this development-only test invitation using synthetic data. The link is one-use and must not be shared with real people.')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!invite) return
    const update = () => setExpired(Date.now() >= invite.expires)
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [invite])

  if (!relationshipPrototypeEnabled || getStoredUser()?.role !== 'gc') return null

  const create = async () => {
    if (pending.current || !invitePath) return
    // Fail before issuing a capability if the destination or origin is invalid.
    try { invitationUrl(invitePath, 'a'.repeat(43)) } catch { setError('Prototype recipient route or origin is not configured safely.'); return }
    pending.current = true
    setBusy(true); setError(''); setStatus(''); setInvite(null); setExpired(false)
    try {
      const created = await gcPrototypeApi.createInvite()
      const expires = Date.parse(created.expires_at)
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(created.id) || created.id.includes(created.token) || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('Invalid capability')
      const url = invitationUrl(invitePath, created.token)
      if (mounted.current) setInvite({ id: created.id, url, expires })
    } catch { if (mounted.current) setError('Could not create a test invitation. Check prototype availability and try again.') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const revoke = async () => {
    if (!invite || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await gcPrototypeApi.revokeInvite(invite.id)
      if (result.revoked !== true) throw new Error('Unexpected response')
      if (mounted.current) { setInvite(null); setStatus('Test invitation revoked. An already-created connection is not revoked.') }
    } catch { if (mounted.current) setError('Could not revoke this test invitation. It may have expired or the service is unavailable.') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const copy = async () => {
    if (!invite || Date.now() >= invite.expires) { setExpired(true); return }
    try { await navigator.clipboard.writeText(invite.url); if (mounted.current) setStatus('Test link copied.') }
    catch { if (mounted.current) setStatus('Copy failed. Select and copy the test link below.') }
  }
  const validEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(recipient.trim())
  const canCompose = validEmail && !!subject.trim() && !!message.trim()
  const mailto = invite && canCompose ? `mailto:${encodeURIComponent(recipient.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${message}\n\nExpires: ${new Date(invite.expires).toLocaleString()}\n\n${invite.url}`)}` : undefined
  const button = 'min-h-11 rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50'
  const input = 'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm'

  return <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
    <h3 id={`${id}-title`} className="font-bold text-slate-900">Create a test invitation</h3>
    <p className="text-sm text-slate-600">For synthetic data only. This one-use bearer link can be used by any qualifying subcontractor who receives it; it is not recipient-bound. A connection requires the subcontractor’s explicit consent and shares prototype structured COI information. Do not use real people or data.</p>
    {!invitePath && <p role="alert" className="text-sm text-amber-800">Recipient route is not configured. Invitations are unavailable until the prototype recipient flow and fragment handling are integrated.</p>}
    {!invite && <button type="button" disabled={busy || !invitePath} onClick={() => void create()} className={button}>{busy ? 'Creating…' : 'Create test invitation'}</button>}
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {status && <p role="status" className="text-sm text-slate-700">{status}</p>}
    {invite && <>
      {expired ? <p role="alert" className="text-sm text-amber-800">This test invitation has expired. Revoke or discard it and create another.</p> : <div className="space-y-3">
        <QRCodeSVG value={invite.url} size={160} level="M" marginSize={4} role="img" aria-label="Test subcontractor invitation QR code" />
        <p className="text-sm text-slate-600">Expires {new Date(invite.expires).toLocaleString()}. The QR, link and email draft contain the same bearer capability; share deliberately.</p>
        <p className="break-all select-all text-xs text-slate-700">{invite.url}</p>
        <button type="button" disabled={busy} onClick={() => void copy()} className={button}>Copy test link</button>
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <h4 className="font-semibold text-slate-900">Email draft</h4>
          <p id={`${id}-help`} className="text-sm text-slate-600">Opens your email app with the test link and expiry. Nothing is sent automatically; review and send it yourself. The draft exposes the bearer link to the email app and its recipients.</p>
          <label className="block text-sm">Recipient email <input type="email" maxLength={254} value={recipient} onChange={e => setRecipient(e.target.value)} className={input} /></label>
          <label className="block text-sm">Subject <input maxLength={120} value={subject} onChange={e => setSubject(e.target.value)} className={input} /></label>
          <label className="block text-sm">Message <textarea maxLength={2000} rows={3} value={message} onChange={e => setMessage(e.target.value)} className={input} /></label>
          {mailto ? <a href={mailto} aria-describedby={`${id}-help`} onClick={e => { if (Date.now() >= invite.expires || busy) { e.preventDefault(); if (Date.now() >= invite.expires) setExpired(true) } }} className={`inline-flex items-center ${button}`}>Open email draft</a> : <button type="button" disabled className={button}>Open email draft</button>}
        </div>
      </div>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={() => void revoke()} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Revoke test invitation</button>
        <button type="button" disabled={busy} onClick={() => { setInvite(null); setStatus('Invitation discarded locally; it may remain usable until it expires unless revoked.'); setError('') }} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Discard locally</button>
      </div>
    </>}
  </section>
}
