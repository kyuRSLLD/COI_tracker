import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, FileText, Building2, Users, DollarSign, Target, Mail, Settings, Menu, X, Shield, ArrowUpRight, LogOut } from 'lucide-react'
import type { User } from '../types'

interface Props {
  user: User | null
  onSignOut: () => void
  pendingQueueCount?: number
  children: React.ReactNode
}

interface Item {
  label: string
  to?: string
  hash?: string
  icon: any
  badge?: number | string
  badgeTone?: 'red' | 'gray'
  disabled?: boolean
}

export function StaffSidebar({ user, onSignOut, pendingQueueCount, children }: Props) {
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [more, setMore] = useState(false)

  const items: Item[] = [
    { label: 'Overview', to: '/admin', icon: LayoutDashboard },
    { label: 'COI queue', hash: 'validation-queue', icon: FileText, badge: pendingQueueCount, badgeTone: 'red' },
    { label: 'Companies', hash: 'companies', icon: Building2 },
    { label: 'Users', hash: 'users', icon: Users },
    { label: 'Revenue', hash: 'revenue', icon: DollarSign },
    { label: 'Leads (permits)', to: '/emails?type=coi_request', icon: Target, badge: 'soon', badgeTone: 'gray', disabled: true },
    { label: 'Email log', to: '/emails', icon: Mail },
    { label: 'Settings', to: '/settings', icon: Settings },
  ]

  const active = (it: Item) => {
    if (it.to) return location.pathname === it.to.split('?')[0] && !location.hash
    return false
  }

  const goHash = (hash?: string) => {
    if (!hash) return
    const el = document.getElementById(hash)
    if (el) el.scrollIntoView({ behavior: 'smooth' })
    setOpen(false)
    setMore(false)
  }

  return (
    <div className="min-h-screen bg-blueprint flex flex-col md:flex-row text-sm">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex md:w-56 shrink-0 flex-col justify-between p-4 sticky top-0 h-screen text-xs border-r border-[#1B3673]/60 select-none z-20"
        style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)' }}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <Link to="/admin" className="flex items-center gap-2 font-bold text-white text-sm tracking-tight">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#22C3A6' }} />
              SafeCOI
            </Link>
            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white">
              Staff
            </span>
          </div>
          <nav className="space-y-1">
            {items.map((it) => {
              const Icon = it.icon
              const isA = active(it)
              const content = (
                <span className="flex items-center justify-between w-full">
                  <span className="flex items-center gap-2">
                    <Icon className="w-3.5 h-3.5" />
                    <span>{it.label}</span>
                  </span>
                  {it.badge !== undefined && (
                    <span
                      className={`text-[10px] font-bold px-1.5 py-0.2 rounded-full ${
                        it.badgeTone === 'red' ? 'bg-rose-500 text-white' : 'bg-white/15 text-white/80'
                      }`}
                    >
                      {it.badge}
                    </span>
                  )}
                </span>
              )
              const cls = `w-full flex items-center justify-between px-2.5 py-2 rounded-md font-semibold transition text-left ${
                isA
                  ? 'shadow-sm'
                  : 'hover:bg-white/5 opacity-90 hover:opacity-100'
              }`
              const style = isA
                ? { background: 'var(--nav-active-bg)', color: 'var(--nav-active-text)' }
                : undefined
              if (it.disabled) {
                return (
                  <div key={it.label} className={cls + ' cursor-not-allowed opacity-40'} style={style}>
                    {content}
                  </div>
                )
              }
              if (it.hash) {
                return (
                  <button key={it.label} type="button" onClick={() => goHash(it.hash)} className={cls} style={style}>
                    {content}
                  </button>
                )
              }
              return (
                <Link key={it.label} to={it.to!} className={cls} style={style}>
                  {content}
                </Link>
              )
            })}
          </nav>
        </div>
        <div className="pt-3 border-t border-white/10 space-y-2 text-[11px]">
          <div className="truncate text-white/70" title={user?.email}>{user?.email}</div>
          <Link
            to="/dashboard"
            className="flex items-center gap-1.5 text-white/80 hover:text-white"
          >
            <Shield className="w-3 h-3" /> Contractor view <ArrowUpRight className="w-3 h-3 ml-auto" />
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex items-center gap-1.5 text-white/60 hover:text-white w-full text-left"
          >
            <LogOut className="w-3 h-3" /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top strip */}
      <header
        className="md:hidden flex items-center justify-between px-3 py-2.5 text-xs select-none sticky top-0 z-30"
        style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)' }}
      >
        <Link to="/admin" className="flex items-center gap-2 font-bold text-white tracking-tight">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#22C3A6' }} />
          SafeCOI
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-white">Staff</span>
        </Link>
        <div className="flex items-center gap-2">
          {pendingQueueCount ? (
            <button
              type="button"
              onClick={() => goHash('validation-queue')}
              className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-rose-500 text-white"
              title="COIs waiting for validation"
            >
              {pendingQueueCount} waiting
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle staff menu"
            className="p-1 rounded hover:bg-white/10"
          >
            {open ? <X className="w-4 h-4 text-white" /> : <Menu className="w-4 h-4 text-white" />}
          </button>
        </div>
      </header>

      {/* Mobile fly-out drawer */}
      {open && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/50" onClick={() => setOpen(false)}>
          <div
            className="absolute left-0 top-0 bottom-0 w-64 p-4 text-xs space-y-4"
            style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <span className="font-bold text-white">Staff menu</span>
              <button onClick={() => setOpen(false)} aria-label="Close menu"><X className="w-4 h-4 text-white" /></button>
            </div>
            <nav className="space-y-1">
              {items.map((it) => {
                const Icon = it.icon
                const content = (
                  <span className="flex items-center justify-between w-full">
                    <span className="flex items-center gap-2"><Icon className="w-3.5 h-3.5" />{it.label}</span>
                    {it.badge !== undefined && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded-full ${it.badgeTone === 'red' ? 'bg-rose-500 text-white' : 'bg-white/15 text-white/80'}`}>{it.badge}</span>
                    )}
                  </span>
                )
                if (it.disabled) return <div key={it.label} className="px-2.5 py-2 text-white/30 cursor-not-allowed">{content}</div>
                if (it.hash) return <button key={it.label} type="button" onClick={() => goHash(it.hash)} className="w-full px-2.5 py-2 rounded-md font-semibold hover:bg-white/5 text-left">{content}</button>
                return <Link key={it.label} to={it.to!} onClick={() => setOpen(false)} className="px-2.5 py-2 rounded-md font-semibold hover:bg-white/5 block">{content}</Link>
              })}
            </nav>
            <div className="pt-3 border-t border-white/10 text-[11px] space-y-2">
              <div className="truncate text-white/70">{user?.email}</div>
              <Link to="/dashboard" onClick={() => setOpen(false)} className="flex items-center gap-1.5 text-white/80"><Shield className="w-3 h-3" /> Contractor view</Link>
              <button type="button" onClick={onSignOut} className="flex items-center gap-1.5 text-white/60 w-full text-left"><LogOut className="w-3 h-3" /> Sign out</button>
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 min-w-0 p-4 sm:p-6 pb-20 md:pb-8">{children}</main>

      {/* Mobile bottom tab bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around py-1.5 text-[10px] font-semibold select-none border-t border-white/10"
        style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)' }}
      >
        <Link to="/admin" className="flex flex-col items-center gap-0.5 px-2 py-1"><LayoutDashboard className="w-4 h-4" />Overview</Link>
        <button type="button" onClick={() => goHash('validation-queue')} className="flex flex-col items-center gap-0.5 px-2 py-1 relative">
          <FileText className="w-4 h-4" />Queue
          {pendingQueueCount ? <span className="absolute -top-1 right-2 text-[9px] font-bold px-1 rounded-full bg-rose-500 text-white">{pendingQueueCount}</span> : null}
        </button>
        <button type="button" onClick={() => goHash('companies')} className="flex flex-col items-center gap-0.5 px-2 py-1"><Building2 className="w-4 h-4" />Companies</button>
        <button type="button" onClick={() => goHash('users')} className="flex flex-col items-center gap-0.5 px-2 py-1"><Users className="w-4 h-4" />Users</button>
        <button type="button" onClick={() => setMore((v) => !v)} className="flex flex-col items-center gap-0.5 px-2 py-1"><Menu className="w-4 h-4" />More</button>
      </nav>

      {/* "More" bottom sheet */}
      {more && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/50 flex flex-col justify-end" onClick={() => setMore(false)}>
          <div
            className="p-4 text-xs space-y-3 rounded-t-2xl max-h-[70vh] overflow-y-auto"
            style={{ background: 'var(--nav-bg)', color: 'var(--nav-text)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/10 font-bold text-white">
              <span>All sections</span>
              <button onClick={() => setMore(false)} aria-label="Close"><X className="w-4 h-4 text-white" /></button>
            </div>
            {items.map((it) => {
              const Icon = it.icon
              const content = <span className="flex items-center gap-2"><Icon className="w-3.5 h-3.5" />{it.label}</span>
              if (it.disabled) return <div key={it.label} className="py-1 text-white/30 cursor-not-allowed">{content}</div>
              if (it.hash) return <button key={it.label} type="button" onClick={() => goHash(it.hash)} className="py-1 font-semibold hover:text-white w-full text-left">{content}</button>
              return <Link key={it.label} to={it.to!} onClick={() => setMore(false)} className="py-1 font-semibold hover:text-white block">{content}</Link>
            })}
          </div>
        </div>
      )}
    </div>
  )
}
