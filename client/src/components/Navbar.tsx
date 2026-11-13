import { Link, useLocation } from 'react-router-dom'
import {
  ShieldCheck, Users, FolderKanban, Mail, Settings, Plus, FileText, LogOut, Crown,
} from 'lucide-react'
import type { User } from '../types'

interface Props {
  user: User | null
  onLogout: () => void
  onOpenAddSub?: () => void
  onOpenRequestCOI?: () => void
}

export function Navbar({ user, onLogout, onOpenAddSub, onOpenRequestCOI }: Props) {
  const loc = useLocation()

  const nav = (() => {
    if (user?.role === 'sub') {
      return [
        { to: '/subcontractor', label: 'My COIs', icon: ShieldCheck },
        { to: '/settings', label: 'Profile', icon: Settings },
      ]
    }
    const items = [
      { to: '/dashboard', label: 'Dashboard', icon: ShieldCheck },
      { to: '/subcontractors', label: 'Subcontractors', icon: Users },
      { to: '/projects', label: 'Projects', icon: FolderKanban },
      { to: '/emails', label: 'Emails', icon: Mail },
      { to: '/settings', label: 'Profile', icon: Settings },
    ]
    if (user?.role === 'admin') items.push({ to: '/staff', label: 'Staff', icon: Crown })
    return items
  })()

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-3">
        <div className="flex items-center gap-8 min-w-0">
          <Link to="/" className="flex items-center gap-2 group whitespace-nowrap">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-extrabold text-sm shadow-sm group-hover:bg-slate-800 transition">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="font-bold text-slate-900 tracking-tight text-base">COI Shield</span>
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
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition whitespace-nowrap ${
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
              {user.role !== 'sub' && onOpenAddSub && (
                <button
                  onClick={onOpenAddSub}
                  title="Add subcontractor"
                  aria-label="Add subcontractor"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-100 transition whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" /> <span className="hidden sm:inline">+ Sub</span>
                </button>
              )}
              {user.role !== 'sub' && onOpenRequestCOI && (
                <button
                  onClick={onOpenRequestCOI}
                  title="Request certificate of insurance"
                  aria-label="Request certificate of insurance"
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm whitespace-nowrap"
                >
                  <FileText className="w-4 h-4" /> <span>Request</span>
                </button>
              )}
              <div className="hidden md:flex flex-col text-right text-xs leading-tight ml-2">
                <span className="font-semibold text-slate-800">{user.company_name || user.name}</span>
                <span className="text-slate-400">{user.email}</span>
              </div>
              <button
                onClick={onLogout}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-slate-500 hover:text-red-600 rounded-xl hover:bg-red-50 transition ml-1"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 transition shadow-sm whitespace-nowrap"
            >
              Sign In
            </Link>
          )}
        </div>
      </div>
      {/* mobile bottom bar */}
      {user && (
        <div className="lg:hidden flex items-center justify-around border-t border-slate-200 py-1 bg-white text-xs">
          {nav.map((item) => {
            const Icon = item.icon
            const active = loc.pathname === item.to
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex flex-col items-center gap-0.5 py-1 px-2 ${
                  active ? 'text-brand-700 font-semibold' : 'text-slate-500'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{item.label === 'Subcontractors' ? <><span className="sm:hidden">Subs</span><span className="hidden sm:inline">Subcontractors</span></> : item.label}</span>
              </Link>
            )
          })}
        </div>
      )}
    </header>
  )
}
