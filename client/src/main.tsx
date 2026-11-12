import React, { useState, useEffect, useCallback, useRef } from 'react'
import { flushSync } from 'react-dom'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams, Outlet } from 'react-router-dom'
import './index.css'
import { ApiError, apiMe, getToken, setToken, setStoredUser, setVerifiedToken, apiLogout, apiSubcontractors, SESSION_CHANGED_EVENT, SESSION_EXPIRED_EVENT } from './api'
import type { User, Subcontractor } from './types'
import { Navbar } from './components/Navbar'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { Dashboard } from './pages/Dashboard'
import { SubcontractorsPage } from './pages/SubcontractorsPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { EmailLogPage } from './pages/EmailLogPage'
import { SettingsPage } from './pages/SettingsPage'
import { ClientSharePage } from './pages/ClientSharePage'
import { UploadPortalPage } from './pages/UploadPortalPage'
import { AdminDashboardPage } from './pages/AdminDashboardPage'
import { SubcontractorDashboardPage } from './pages/SubcontractorDashboardPage'
import { JoinPage } from './pages/JoinPage'
import { SubcontractorModal } from './components/SubcontractorModal'
import { RequestCOIModal } from './components/RequestCOIModal'
import { ConnectionSession } from './components/ConnectionOptions'
import { ConnectSubPage, captureConnectionFragment } from './pages/ConnectSubPage'

