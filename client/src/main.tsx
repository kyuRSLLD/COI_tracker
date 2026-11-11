import React, { useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import './index.css'
import { apiMe, getStoredUser, apiLogout, apiSubcontractors } from './api'
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
import { StagedInvitePage } from './pages/StagedInvitePage'
import { stagedInvitesEnabled, isInviteToken, pendingInviteKey } from './lib/stagedInvites'
import { SubcontractorModal } from './components/SubcontractorModal'
import { RequestCOIModal } from './components/RequestCOIModal'

// The HTML entry point strips the fragment before loading subresources. Keep it only
// in memory unless login requires a sessionStorage handoff.
let capturedFragment = (window as Window & { __stagedFragment?: string }).__stagedFragment
delete (window as Window & { __stagedFragment?: string }).__stagedFragment
let initialInviteToken = stagedInvitesEnabled && location.pathname === '/invite-sub' && isInviteToken(capturedFragment) ? capturedFragment : null
if (location.pathname === '/invite-sub' && (!stagedInvitesEnabled || capturedFragment)) sessionStorage.removeItem(pendingInviteKey)
capturedFragment = undefined

function roleHome(u: User | null): string {
  if (!u) return '/login'
  if (u.role === 'admin') return '/staff'
  if (u.role === 'sub') return '/subcontractor'
  return '/dashboard'
}

function App() {
  const [user, setUser] = useState<User | null>(getStoredUser())
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const location = useLocation()

  const refreshUser = useCallback(() => {
    apiMe()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
  }, [])

  useEffect(() => {
    refreshUser()
  }, [refreshUser])

  useEffect(() => {
    if (user && user.role !== 'sub') {
      apiSubcontractors.list().then((r) => setSubs(r.subcontractors)).catch(() => {})
    }
  }, [user])

  const hideNavbar =
    location.pathname.startsWith('/share/') ||
    location.pathname.startsWith('/upload/') ||
    location.pathname.startsWith('/join/') ||
    location.pathname === '/login' ||
    location.pathname === '/invite-sub' ||
    location.pathname === '/connect-sub'

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {!hideNavbar && (
        <Navbar
          user={user}
          onLogout={() => { apiLogout(); setUser(null) }}
          onOpenAddSub={() => setAddSubOpen(true)}
          onOpenRequestCOI={() => setRequestOpen(true)}
        />
      )}
      <main className="flex-1">
        <Routes>
          <Route
            path="/"
            element={user?.role === 'admin' ? <Navigate to="/staff" replace /> : <LandingPage onLogin={refreshUser} />}
          />
          <Route
            path="/login"
            element={user ? <Navigate to={roleHome(user)} replace /> : <LoginPage onLogin={refreshUser} />}
          />
          <Route path="/demo" element={<Navigate to="/login" replace />} />
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
          <Route path="/invite-sub" element={stagedInvitesEnabled ? <StagedInvitePage initialToken={initialInviteToken} onSignedIn={setUser} onConsumed={() => { initialInviteToken = null }} /> : <Navigate to="/" replace />} />
          <Route path="/connect-sub" element={stagedInvitesEnabled ? <div className="p-8 text-sm">Development preview — requests are not yet connected to the live subcontractor dashboard or COIs. Scan this code from the general contractor's Add subcontractor dialog. This is not a live connection.</div> : <Navigate to="/" replace />} />
          <Route path="/join/:inviteCode" element={<JoinPage />} />
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
            onSaved={() => apiSubcontractors.list().then((r) => setSubs(r.subcontractors))}
          />
          <RequestCOIModal
            subcontractors={subs}
            open={requestOpen}
            onClose={() => setRequestOpen(false)}
          />
        </>
      )}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
