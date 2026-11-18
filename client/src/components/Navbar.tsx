import { Link, useLocation } from 'react-router-dom'
import {
  ShieldCheck, Users, FolderKanban, Settings, Plus, Upload, LogOut, Crown,
} from 'lucide-react'
import type { User } from '../types'

interface Props {
  user: User | null
  onLogout: () => void
  onOpenAddSub?: () => void
  onOpenUploadCOI?: () => void
}

const MARKETING_PATHS = new Set([
  '/',
  '/solutions/subcontractor-coi-tracking',
  '/industries/remodeling-contractor-compliance',
  '/features/acord-25-endorsement-verification',
  '/tools/insurance-clause-generator',
])

export function Navbar({ user, onLogout, onOpenAddSub, onOpenUploadCOI }: Props) {
  const loc = useLocation()
  const isMarketing = MARKETING_PATHS.has(loc.pathname)

  const publicNav: Array<
    { label: string; to: string } | { label: string; href: string }
  > = [
    { href: '/#how-it-works', label: 'How it works' },
    { to: '/solutions/subcontractor-coi-tracking', label: 'Sub tracking' },
    { to: '/industries/remodeling-contractor-compliance', label: 'Remodeling' },
    { to: '/features/acord-25-endorsement-verification', label: 'ACORD & endorsements' },
    { href: '/#pricing', label: 'Pricing' },
    { to: '/tools/insurance-clause-generator', label: 'Clause generator' },
  ]

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
      { to: '/settings', label: 'Profile', icon: Settings },
    ]
    if (user?.role === 'admin') items.push({ to: '/staff', label: 'Staff', icon: Crown })
    return items
  })()

  const appHome =
    user?.role === 'admin'
      ? '/staff'
      : user?.role === 'sub'
      ? '/subcontractor'
      : '/dashboard'

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16 gap-3">
        <div className="flex items-center gap-8 min-w-0">
          <Link to="/" className="flex items-center gap-2 group whitespace-nowrap">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-extrabold text-sm shadow-sm group-hover:bg-slate-800 transition">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="font-bold text-slate-900 tracking-tight text-base">SafeCOI</span>
          </Link>
          {isMarketing ? (
            <nav className="hidden md:flex items-center gap-1 text-xs sm:text-sm font-medium">
              {publicNav.map((item) => {
                const active = 'to' in item && loc.pathname === item.to
                const cls = `px-3 py-1.5 rounded-lg transition whitespace-nowrap ${
                  active
                    ? 'text-brand-700 bg-brand-50 font-semibold'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`
                return 'href' in item ? (
                  <a key={item.label} href={item.href} className={cls}>
                    {item.label}
                  </a>
                ) : (
                  <Link key={item.to} to={item.to} className={cls}>
                    {item.label}
                  </Link>
                )
              })}
            </nav>
          ) : (
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
          {isMarketing ? (
            user ? (
              <>
                <Link
                  to={appHome}
                  className="inline-flex items-center px-4 py-2 rounded-xl text-xs sm:text-sm font-bold text-white bg-slate-900 hover:bg-slate-800 transition shadow-sm whitespace-nowrap"
                >
                  Dashboard
                </Link>
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
              <>
                <Link
                  to="/login"
                  className="px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold text-slate-700 hover:text-slate-900 transition whitespace-nowrap"
                >
                  Log in
                </Link>
                <Link
                  to="/login?mode=register"
                  className="inline-flex items-center px-4 py-2 rounded-xl text-xs sm:text-sm font-bold text-white bg-slate-900 hover:bg-slate-800 transition shadow-sm whitespace-nowrap"
                >
                  Sign up free
                </Link>
              </>
            )
          ) : user ? (
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
              {user.role !== 'sub' && onOpenUploadCOI && (
                <button
                  onClick={onOpenUploadCOI}
                  title="Upload certificate of insurance"
                  aria-label="Upload certificate of insurance"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 rounded-xl text-sm font-semibold text-slate-700 border border-slate-300 hover:bg-slate-100 transition whitespace-nowrap"
                >
                  <Upload className="w-4 h-4" /> <span className="hidden sm:inline">Upload</span>
                </button>
              )}
              <div className="hidden md:flex flex-col text-right text-xs leading-tight ml-2">
                <span className="font-semibold text-slate-800">{user.company_name || user.name}</span>
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
      {/* mobile bottom bar — app pages only, never on marketing pages */}
      {!isMarketing && user && (
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