function roleHome(u: User | null): string {
  if (!u) return '/login'
  if (u.role === 'admin') return '/staff'
  if (u.role === 'sub') return '/subcontractor'
  return '/dashboard'
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [sessionStatus, setSessionStatus] = useState<'checking' | 'authenticated' | 'anonymous' | 'error'>(() => getToken() ? 'checking' : 'anonymous')
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const sessionVersion = useRef(0)
  const observedToken = useRef(getToken())
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const location = useLocation()

  const refreshUser = useCallback(async () => {
    const version = ++sessionVersion.current
    const token = getToken()
    observedToken.current = token
    setVerifiedToken(null)
    setUser(null)
    setSessionToken(null)
    setSubs([])
    setAddSubOpen(false)
    setRequestOpen(false)
    setSessionError(null)
    if (!token) {
      setSessionStatus('anonymous')
      return
    }
    setSessionStatus('checking')
    try {
      const { user: currentUser } = await apiMe(token)
      if (sessionVersion.current !== version) return
      if (getToken() !== token) { void refreshUser(); return }
      setStoredUser(currentUser)
      flushSync(() => {
        setVerifiedToken(token)
        setSessionToken(token)
        setUser(currentUser)
        setSessionStatus('authenticated')
      })
    } catch (err) {
      if (sessionVersion.current !== version) return
      if (getToken() !== token) { void refreshUser(); return }
      setUser(null)
      if (err instanceof ApiError && err.status === 401) {
        apiLogout()
        observedToken.current = null
        setSessionStatus('anonymous')
        setSessionError('Your session has expired. Please sign in again.')
      } else {
        setSessionStatus('error')
        const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'Please try again.'
        setSessionError(`Could not verify your session: ${message}`)
      }
    }
  }, [])

  // The API response is authoritative; commit storage and React state before navigation.
  const establishSession = useCallback(async ({ token, user: nextUser }: { token: string; user: User }) => {
    ++sessionVersion.current
    setToken(token)
    observedToken.current = token
    setStoredUser(nextUser)
    flushSync(() => {
      setVerifiedToken(token)
      setSessionToken(token)
      setSubs([])
      setAddSubOpen(false)
      setRequestOpen(false)
      setUser(nextUser)
      setSessionStatus('authenticated')
      setSessionError(null)
    })
  }, [])

  const logout = useCallback(() => {
    if (getToken() !== observedToken.current) { void refreshUser(); return }
    ++sessionVersion.current
    setVerifiedToken(null)
    apiLogout()
    observedToken.current = null
    setUser(null)
    setSessionToken(null)
    setSessionStatus('anonymous')
    setSessionError(null)
    setSubs([])
    setAddSubOpen(false)
    setRequestOpen(false)
  }, [refreshUser])

  const expireSession = useCallback((token: string | null) => {
    if (!token || getToken() !== token) return
    ++sessionVersion.current
    setVerifiedToken(null)
    apiLogout()
    observedToken.current = null
    setUser(null)
    setSessionToken(null)
    setSubs([])
    setAddSubOpen(false)
    setRequestOpen(false)
    setSessionStatus('anonymous')
    setSessionError('Your session has expired. Please sign in again.')
  }, [])

  useEffect(() => {
    const storageChanged = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === 'coi_token' || event.key === null) && getToken() !== observedToken.current) void refreshUser()
    }
    const sessionChanged = () => {
      if (getToken() !== observedToken.current) void refreshUser()
    }
    const sessionExpired = (event: Event) => expireSession((event as CustomEvent<string>).detail)
    window.addEventListener('storage', storageChanged)
    window.addEventListener(SESSION_CHANGED_EVENT, sessionChanged)
    window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpired)
    void refreshUser()
    return () => {
      window.removeEventListener('storage', storageChanged)
      window.removeEventListener(SESSION_CHANGED_EVENT, sessionChanged)
      window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpired)
    }
  }, [refreshUser, expireSession])

  const loadSubs = useCallback((version: number, token: string) => {
    if (sessionVersion.current !== version || getToken() !== token) return
    apiSubcontractors.list().then((r) => {
      if (sessionVersion.current === version && getToken() === token) setSubs(r.subcontractors)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    if (sessionStatus === 'authenticated' && sessionToken && user && user.role !== 'sub') {
      loadSubs(sessionVersion.current, sessionToken)
    }
  }, [user, sessionStatus, sessionToken, loadSubs])

  const renderedVersion = sessionVersion.current

  const hideNavbar =
    location.pathname.startsWith('/share/') ||
    location.pathname.startsWith('/upload/') ||
    location.pathname.startsWith('/join/') ||
    location.pathname === '/connect-sub' ||
    location.pathname === '/login'

  return (
    <ConnectionSession.Provider value={{ role: sessionStatus === 'authenticated' ? user?.role ?? null : null, token: sessionStatus === 'authenticated' ? sessionToken : null }}>
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {!hideNavbar && (
        <Navbar
          user={user}
          onLogout={logout}
          onOpenAddSub={() => setAddSubOpen(true)}
          onOpenRequestCOI={() => setRequestOpen(true)}
        />
      )}
      {sessionError && (
        <div role="alert" className="bg-rose-50 border-b border-rose-200 p-3 text-sm text-rose-800 text-center">
          {sessionError}{' '}
          {sessionStatus === 'error' && <>
            <button type="button" className="underline font-semibold" onClick={() => void refreshUser()}>Retry</button>{' · '}
            <button type="button" className="underline font-semibold" onClick={logout}>Switch account</button>
          </>}
        </div>
      )}
      <main className="flex-1">
        <Routes>
          <Route
            path="/"
            element={user?.role === 'admin' ? <Navigate to="/staff" replace /> : <LandingPage onLogin={() => { void refreshUser() }} />}
          />
          <Route
            path="/login"
            element={sessionStatus === 'checking' ? <SessionChecking /> : sessionStatus === 'error' ? <SessionUnavailable /> : user ? <Navigate to={roleHome(user)} replace /> : <LoginPage getSessionVersion={() => sessionVersion.current} onLogin={(session, version) => {
              if (sessionVersion.current !== version) throw new Error('Your session changed. Please try signing in again.')
              return establishSession(session)
            }} />}
          />
          <Route path="/demo" element={<Navigate to="/login" replace />} />
          <Route element={sessionStatus === 'checking' ? <SessionChecking /> : sessionStatus === 'error' ? <SessionUnavailable /> : <Outlet />}>
          <Route
            path="/dashboard"
            element={
              user ? (
                user.role === 'sub' ? <Navigate to="/subcontractor" replace /> : <Dashboard />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/subcontractors"
            element={user && user.role !== 'sub' ? <SubcontractorsPage /> : <Navigate to={user ? roleHome(user) : '/login'} replace />}
          />
          <Route
            path="/projects"
            element={user && user.role !== 'sub' ? <ProjectsPage /> : <Navigate to={user ? roleHome(user) : '/login'} replace />}
          />
          <Route
            path="/emails"
            element={user && user.role !== 'sub' ? <EmailLogPage /> : <Navigate to={user ? roleHome(user) : '/login'} replace />}
          />
          <Route
            path="/settings"
            element={user ? <SettingsPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/subcontractor"
            element={user ? <SubcontractorDashboardPage /> : <Navigate to="/login" replace />}
          />
          <Route path="/sub" element={<Navigate to="/subcontractor" replace />} />
          <Route path="/sub/my" element={<Navigate to="/subcontractor" replace />} />
          <Route
            path="/staff"
            element={user && user.role === 'admin' ? <AdminDashboardPage /> : <Navigate to={user ? roleHome(user) : '/login'} replace />}
          />
          <Route path="/admin" element={<Navigate to="/staff" replace />} />
          </Route>
          <Route path="/join/:inviteCode" element={<JoinRoute user={user} sessionToken={sessionToken} sessionStatus={sessionStatus} onSession={establishSession} onSwitchAccount={logout} />} />
          <Route path="/connect-sub" element={<ConnectSubPage key={location.key} user={user} sessionToken={sessionToken} sessionStatus={sessionStatus} getSessionVersion={() => sessionVersion.current} onSession={async (session, version) => {
            if (sessionVersion.current !== version) throw new Error('Your session changed. Please try signing in again.')
            await establishSession(session)
          }} onSwitchAccount={logout} onSaved={() => { if (sessionToken) loadSubs(renderedVersion, sessionToken) }} />} />
          <Route path="/share/:token" element={<ClientSharePage />} />
          <Route path="/upload/:token" element={<UploadPortalPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {user && user.role !== 'sub' && (
        <>
          <SubcontractorModal
            open={addSubOpen}
            onClose={() => setAddSubOpen(false)}
            onSaved={() => { if (sessionToken) loadSubs(renderedVersion, sessionToken) }}
          />
          <RequestCOIModal
            subcontractors={subs}
            open={requestOpen}
            onClose={() => setRequestOpen(false)}
          />
        </>
      )}
    </div>
    </ConnectionSession.Provider>
  )
}

function JoinRoute(props: React.ComponentProps<typeof JoinPage>) {
  const { inviteCode } = useParams()
  // Remount synchronously so no information or consent survives a new target.
  return <JoinPage key={inviteCode} {...props} />
}

function SessionChecking() {
  return <div className="p-8 text-center text-sm text-slate-500">Checking your session…</div>
}

function SessionUnavailable() {
  return <div className="p-8 text-center text-sm text-slate-500">Your session could not be verified. Retry or switch account above.</div>
}

captureConnectionFragment()
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
