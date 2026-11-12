import { useContext, useEffect, useRef, useState } from 'react'
import { QRCodeCanvas } from 'qrcode.react'
import { Link2, QrCode } from 'lucide-react'
import { apiConnectionQr, getToken, SESSION_CHANGED_EVENT } from '../api'
import { CONNECTION_TOKEN, ConnectionSession } from './ConnectionOptions'

type ConnectionCode = { token: string; expiresAt: string }

export function SubConnectionQr() {
  const { role, token } = useContext(ConnectionSession)
  // A new verified session gets a completely new set of consent and code state.
  if (role !== 'sub' || !token) return null
  return <SessionConnectionQr key={token} sessionToken={token} />
}

function SessionConnectionQr({ sessionToken }: { sessionToken: string }) {
  const [consent, setConsent] = useState(false)
  const [code, setCode] = useState<ConnectionCode | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  const active = useRef(true)
  const invalidated = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const linkRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    active.current = true
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'coi_token' || event.key === null) && event.newValue !== sessionToken) invalidated.current = true
    }
    const sessionChanged = () => { if (getToken() !== sessionToken) invalidated.current = true }
    window.addEventListener('storage', storageChanged)
    window.addEventListener(SESSION_CHANGED_EVENT, sessionChanged)
    return () => {
      active.current = false
      window.removeEventListener('storage', storageChanged)
      window.removeEventListener(SESSION_CHANGED_EVENT, sessionChanged)
    }
  }, [sessionToken])
  const sessionCurrent = () => active.current && !invalidated.current && getToken() === sessionToken
  const verifySession = () => {
    if (sessionCurrent()) return true
    if (active.current) window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
    return false
  }

  // Hide the credential as soon as it expires, including when a background tab resumes.
  useEffect(() => {
    if (!code) return
    const expire = () => {
      if (!active.current || invalidated.current || getToken() !== sessionToken) return
      if (Date.now() >= new Date(code.expiresAt).getTime()) {
        setCode(null)
        setConsent(false)
        setError(null)
        setMessage('This QR code has expired. Give consent again to generate a new one.')
      }
    }
    expire()
    const timeout = window.setTimeout(expire, Math.max(0, new Date(code.expiresAt).getTime() - Date.now()))
    window.addEventListener('focus', expire)
    document.addEventListener('visibilitychange', expire)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('focus', expire)
      document.removeEventListener('visibilitychange', expire)
    }
  }, [code, sessionToken])

  const generate = async () => {
    if (!consent || busyRef.current || code || !verifySession()) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await apiConnectionQr.create(true, sessionToken)
      if (!sessionCurrent()) return
      if (!CONNECTION_TOKEN.test(result.token || '') || !Number.isFinite(Date.parse(result.expiresAt))) {
        // If the server issued a token without a usable expiry, do not display it.
        if (CONNECTION_TOKEN.test(result.token || '')) {
          try { await apiConnectionQr.revoke(result.token, sessionToken) } catch { /* It will expire server-side. */ }
        }
        throw new Error('Invalid response')
      }
      if (Date.parse(result.expiresAt) <= Date.now()) {
        setConsent(false)
        setMessage('This QR code has expired. Give consent again to generate a new one.')
      } else {
        setCode(result)
      }
    } catch {
      if (sessionCurrent()) setError('Could not generate a QR code. Please try again.')
    } finally {
      busyRef.current = false
      if (sessionCurrent()) setBusy(false)
    }
  }

  const revoke = async () => {
    if (!code || busyRef.current || !verifySession()) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await apiConnectionQr.revoke(code.token, sessionToken)
      if (!sessionCurrent()) return
      setCode(null)
      setConsent(false)
      setMessage('The QR code was revoked. An already-connected general contractor is not disconnected.')
    } catch {
      if (sessionCurrent()) setError('Could not revoke the QR code. It may still be usable until it expires; please try again.')
    } finally {
      busyRef.current = false
      if (sessionCurrent()) setBusy(false)
    }
  }

  const isCurrent = () => sessionCurrent() && code !== null && Date.now() < new Date(code.expiresAt).getTime()
  const link = code ? `https://safecoi.com/connect-sub#${code.token}` : ''

  const copyLink = async () => {
    if (!verifySession() || !isCurrent()) return
    setError(null)
    setMessage(null)
    try {
      await navigator.clipboard.writeText(link)
      if (isCurrent()) setMessage('Connection link copied. Share it only with your intended general contractor.')
    } catch {
      if (!isCurrent()) return
      linkRef.current?.focus()
      linkRef.current?.select()
      setError('Could not copy automatically. Select and copy the link shown below.')
    }
  }

  const copyQr = async () => {
    if (!verifySession() || !isCurrent() || !canvasRef.current) return
    setError(null)
    setMessage(null)
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard unavailable')
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvasRef.current?.toBlob((image) => image ? resolve(image) : reject(new Error('Image unavailable')), 'image/png')
      })
      if (!isCurrent()) return
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      if (isCurrent()) setMessage('QR code copied. Share it only with your intended general contractor.')
    } catch {
      if (isCurrent()) setError('Could not copy the QR code. You can take a screenshot or copy the link instead.')
    }
  }

  return (
    <section className="rounded-2xl bg-white border border-slate-200 p-6 shadow-sm" aria-labelledby="share-with-gc-heading">
      <div className="flex items-center gap-2 mb-2">
        <QrCode className="w-4 h-4 text-slate-700" aria-hidden="true" />
        <h2 id="share-with-gc-heading" className="text-sm font-semibold text-slate-900">Share with a general contractor</h2>
      </div>
      <p className="text-xs text-slate-700">
        You choose whether to connect one general contractor, granting them ongoing access to your profile and <strong>all current and future certificates of insurance (COIs) you own</strong>. The general contractor may also include anonymized insurance information in client reports they share. Only show or share this code with the intended general contractor.
      </p>
      <p className="text-xs text-slate-600 mt-2">
        The code expires after 15 minutes. No email is sent. Revoking an unclaimed QR code does not disconnect a general contractor who is already connected. Leaving this page does not revoke the code.
      </p>

      {!code ? (
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2 text-xs text-slate-800">
            <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5" />
            <span>I agree to give one general contractor ongoing access to my profile and all current and future COIs I own, including possible sharing of anonymized insurance information in client reports.</span>
          </label>
          <button type="button" disabled={!consent || busy} onClick={generate} className="px-4 py-2 rounded-xl bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40">
            {busy ? 'Generating…' : 'Generate QR code'}
          </button>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-slate-700">Ask your intended general contractor to scan this code, or share a screenshot or link privately.</p>
          <div className="inline-block p-3 bg-white border border-slate-200 rounded-xl">
            <QRCodeCanvas ref={canvasRef} value={link} size={220} marginSize={4} aria-label="QR code to connect one general contractor" role="img" />
          </div>
          <p className="text-xs text-slate-600">Expires: <time dateTime={code.expiresAt}>{new Date(code.expiresAt).toLocaleString()}</time></p>
          <label htmlFor="gc-connection-link" className="block text-xs font-semibold text-slate-700">Private connection link</label>
          <input id="gc-connection-link" ref={linkRef} readOnly value={link} onFocus={(event) => event.currentTarget.select()} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-xs text-slate-700" />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={copyLink} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Copy link
            </button>
            <button type="button" disabled={busy} onClick={copyQr} className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">Copy QR code</button>
            <button type="button" disabled={busy} onClick={revoke} className="px-3 py-2 rounded-lg border border-rose-300 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40">{busy ? 'Revoking…' : 'Revoke / cancel QR code'}</button>
          </div>
        </div>
      )}
      {message && <p role="status" className="mt-3 text-xs text-emerald-700">{message}</p>}
      {error && <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p>}
    </section>
  )
}
