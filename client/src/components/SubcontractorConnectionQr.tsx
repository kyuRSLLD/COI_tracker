import { parseSubcontractorQr } from '../lib/subcontractorQr'
import { previewNotice } from '../lib/stagedInvites'
import { useEffect, useId, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'

export interface SubcontractorConnectionInvite {
  id: string
  invite_url: string
  expires_at: string
}

export interface SubcontractorConnectionQrProps {
  /** Called only after the subcontractor explicitly requests a connection code. */
  createConnectionInvite: (trade: string) => Promise<SubcontractorConnectionInvite>
  /** The caller must revoke this specific invite on the server; resolving means it is revoked. */
  revokeConnectionInvite?: (invite: SubcontractorConnectionInvite) => Promise<void>
}

/**
 * UI only: the integrating application must restrict this to the authorized subcontractor.
 * The server is responsible for issuing, expiring, redeeming and revoking connection invites.
 */
export function SubcontractorConnectionQr({
  createConnectionInvite,
  revokeConnectionInvite,
}: SubcontractorConnectionQrProps) {
  const titleId = useId()
  const [trade, setTrade] = useState('')
  const [invite, setInvite] = useState<SubcontractorConnectionInvite | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const actionInProgress = useRef(false)
  const expiresAt = invite ? Date.parse(invite.expires_at) : 0
  const isActive = !!invite && now < expiresAt
  const remainingSeconds = isActive ? Math.ceil((expiresAt - now) / 1000) : 0
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60

  useEffect(() => {
    if (!invite) return
    const update = () => setNow(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    const expiryTimer = window.setTimeout(update, Math.min(Math.max(0, Date.parse(invite.expires_at) - Date.now()), 2147483647))
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(expiryTimer)
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
    }
  }, [invite])

  async function generate() {
    if (actionInProgress.current) return
    if (!trade.trim() || trade.trim().length > 120 || /[\x00-\x1f\x7f]/.test(trade)) {
      setError('Enter your trade using 1 to 120 characters.')
      return
    }
    actionInProgress.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const created = await createConnectionInvite(trade.trim())
      const expiry = Date.parse(created?.expires_at)
      // Only absolute HTTP(S) URLs can be scanned reliably by a different device.
      const url = new URL(created?.invite_url)
      if (!parseSubcontractorQr(created.invite_url, window.location.origin) || url.origin !== window.location.origin || url.username || url.password ||
          new TextEncoder().encode(created.invite_url).length > 2000 || !Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new Error('Invalid invitation')
      }
      setNow(Date.now())
      setInvite(created)
    } catch {
      // Do not display or log server errors: they might contain the secret URL.
      setError('Unable to generate a valid connection code. Please try again.')
    } finally {
      actionInProgress.current = false
      setBusy(false)
    }
  }

  async function copy() {
    if (!invite || Date.now() >= expiresAt) {
      setNow(Date.now())
      return
    }
    setError('')
    try {
      await navigator.clipboard.writeText(invite.invite_url)
      setNotice('Connection link copied. Share it only with a GC you trust.')
    } catch {
      setError('Could not copy the link on this device. The GC can scan the code instead.')
    }
  }

  async function revoke() {
    if (!invite || !revokeConnectionInvite || actionInProgress.current) return
    actionInProgress.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await revokeConnectionInvite(invite)
      setInvite(null)
      setNotice('Connection code revoked. You can generate a new one when needed.')
    } catch {
      setNow(Date.now())
      setError('Could not revoke the connection code. It may remain usable until it expires.')
    } finally {
      actionInProgress.current = false
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby={titleId} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{previewNotice}</p>
      <h2 id={titleId} className="text-lg font-bold text-slate-900">Connect with a general contractor</h2>
      <p className="mt-2 text-sm text-slate-600">
        Generate a test code for a general contractor (GC) to scan and record a test relationship.
        This does not attach a certificate of insurance.
      </p>
      <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
        <strong>Share carefully.</strong> Any GC who receives this code can immediately record a test relationship until it expires.
        Only show it to a GC you trust.
      </div>

      {isActive && invite ? (
        <div className="mt-5">
          <div className="flex justify-center">
            <div className="max-w-full rounded-xl border border-slate-200 bg-white p-4">
              <QRCodeSVG value={invite.invite_url} size={208} level="M" marginSize={4} role="img" aria-label="Connection QR code for a general contractor to scan" className="h-auto max-w-full" />
            </div>
          </div>
          <p className="mt-3 text-center text-sm font-semibold text-slate-800">
            Expires in {minutes}:{String(seconds).padStart(2, '0')}
          </p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button type="button" onClick={copy} disabled={busy} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60">
              Copy connection link
            </button>
            {revokeConnectionInvite && (
              <button type="button" onClick={revoke} disabled={busy} className="min-h-11 rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 disabled:opacity-60">
                {busy ? 'Revoking…' : 'Revoke code'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          {invite && <p role="status" className="mb-3 text-sm font-semibold text-slate-700">This code has expired. Generate a new code for another test.</p>}
          <label htmlFor={`${titleId}-trade`} className="mb-1 block text-sm font-semibold text-slate-700">Trade to share with the contractor</label>
          <input id={`${titleId}-trade`} value={trade} onChange={e => setTrade(e.target.value)} maxLength={120} className="mb-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-base" placeholder="e.g. Electrical" />
          <button type="button" onClick={generate} disabled={busy} className="min-h-11 w-full rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60 sm:w-auto">
            {busy ? 'Generating…' : invite ? 'Generate new code' : 'Generate connection code'}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-slate-700">{notice}</p>}
    </section>
  )
}
