import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeCanvas } from 'qrcode.react'
import { Link2, QrCode, X } from 'lucide-react'
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
  const [open, setOpen] = useState(false)
  const busyRef = useRef(false)
  const active = useRef(true)
  const invalidated = useRef(false)
  const codeRef = useRef<ConnectionCode | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const linkRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    active.current = true
    const invalidate = () => {
      invalidated.current = true
      codeRef.current = null
      setCode(null)
      setConsent(false)
      setOpen(false)
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'coi_token' || event.key === null) && event.newValue !== sessionToken) invalidate()
    }
    const sessionChanged = () => { if (getToken() !== sessionToken) invalidate() }
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

  // A native modal puts the rest of the page in the inert layer, traps focus and
  // handles focus navigation even as controls are enabled or replaced.
  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return
    const dialog = dialogRef.current
    const body = document.body
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const previousStyles = { overflow: body.style.overflow, position: body.style.position, top: body.style.top, left: body.style.left, width: body.style.width }
    Object.assign(body.style, { overflow: 'hidden', position: 'fixed', top: `-${scrollY}px`, left: `-${scrollX}px`, width: '100%' })
    dialog.showModal()
    closeRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
      Object.assign(body.style, previousStyles)
      window.scrollTo(scrollX, scrollY)
      if (!invalidated.current && getToken() === sessionToken && openerRef.current?.isConnected) openerRef.current.focus()
    }
  }, [open, sessionToken])

  useLayoutEffect(() => {
    // Replacing or disabling a focused control (for example on revoke) should
    // not leave keyboard focus behind the modal.
    if (open && dialogRef.current && !dialogRef.current.contains(document.activeElement)) closeRef.current?.focus()
  }, [open, code, busy])

  // Hide the credential as soon as it expires, including when a background tab resumes.
  useEffect(() => {
    if (!code) return
    const expire = () => {
      if (!active.current || invalidated.current || getToken() !== sessionToken) return
      if (Date.now() >= new Date(code.expiresAt).getTime()) {
        codeRef.current = null
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
        codeRef.current = result
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
      codeRef.current = null
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

  const isCurrent = () => sessionCurrent() && code !== null && codeRef.current?.token === code.token && Date.now() < new Date(code.expiresAt).getTime()
  const link = code ? `https://safecoi.com/connect-sub#${code.token}` : ''

  const openDialog = () => {
    if (!verifySession()) return
    if (code && Date.now() >= new Date(code.expiresAt).getTime()) {
      codeRef.current = null
      setCode(null)
      setConsent(false)
      setError(null)
      setMessage('This QR code has expired. Give consent again to generate a new one.')
    }
    setOpen(true)
  }

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
      <button ref={openerRef} type="button" onClick={openDialog} className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900">
        <QrCode className="h-4 w-4" aria-hidden="true" /> Show connection QR code
      </button>

      {open && createPortal(
        <dialog ref={dialogRef} aria-modal="true" aria-labelledby="connection-qr-dialog-title" aria-describedby="connection-qr-scope" onCancel={(event) => { event.preventDefault(); setOpen(false) }} onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
          const first = controls[0]
          const last = controls[controls.length - 1]
          if (!first || !last) { event.preventDefault(); return }
          if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) { event.preventDefault(); first.focus() }
        }} className="fixed inset-0 m-0 h-screen h-[100dvh] max-h-none w-full max-w-none overflow-y-auto border-0 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/60 sm:m-auto sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[min(36rem,calc(100%-2rem))] sm:rounded-2xl">
          <div className="px-5 pb-6 pt-5 sm:px-8 sm:pb-8 sm:pt-6" style={{ paddingTop: 'max(1.25rem, env(safe-area-inset-top))', paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Share securely</p>
                <h2 id="connection-qr-dialog-title" className="mt-1 text-xl font-semibold text-slate-900">Connection QR code</h2>
              </div>
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close connection QR code dialog" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900"><X className="h-5 w-5" aria-hidden="true" /></button>
            </div>

            <p id="connection-qr-scope" className="mt-4 text-sm leading-relaxed text-slate-700">
              You choose whether to connect one general contractor, granting them ongoing access to your profile and <strong>all current and future certificates of insurance (COIs) you own</strong>. The general contractor may also include anonymized insurance information in client reports they share. Only show or share this code with the intended general contractor.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">
              The code expires after 15 minutes. No email is sent. Revoking an unclaimed QR code does not disconnect a general contractor who is already connected. Closing this dialog or leaving this page does not revoke an unexpired code.
            </p>

            {!code ? (
              <div className="mt-5 space-y-4">
                <label className="flex items-start gap-3 text-sm leading-relaxed text-slate-800">
                  <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4 shrink-0" />
                  <span>I agree to give one general contractor ongoing access to my profile and all current and future COIs I own, including possible sharing of anonymized insurance information in client reports.</span>
                </label>
                <button type="button" disabled={!consent || busy} onClick={generate} className="min-h-[44px] rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-40">
                  {busy ? 'Generating…' : 'Generate QR code'}
                </button>
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <p className="text-sm text-slate-700">Ask your intended general contractor to scan this code, or share a screenshot or link privately.</p>
                <div className="mx-auto w-full max-w-[320px] rounded-xl border border-slate-200 bg-white p-3">
                  <QRCodeCanvas ref={canvasRef} value={link} size={512} marginSize={4} style={{ width: '100%', height: 'auto' }} aria-label="QR code to connect one general contractor" role="img" />
                </div>
                <p className="text-sm text-slate-600">Expires: <time dateTime={code.expiresAt}>{new Date(code.expiresAt).toLocaleString()}</time></p>
                <div>
                  <label htmlFor="gc-connection-link" className="block text-sm font-semibold text-slate-700">Private connection link</label>
                  <input id="gc-connection-link" ref={linkRef} readOnly value={link} onFocus={(event) => event.currentTarget.select()} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={copyLink} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">
                    <Link2 className="h-4 w-4" aria-hidden="true" /> Copy link
                  </button>
                  <button type="button" disabled={busy} onClick={copyQr} className="min-h-[44px] rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">Copy QR code</button>
                  <button type="button" disabled={busy} onClick={revoke} className="min-h-[44px] rounded-lg border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-40">{busy ? 'Revoking…' : 'Revoke / cancel QR code'}</button>
                </div>
              </div>
            )}
            {message && <p role="status" className="mt-4 text-sm text-emerald-700">{message}</p>}
            {error && <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p>}
          </div>
        </dialog>, document.body
      )}
    </section>
  )
}
