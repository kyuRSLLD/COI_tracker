import { useCallback, useEffect, useRef, useState } from 'react'
import { V2Auth } from '../v2-auth/V2Auth'
import { GcConnections } from './GcConnections'
import { SubcontractorWorkflow } from './SubcontractorWorkflow'
import { PrivateFiles } from './PrivateFiles'
import { GcGrantedFiles } from './GcGrantedFiles'
import './v2-shell.css'

type Login = { token: string; token_type: 'Bearer'; expires_in: number; expiresAt: number }
type Session = { token: string; expiresAt: number; generation: number }
type Identity = { subject: string; role: 'gc' | 'sub' | 'admin' }
type Verification = { state: 'checking' | 'unavailable' } | { state: 'ready'; identity: Identity }
type Section = 'workflow' | 'files'
const CHECK_INTERVAL_MS = 10_000

// Same-origin, bearer-only, no cookies or browser cache. No role or identity is
// taken from token claims or from the registration form.
function authRequest(path: '/api/v2/auth/me' | '/api/v2/auth/logout', token: string, signal: AbortSignal, method: 'GET' | 'POST') {
  return fetch(path, { method, signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'same-origin', referrerPolicy: 'no-referrer' })
}
function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.subject === 'string' && v.subject.length > 0 && v.subject.length <= 256 && (v.role === 'gc' || v.role === 'sub' || v.role === 'admin')
}

/** Unmounted host: the integrating page supplies its normal Tailwind stylesheet. */
export function V2Shell({ connectionOnly = false }: { connectionOnly?: boolean } = {}) {
  const [session, setSession] = useState<Session | null>(null)
  const [verification, setVerification] = useState<Verification>({ state: 'checking' })
  const [section, setSection] = useState<Section>('workflow')
  const [notice, setNotice] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const current = useRef<Session | null>(null)

  const discard = useCallback((message: string) => {
    generation.current++
    current.current = null
    setSession(null)
    setVerification({ state: 'checking' })
    setSection('workflow')
    setNotice(message)
  }, [])

  const authenticated = useCallback((login: Login) => {
    // V2Auth anchors this conservative deadline to request start, not receipt.
    const next = { token: login.token, expiresAt: login.expiresAt, generation: ++generation.current }
    current.current = next
    setNotice('')
    setSection('workflow')
    setVerification({ state: 'checking' })
    setSession(next)
  }, [])

  useEffect(() => {
    if (!session) return
    let stopped = false
    let inFlight: AbortController | null = null
    const valid = () => !stopped && current.current?.generation === session.generation
    const expire = () => { if (valid()) discard('Your session expired or was revoked. Please sign in again.') }
    const verify = async () => {
      if (!valid()) return
      if (Date.now() >= session.expiresAt) { expire(); return }
      if (inFlight) return
      const controller = new AbortController()
      inFlight = controller
      const timeout = window.setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await authRequest('/api/v2/auth/me', session.token, controller.signal, 'GET')
        if (!valid()) return
        if (Date.now() >= session.expiresAt || response.status === 401) { expire(); return }
        if (!response.ok) { setVerification({ state: 'unavailable' }); return }
        const identity: unknown = await response.json()
        if (!valid()) return
        if (Date.now() >= session.expiresAt) { expire(); return }
        if (!isIdentity(identity)) { setVerification({ state: 'unavailable' }); return }
        setVerification({ state: 'ready', identity })
      } catch {
        if (valid()) setVerification({ state: 'unavailable' })
      } finally {
        window.clearTimeout(timeout)
        if (inFlight === controller) inFlight = null
      }
    }
    setVerification({ state: 'checking' })
    void verify()
    const timer = window.setInterval(() => { void verify() }, CHECK_INTERVAL_MS)
    const expiry = window.setTimeout(expire, Math.max(0, session.expiresAt - Date.now()))
    const onFocus = () => { void verify() }
    const onVisibility = () => { if (document.visibilityState === 'visible') void verify() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stopped = true; inFlight?.abort(); window.clearInterval(timer); window.clearTimeout(expiry); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility) }
  }, [session, retry, discard])

  async function logout() {
    const previous = current.current
    if (!previous) return
    // Remove all local access immediately, before awaiting the network. A failed
    // revocation is reported honestly; no old response can affect a new session.
    discard('Signing out…')
    const afterDiscard = generation.current
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await authRequest('/api/v2/auth/logout', previous.token, controller.signal, 'POST')
      if (generation.current !== afterDiscard) return
      setNotice(response.status === 204 ? 'Signed out.' : response.status === 401 ? 'Session was already expired or revoked; signed out locally.' : 'Signed out locally, but server-side logout could not be confirmed. The session may remain active until it expires.')
    } catch {
      if (generation.current === afterDiscard) setNotice('Signed out locally, but server-side logout could not be confirmed. The session may remain active until it expires.')
    } finally { window.clearTimeout(timeout) }
  }

  if (!session) return <div className="v2-shell-auth">{notice && <p className="v2-shell-notice" role="status">{notice}</p>}<V2Auth onAuthenticated={authenticated} /></div>
  const identity = verification.state === 'ready' ? verification.identity : null
  const activeSection = connectionOnly ? 'workflow' : section
  return <div className="v2-shell">
    <header className="v2-shell-bar"><div><div className="v2-shell-brand">COI Shield <span>V2</span></div><p>Private account workspace</p></div><button type="button" onClick={logout}>Sign out</button></header>
    {verification.state === 'checking' && <p className="v2-shell-state" role="status">Checking your session…</p>}
    {verification.state === 'unavailable' && <div className="v2-shell-state" role="alert"><p>Session verification is unavailable. Your workspace is hidden until it can be checked.</p><button type="button" onClick={() => setRetry(n => n + 1)}>Retry session check</button></div>}
    {identity?.role === 'admin' && <div className="v2-shell-state" role="alert"><p>This workspace does not support administrator accounts. Sign out to use another account.</p></div>}
    {identity && identity.role !== 'admin' && <>
      <div className="v2-shell-context"><span>{identity.role === 'gc' ? 'General contractor' : 'Subcontractor'} account</span><p>{connectionOnly ? 'Connection-only mode: this interface does not upload or access files or insurance metadata, and does not verify insurance. Existing grants are not changed.' : 'Profile details and insurance information are self-reported and unverified.'}</p></div>
      <nav className="v2-shell-nav" aria-label="Workspace"><button type="button" aria-current={activeSection === 'workflow' ? 'page' : undefined} onClick={() => setSection('workflow')}>{identity.role === 'gc' || connectionOnly ? 'Connections' : 'Connections & metadata'}</button>{!connectionOnly && <button type="button" aria-current={activeSection === 'files' ? 'page' : undefined} onClick={() => setSection('files')}>{identity.role === 'gc' ? 'Shared files' : 'Private files'}</button>}</nav>
      {identity.role === 'gc' ? (activeSection === 'files' ? <GcGrantedFiles key={session.generation} authorizationToken={session.token} /> : <GcConnections key={session.generation} authorizationToken={session.token} connectionOnly={connectionOnly} />) : activeSection === 'files' ? <PrivateFiles key={session.generation} token={session.token} /> : <SubcontractorWorkflow key={session.generation} token={session.token} hideUnavailableFiles connectionOnly={connectionOnly} />}
    </>}
  </div>
}
export default V2Shell
