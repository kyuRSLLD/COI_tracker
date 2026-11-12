import { createContext, useContext, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { ApiError, apiConnectionQr, apiQrInvite, getToken, SESSION_CHANGED_EVENT } from '../api'

export const ConnectionSession = createContext<{ role: string | null; token: string | null }>({ role: null, token: null })
// Unlike $, this end assertion cannot match before a trailing newline.
export const CONNECTION_TOKEN = /^[A-Za-z0-9_-]{43}(?![\s\S])/

// Only these exact HTTPS production aliases and route are accepted. The QR is
// never navigated to or submitted anywhere; only its validated token is used.
export function tokenFromQr(value: string): string | null {
  const match = /^https:\/\/(?:www\.)?safecoi\.com\/connect-sub#([A-Za-z0-9_-]{43})(?![\s\S])/.exec(value)
  return match ? match[1] : null
}

async function decodeScreenshot(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Choose a PNG or JPG image.')
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('Could not read this image. Try another PNG or JPG.'))
      image.src = url
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Could not read this image.')
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Could not read this image in your browser.')
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const decoded = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })
    if (!decoded) throw new Error('No QR code found. Try a clearer screenshot with the entire code visible.')
    const token = tokenFromQr(decoded.data)
    if (!token) throw new Error('This is not a valid SafeCOI subcontractor connection QR code.')
    return token
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function connectionError(err: unknown): string {
  if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 410)) return 'This connection code is invalid, expired, or no longer available. Ask the subcontractor for a new QR code.'
  if (err instanceof ApiError && err.status === 403) return 'This account cannot connect using this code. Sign in as a general contractor and try again.'
  return 'Could not complete the connection. Please check your session and try again.'
}

const inputClass = 'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500'
const buttonClass = 'px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 transition'

export function ConnectionOptions({ onSaved }: { onSaved: () => void }) {
  const { role, token: sessionToken } = useContext(ConnectionSession)
  if (role !== 'gc' || !sessionToken) return null
  return <SessionConnectionOptions key={sessionToken} sessionToken={sessionToken} onSaved={onSaved} />
}

function SessionConnectionOptions({ sessionToken, onSaved }: { sessionToken: string; onSaved: () => void }) {
  const [mode, setMode] = useState<'qr' | 'email'>('qr')
  const [qrToken, setQrToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [decoding, setDecoding] = useState(false)
  const [connectedName, setConnectedName] = useState<string | null>(null)
  const [recipient, setRecipient] = useState('')
  const [invite, setInvite] = useState<{ invite_url: string; company_name: string } | null>(null)
  const active = useRef(true)
  const decodeVersion = useRef(0)
  useEffect(() => { active.current = true; return () => { active.current = false; decodeVersion.current++ } }, [])

  const selectImage = async (file?: File) => {
    const version = ++decodeVersion.current
    setQrToken(null); setConnectedName(null); setError(null)
    if (!file) { setDecoding(false); return }
    setDecoding(true)
    try {
      const token = await decodeScreenshot(file)
      if (active.current && version === decodeVersion.current && getToken() === sessionToken) setQrToken(token)
    } catch (err) {
      if (active.current && version === decodeVersion.current && getToken() === sessionToken) setError(err instanceof Error ? err.message : 'Could not decode this image. Try another screenshot.')
    } finally {
      if (active.current && version === decodeVersion.current && getToken() === sessionToken) setDecoding(false)
    }
  }
  const connect = async () => {
    if (!qrToken || working) return
    if (getToken() !== sessionToken) {
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
      setError('Your session changed. Please wait for verification and try again.')
      return
    }
    setWorking(true); setError(null)
    try {
      const result = await apiConnectionQr.redeem(qrToken, sessionToken)
      if (!result.success || !result.subcontractor?.company_name) throw new Error('Unsuccessful connection')
      if (active.current && getToken() === sessionToken) {
        setQrToken(null); setConnectedName(result.subcontractor.company_name)
        onSaved()
      }
    } catch (err) {
      if (active.current && getToken() === sessionToken) setError(connectionError(err))
    } finally { if (active.current && getToken() === sessionToken) setWorking(false) }
  }
  const prepareEmail = async (event: React.FormEvent) => {
    event.preventDefault()
    if (working) return
    if (getToken() !== sessionToken) {
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
      setError('Your session changed. Please wait for verification and try again.')
      return
    }
    setWorking(true); setError(null); setInvite(null)
    try {
      const result = await apiQrInvite(sessionToken)
      if (active.current && getToken() === sessionToken) setInvite(result)
    } catch {
      if (active.current && getToken() === sessionToken) setError('Could not prepare your invitation link. Please check your session and try again.')
    } finally { if (active.current && getToken() === sessionToken) setWorking(false) }
  }
  const subject = 'Invitation to connect on COI Shield'
  const body = `Hello,\n\nPlease use this link to join and connect with ${invite?.company_name || 'our company'} on COI Shield:\n\n${invite?.invite_url || ''}\n\nThank you.`
  return <div className="mt-4 border-t border-slate-200 pt-4 space-y-3">
    <div className="flex gap-2 text-xs" aria-label="Connection method">
      <button type="button" aria-pressed={mode === 'qr'} onClick={() => { setMode('qr'); setError(null) }} className={`rounded-lg px-3 py-2 font-semibold ${mode === 'qr' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>Upload sub QR</button>
      <button type="button" aria-pressed={mode === 'email'} onClick={() => { decodeVersion.current++; setQrToken(null); setDecoding(false); setMode('email'); setError(null) }} className={`rounded-lg px-3 py-2 font-semibold ${mode === 'email' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}>Invite by email</button>
    </div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</p>}
    {mode === 'qr' ? <div className="space-y-3 text-xs text-slate-600">
      <p>Ask the subcontractor to create their connection QR code and send you a screenshot. Your image is read on this device and is not uploaded.</p>
      <label className="block font-semibold text-slate-700">Screenshot (PNG or JPG)
        <input type="file" accept="image/png,image/jpeg" disabled={working} onChange={e => { void selectImage(e.target.files?.[0]); e.target.value = '' }} className="block w-full mt-1 text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-semibold file:text-slate-700" />
      </label>
      {decoding && <p>Reading QR code…</p>}
      {qrToken && !decoding && <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-2"><p>Connection QR detected. Connect to add or link this subcontractor to your account.</p><button type="button" disabled={working} onClick={() => void connect()} className={buttonClass}>{working ? 'Connecting…' : 'Connect subcontractor'}</button> <button type="button" disabled={working} onClick={() => { setQrToken(null); setError(null) }} className="px-3 py-2 rounded-xl font-semibold underline disabled:opacity-50">Cancel</button></div>}
      {connectedName && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">Connected: <strong>{connectedName}</strong>.</p>}
    </div> : <form onSubmit={prepareEmail} className="space-y-3 text-xs text-slate-600">
      <p>Prepare your company’s onboarding invitation for the subcontractor. They will need to accept it to connect.</p>
      <label className="block font-semibold text-slate-700">Subcontractor email
        <input required type="email" value={recipient} onChange={e => { setRecipient(e.target.value); setInvite(null) }} placeholder="subcontractor@example.com" className={`${inputClass} mt-1`} />
      </label>
      <button type="submit" disabled={working} className={buttonClass}>{working ? 'Preparing…' : 'Prepare invitation'}</button>
      {invite && <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-2"><p>This opens your email application with a draft. No email has been sent automatically; review and send it there.</p><a className="inline-block font-semibold text-indigo-700 underline" href={`mailto:${encodeURIComponent(recipient.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>Open email application</a></div>}
    </form>}
  </div>
}
