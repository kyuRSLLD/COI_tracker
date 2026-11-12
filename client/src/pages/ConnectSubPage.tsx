import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiConnectionQr, apiLogin, getToken, SESSION_CHANGED_EVENT } from '../api'
import type { User } from '../types'
import { CONNECTION_TOKEN, connectionError } from '../components/ConnectionOptions'

const PENDING_KEY = 'coi_pending_sub_connection'
let memoryToken: string | null = null
let pendingVersion = 0

// Remove credentials left by older versions, but never read or persist a code.
// A document reload (or crash) must not revive an abandoned connection.
try { sessionStorage.removeItem(PENDING_KEY) } catch { /* Storage may be disabled. */ }

function savePending(token: string | null) {
  pendingVersion++
  memoryToken = token
}

function clearPending() {
  savePending(null)
  if (window.location.pathname === '/connect-sub' && window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
}

function isCurrentConnectionPage() {
  return window.location.pathname === '/connect-sub' && !window.location.hash
}

// Register before fragment capture and React mounting. This also invalidates
// in-flight work and cached documents even if a React effect never ran.
window.addEventListener('pagehide', clearPending)

// Called before React mounts, and again for in-app navigation. Fragments are not
// sent to the server. Remove them from the visible URL immediately after capture.
export function captureConnectionFragment() {
  if (window.location.pathname !== '/connect-sub' || !window.location.hash) return
  const fragment = window.location.hash.slice(1)
  savePending(CONNECTION_TOKEN.test(fragment) ? fragment : null)
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
}

type Props = {
  user: User | null
  sessionToken: string | null
  sessionStatus: 'checking' | 'authenticated' | 'anonymous' | 'error'
  getSessionVersion: () => number
  onSession: (session: { token: string; user: User }, version: number) => Promise<void>
  onSwitchAccount: () => void
  onSaved: () => void
}

export function ConnectSubPage({ user, sessionToken, sessionStatus, getSessionVersion, onSession, onSwitchAccount, onSaved }: Props) {
  captureConnectionFragment()
  const [qrToken, setQrToken] = useState(() => memoryToken)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ session: string; name: string } | null>(null)
  const active = useRef(true)
  const pendingOwner = useRef(pendingVersion)
  const identity = useRef({ status: sessionStatus, token: sessionToken, generation: 0 })
  if (identity.current.status !== sessionStatus || identity.current.token !== sessionToken) {
    identity.current = { status: sessionStatus, token: sessionToken, generation: identity.current.generation + 1 }
  }
  useEffect(() => {
    active.current = true
    const clearOwnedPending = () => {
      // Do not erase a newer QR captured while this page was being replaced.
      if (pendingVersion === pendingOwner.current) clearPending()
    }
    const clearRestoredView = () => {
      if (pendingVersion !== pendingOwner.current) {
        setQrToken(null); setPassword(''); setError(null); setWorking(false)
      }
    }
    window.addEventListener('pagehide', clearRestoredView)
    window.addEventListener('pageshow', clearRestoredView)
    return () => {
      active.current = false
      window.removeEventListener('pagehide', clearRestoredView)
      window.removeEventListener('pageshow', clearRestoredView)
      // React StrictMode rehearses cleanup and immediately remounts effects.
      // Defer actual disposal until we know this was a real unmount.
      queueMicrotask(() => { if (!active.current) clearOwnedPending() })
    }
  }, [])
  const cancel = () => {
    clearPending()
    setQrToken(null)
    setPassword('')
    setError(null)
  }
  const signIn = async (event: React.FormEvent) => {
    event.preventDefault()
    if (working || !qrToken || !isCurrentConnectionPage() || memoryToken !== qrToken || pendingVersion !== pendingOwner.current || sessionStatus !== 'anonymous' || getToken()) return
    const version = getSessionVersion()
    const generation = identity.current.generation
    setWorking(true); setError(null)
    try {
      const result = await apiLogin(email, password)
      if (!active.current || !isCurrentConnectionPage() || pendingVersion !== pendingOwner.current || getToken() || identity.current.generation !== generation) return
      await onSession(result, version)
      if (active.current) { setPassword(''); setError(null) }
    } catch {
      if (active.current && pendingVersion === pendingOwner.current && identity.current.generation === generation) setError('Could not sign in. Check your credentials and try again.')
    } finally { if (active.current) setWorking(false) }
  }
  const connect = async () => {
    if (working || !qrToken || !isCurrentConnectionPage() || memoryToken !== qrToken || pendingVersion !== pendingOwner.current || !sessionToken || user?.role !== 'gc' || sessionStatus !== 'authenticated') return
    if (getToken() !== sessionToken) {
      window.dispatchEvent(new Event(SESSION_CHANGED_EVENT))
      setError('Your session changed. Please wait for verification and try again.')
      return
    }
    const generation = identity.current.generation
    setWorking(true); setError(null)
    try {
      const result = await apiConnectionQr.redeem(qrToken, sessionToken)
      if (!result.success || !result.subcontractor?.company_name) throw new Error('Unsuccessful connection')
      if (active.current && isCurrentConnectionPage() && pendingVersion === pendingOwner.current && getToken() === sessionToken && identity.current.generation === generation) {
        clearPending(); setQrToken(null)
        setSuccess({ session: sessionToken, name: result.subcontractor.company_name })
        onSaved()
      }
    } catch (err) {
      if (active.current && pendingVersion === pendingOwner.current && getToken() === sessionToken && identity.current.generation === generation) setError(connectionError(err))
    } finally { if (active.current && identity.current.generation === generation) setWorking(false) }
  }
  // A changed identity invalidates in-flight state and never exposes a prior result.
  useEffect(() => { setWorking(false); setError(null); setPassword(''); setSuccess(null) }, [sessionStatus, sessionToken])
  const inputClass = 'w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500'
  return <div className="max-w-lg mx-auto px-4 py-12">
    <div className="bg-white rounded-3xl p-6 sm:p-8 border border-slate-200 shadow-card space-y-4">
      <p className="text-xs font-bold uppercase tracking-wider text-brand-600">COI Shield</p>
      <h1 className="text-xl font-extrabold text-slate-900">Connect a subcontractor</h1>
      <p className="text-sm text-slate-600">A subcontractor shared a connection code. Sign in as a general contractor and confirm before connecting.</p>
      {error && <p role="alert" className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</p>}
      {sessionStatus === 'checking' && <p className="text-sm text-slate-500">Checking your session…</p>}
      {sessionStatus === 'error' && <p className="text-sm text-slate-500">Your session could not be verified. Retry or switch account above.</p>}
      {sessionStatus === 'anonymous' && (qrToken ? <form onSubmit={signIn} className="space-y-3">
        <label className="block text-xs font-semibold text-slate-700">Email<input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <label className="block text-xs font-semibold text-slate-700">Password<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={`${inputClass} mt-1`} /></label>
        <button disabled={working} className="w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{working ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-slate-500">Signing in does not connect the account. You will confirm on this page.</p>
      </form> : <p className="text-sm text-slate-600">No valid connection code is available. Ask the subcontractor for a new QR code.</p>)}
      {sessionStatus === 'authenticated' && user && <div className="space-y-3 text-sm text-slate-600">
        <p>Signed in as <strong>{user.email}</strong></p>
        {user.role !== 'gc' ? <p>Only general contractor accounts can connect a subcontractor. Switch to a general contractor account to continue.</p> : success?.session === sessionToken ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">Connected: <strong>{success.name}</strong>.</p> : qrToken ? <button type="button" disabled={working} onClick={() => void connect()} className="rounded-xl bg-brand-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{working ? 'Connecting…' : 'Connect subcontractor'}</button> : <p>No valid connection code is available. Ask the subcontractor for a new QR code.</p>}
        <button type="button" disabled={working} onClick={onSwitchAccount} className="block text-xs font-semibold underline disabled:opacity-50">Switch account</button>
      </div>}
      {qrToken && <button type="button" disabled={working} onClick={cancel} className="block text-xs font-semibold text-slate-600 underline disabled:opacity-50">Cancel connection</button>}
      <Link to="/" onClick={cancel} className="inline-block text-xs text-slate-500 underline">Back to home</Link>
    </div>
  </div>
}
