import { Link, useLocation } from 'react-router-dom'
import { ShieldCheck, LogOut, FileText, Users, FolderKanban, Mail, Settings, Plus, Sparkles, Crown } from 'lucide-react'
import type { User } from '../types'
import { apiLogout } from '../api'

interface Props {
  user: User | null
  onLogout: () => void
  onOpenAddSub?: () => void
  onOpenRequestCOI?: () => void
}

export function Navbar({ user, onLogout, onOpenAddSub, onOpenRequestCOI }: Props) {
  const loc = useLocation()
  const nav = [
    { to: '/dashboard', label: 'Dashboard', icon: ShieldCheck },
    { to: '/subcontractors', label: 'Subcontractors', icon: Users },
    { to: '/projects', label: 'Projects & Sharing', icon: FolderKanban },
    { to: '/emails', label: 'Email Log', icon: Mail },
    { to: '/settings', label: 'Settings', icon: Settings },
  ]
  if (user?.role === 'admin') nav.push({ to: '/admin', label: 'Admin', icon: Crown })

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-3">
        <div className="flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-brand-600 text-white flex items-center justify-center font-extrabold text-base shadow-sm group-hover:bg-brand-700 transition">
              🛡
            </div>
            <div className="leading-tight">
              <span className="font-extrabold text-slate-900 tracking-tight text-base">COI Shield</span>
              <span className="hidden sm:inline text-xs text-slate-400 block -mt-0.5">Insurance compliance, automatic</span>
            </div>
          </Link>
          {user && (
            <nav className="hidden lg:flex items-center gap-1 text-sm font-medium">
              {nav.map((item) => {
                const Icon = item.icon
                const active = loc.pathname === item.to
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition ${
                      active
                        ? 'text-brand-700 bg-brand-50 font-semibold'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          )}
        </div>

        <div className="flex items-center gap-2">
          {user ? (
            <>
              {onOpenAddSub && (
                <button
                  onClick={onOpenAddSub}
                  className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 border border-slate-300 hover:bg-slate-100 transition"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Sub
                </button>
              )}
              {onOpenRequestCOI && (
                <button
                  onClick={onOpenRequestCOI}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
                >
                  <FileText className="w-3.5 h-3.5" /> Request COI
                </button>
              )}
              <div className="hidden md:flex flex-col text-right text-xs leading-tight ml-2">
                <span className="font-semibold text-slate-800">{user.company_name || user.name}</span>
                <span className="text-slate-400">{user.email}</span>
              </div>
              <button
                onClick={() => {
                  apiLogout()
                  onLogout()
                }}
                title="Sign out"
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <Link
                to="/demo"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 transition"
              >
                <Sparkles className="w-3.5 h-3.5" /> Live Demo
              </Link>
              <Link
                to="/login"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
              >
                Sign In
              </Link>
            </>
          )}
        </div>
      </div>
      {/* Mobile nav */}
      {user && (
        <div className="lg:hidden flex items-center justify-around border-t border-slate-200 text-xs py-2 bg-slate-50 overflow-x-auto">
          {nav.map((item) => {
            const Icon = item.icon
            const active = loc.pathname === item.to
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded ${
                  active ? 'text-brand-700 font-bold' : 'text-slate-500'
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            )
          })}
        </div>
      )}
    </header>
  )
}
