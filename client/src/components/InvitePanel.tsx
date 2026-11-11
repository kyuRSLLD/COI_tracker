import { useState, useEffect, useRef } from 'react'
import { Copy, Mail, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { apiStagedInvites } from '../api'
import { previewLink } from '../lib/stagedInvites'
export function InvitePanel({ hidden }: { hidden: boolean }) {
  const [invite, setInvite] = useState<{ url: string; expires: Date } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [recipient, setRecipient] = useState('')
  const [subject, setSubject] = useState('Development preview invitation on COI Shield')
  const [message, setMessage] = useState('Hello,\n\nPlease use this invitation to try a test relationship on COI Shield. This is not a live connection and does not share COIs:')
  const pending = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!invite) return
    const update = () => setExpired(Date.now() >= invite.expires.getTime())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [invite])

  const createInvite = async () => {
    if (pending.current) return
    pending.current = true
    setLoading(true)
    setError('')
    setInvite(null)
    setExpired(false)
    setCopyStatus('')
    try {
      const result = await apiStagedInvites.create()
      const url = previewLink('/invite-sub', result?.token)
      const expires = new Date(result?.expires_at)
      if (!url || typeof result?.expires_at !== 'string' || !Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error('Invalid invitation')
      if (mounted.current) setInvite({ url, expires })
    } catch {
      if (mounted.current) setError('Could not create an invitation. The invitation service may not be available yet. Please try again.')
    } finally {
      pending.current = false
      if (mounted.current) setLoading(false)
    }
  }

  const copy = async () => {
    if (!invite || Date.now() >= invite.expires.getTime()) { setExpired(true); return }
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopyStatus('Link copied.')
    } catch {
      setCopyStatus('Could not copy automatically. Select and copy the link below.')
    }
  }
  // Match the browser's single-address email syntax; never offer a draft for an empty or malformed recipient.
  const validEmail = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(recipient.trim())
  const canCompose = validEmail && !!subject.trim() && !!message.trim()
  const mailto = invite && canCompose
    ? `mailto:${encodeURIComponent(recipient.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${message}\n\n${invite.url}`)}`
    : undefined

  return (
    <section hidden={hidden} aria-label="Invite a subcontractor" className="mt-5 space-y-4">
      <p className="text-sm text-slate-600">Create a test invitation. Share the same link by QR code, copy it, or open an email draft. No live relationship or COI sharing will be created.</p>
      {!invite && (
        <button type="button" onClick={createInvite} disabled={loading} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-60">
          <QrCode className="w-4 h-4" /> {loading ? 'Creating invitation…' : error ? 'Try again' : 'Create invitation'}
        </button>
      )}
      {error && <p role="alert" className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</p>}
      {invite && expired && (
        <div role="alert" className="p-3 rounded-xl bg-amber-50 text-amber-900 text-sm border border-amber-200">
          This invitation has expired. <button type="button" onClick={createInvite} disabled={loading} className="font-bold underline">{loading ? 'Creating…' : 'Create another invitation'}</button>
        </div>
      )}
      {invite && !expired && (
        <>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 flex flex-col sm:flex-row gap-4 items-center sm:items-start">
            <div className="bg-white p-3 rounded-xl border border-slate-200 shrink-0"><QRCodeSVG value={invite.url} size={144} level="M" title="Subcontractor invitation QR code" /></div>
            <div className="min-w-0 w-full space-y-2">
              <p className="text-sm font-bold text-slate-900">Scan or share this invitation</p>
              <p className="text-xs text-slate-500">Expires {invite.expires.toLocaleString()}. Share only with the intended subcontractor.</p>
              <p className="text-xs text-slate-600 break-all select-all">{invite.url}</p>
              <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-700 hover:text-brand-800"><Copy className="w-3.5 h-3.5" /> Copy link</button>
              <p role="status" className="text-xs text-slate-500">{copyStatus}</p>
            </div>
          </div>
          <form onSubmit={e => e.preventDefault()} className="space-y-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Email invitation</h3>
              <p id="email-help" className="text-xs text-slate-500 mt-1">This opens a draft in your email app. Review it and press Send there; COI Shield does not send it for you. The invitation link is added to the message.</p>
            </div>
            <div>
              <label htmlFor="invite-recipient" className="block text-xs font-semibold text-slate-700 mb-1">Recipient email *</label>
              <input id="invite-recipient" type="email" required maxLength={254} value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="name@example.com" className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="invite-subject" className="block text-xs font-semibold text-slate-700 mb-1">Subject *</label>
              <input id="invite-subject" required maxLength={120} value={subject} onChange={e => setSubject(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            <div>
              <label htmlFor="invite-message" className="block text-xs font-semibold text-slate-700 mb-1">Message *</label>
              <textarea id="invite-message" required maxLength={2000} rows={3} value={message} onChange={e => setMessage(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            </div>
            {canCompose ? (
              <a href={mailto} aria-describedby="email-help" onClick={e => {
                if (Date.now() >= invite.expires.getTime()) { e.preventDefault(); setExpired(true) }
              }} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700"><Mail className="w-4 h-4" /> Open email draft</a>
            ) : (
              <div>
                <button type="button" disabled className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-brand-600 opacity-50"><Mail className="w-4 h-4" /> Open email draft</button>
                <p className="text-xs text-slate-500 mt-1">Enter a valid recipient, subject, and message to open a draft.</p>
              </div>
            )}
          </form>
        </>
      )}
    </section>
  )
}
