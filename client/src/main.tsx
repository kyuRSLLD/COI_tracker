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
import { SubcontractorModal } from './components/SubcontractorModal'
import { RequestCOIModal } from './components/RequestCOIModal'

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
    location.pathname === '/login'

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
