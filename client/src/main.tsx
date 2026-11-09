import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import './index.css'
import type { User, Subcontractor } from './types'
import { apiMe, getStoredUser, apiLogout, apiSubcontractors } from './api'
import { Navbar } from './components/Navbar'
import { LandingPage } from './pages/LandingPage'
import { Dashboard } from './pages/Dashboard'
import { SubcontractorsPage } from './pages/SubcontractorsPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { ClientSharePage } from './pages/ClientSharePage'
import { UploadPortalPage } from './pages/UploadPortalPage'
import { EmailLogPage } from './pages/EmailLogPage'
import { SettingsPage } from './pages/SettingsPage'
import { AdminDashboardPage } from './pages/AdminDashboardPage'
import { LoginPage } from './pages/LoginPage'
import { DemoLaunchPage } from './pages/DemoLaunchPage'
import { SubcontractorModal } from './components/SubcontractorModal'
import { RequestCOIModal } from './components/RequestCOIModal'

function App() {
  const [user, setUser] = useState<User | null>(getStoredUser)
  const [authChecked, setAuthChecked] = useState(false)
  const [addSubOpen, setAddSubOpen] = useState(false)
  const [requestOpen, setRequestOpen] = useState(false)
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const location = useLocation()

  useEffect(() => {
    apiMe()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true))
  }, [])

  useEffect(() => {
    if (user) {
      apiSubcontractors.list().then((r) => setSubs(r.subcontractors)).catch(() => {})
    }
  }, [user, addSubOpen, requestOpen])

  const refreshUser = () => {
    apiMe().then((r) => setUser(r.user)).catch(() => setUser(getStoredUser()))
  }

  // Public portals render without navbar
  const isPublicPortal =
    location.pathname.startsWith('/share/') || location.pathname.startsWith('/upload/')

  if (!authChecked) {
    return <div className="py-20 text-center text-xs text-slate-400">Loading…</div>
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-['Plus_Jakarta_Sans',sans-serif]">
      {!isPublicPortal && (
        <Navbar
          user={user}
          onLogout={() => { apiLogout(); setUser(null) }}
          onOpenAddSub={() => setAddSubOpen(true)}
          onOpenRequestCOI={() => setRequestOpen(true)}
        />
      )}

      <main className="flex-1">
        <Routes>
          <Route path="/" element={<LandingPage onLogin={refreshUser} />} />
          <Route path="/login" element={<LoginPage onLogin={refreshUser} />} />
          <Route path="/demo" element={<DemoLaunchPage onLogin={refreshUser} />} />
          <Route
            path="/dashboard"
            element={user ? <Dashboard /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/subcontractors"
            element={user ? <SubcontractorsPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/projects"
            element={user ? <ProjectsPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/emails"
            element={user ? <EmailLogPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/settings"
            element={user ? <SettingsPage /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/admin"
            element={user && user.role === 'admin' ? <AdminDashboardPage /> : <Navigate to={user ? '/dashboard' : '/login'} replace />}
          />
          <Route path="/share/:token" element={<ClientSharePage />} />
          <Route path="/upload/:token" element={<UploadPortalPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {user && (
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
