import { useEffect, useState, useMemo } from 'react'
import { apiAdmin } from '../api'
import type { AdminOverview, AdminCompany, AdminUser } from '../types'
import { Users, DollarSign, Building, FileCheck, FolderKanban, Shield, RefreshCw, Search, ArrowUpRight, Crown, Sparkles, TrendingUp } from 'lucide-react'

const PLAN_COLORS: Record<string, string> = {
  'Free Demo': 'bg-slate-100 text-slate-700 border-slate-200',
  Starter: 'bg-sky-100 text-sky-800 border-sky-200',
  Professional: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  Enterprise: 'bg-purple-100 text-purple-800 border-purple-200',
}

export function AdminDashboardPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'gc'>('all')
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())

  const load = async () => {
    try {
      setLoading(true)
      setError(null)
      const [ov, comps, usrs] = await Promise.all([
        apiAdmin.overview(),
        apiAdmin.companies(),
        apiAdmin.users(),
      ])
      setOverview(ov)
      setCompanies(comps.companies)
      setUsers(usrs.users)
      setLastRefreshed(new Date())
    } catch (err: any) {
      setError(err?.message || 'Failed to load admin data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const flash = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3500)
  }

  const handlePlanChange = async (companyId: string, plan: string) => {
    try {
      setSavingPlanId(companyId)
      const res = await apiAdmin.updatePlan(companyId, plan)
      setCompanies((prev) => prev.map((c) => (c.id === companyId ? { ...c, plan: res.company.plan, mrr: res.company.mrr } : c)))
      flash('Plan updated')
      const ov = await apiAdmin.overview()
      setOverview(ov)
    } catch (err: any) {
      flash(err?.message || 'Update failed')
    } finally {
      setSavingPlanId(null)
    }
  }

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      setSavingRoleId(userId)
      const res = await apiAdmin.updateRole(userId, role)
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: res.user.role } : u)))
      flash('Role updated')
      const ov = await apiAdmin.overview()
      setOverview(ov)
    } catch (err: any) {
      flash(err?.message || 'Update failed')
    } finally {
      setSavingRoleId(null)
    }
  }

  const filteredCompanies = useMemo(() => {
    const q = companySearch.toLowerCase().trim()
    if (!q) return companies
    return companies.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.owner_name || '').toLowerCase().includes(q) || (c.owner_email || '').toLowerCase().includes(q)
    )
  }, [companies, companySearch])

  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase().trim()
    return users.filter((u) => {
      if (roleFilter !== 'all' && (roleFilter === 'admin' ? u.role !== 'admin' : u.role === 'admin')) return false
      if (!q) return true
      return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || (u.company_name || '').toLowerCase().includes(q)
    })
  }, [users, userSearch, roleFilter])

  const maxGrowth = Math.max(1, ...(overview?.growth?.map((g) => g.new_users) || [1]))

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-purple-100 text-purple-900 border border-purple-200">
            <Crown className="w-3.5 h-3.5" /> Staff Portal
          </div>
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight mt-2">Staff Command Center</h1>
          <p className="text-sm text-slate-500">Live view of users, revenue, companies and platform activity.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">Refreshed {lastRefreshed.toLocaleTimeString()}</span>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 transition shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-medium">
          {statusMsg}
        </div>
      )}

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>
      )}

      {/* KPI row — trust-counter cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>MRR</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">${(overview?.revenue?.mrr || 0).toLocaleString()}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">${(overview?.revenue?.arr || 0).toLocaleString()} / yr ARR</div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Paying subs</span>
            <ArrowUpRight className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">{overview?.revenue?.paying_subscribers ?? 0}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">of {overview?.platform?.companies ?? 0} companies</div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>ARPU</span>
            <Sparkles className="w-4 h-4 text-brand-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">${overview?.revenue?.arpu ?? 0}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">avg revenue per sub</div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total Users</span>
            <Users className="w-4 h-4 text-brand-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">{overview?.users?.total ?? 0}</div>
          <div className="text-[11px] text-emerald-600 mt-0.5">+{overview?.users?.new_this_month ?? 0} this month</div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>COIs on file</span>
            <FileCheck className="w-4 h-4 text-brand-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">{overview?.platform?.cois ?? 0}</div>
          <div className="text-[11px] text-amber-600 mt-0.5">{overview?.platform?.pending_reviews ?? 0} pending review</div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Subs tracked</span>
            <Shield className="w-4 h-4 text-brand-600" />
          </div>
          <div className="text-2xl font-extrabold text-slate-900 mt-2">{overview?.platform?.subcontractors ?? 0}</div>
          <div className="text-[11px] text-slate-400 mt-0.5">{overview?.platform?.client_share_links ?? 0} client share links</div>
        </div>
      </div>

      {/* Revenue analytics section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-slate-900">Revenue by subscription plan</h2>
              <p className="text-xs text-slate-400">MRR computed from assigned plans · live Stripe sync coming next</p>
            </div>
            <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
              {overview?.revenue?.available_plans?.length ?? 4} plans available
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            {(overview?.revenue?.plan_breakdown || []).map((p) => {
              const price = overview?.revenue?.available_plans?.find((a) => a.plan === p.plan)?.price ?? 0
              return (
                <div key={p.plan} className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                  <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${PLAN_COLORS[p.plan] || 'bg-slate-100'}`}>
                    {p.plan}
                  </span>
                  <div className="text-2xl font-extrabold text-slate-900 mt-2">{p.count}</div>
                  <div className="text-xs text-slate-400">companies</div>
                  <div className="text-xs font-semibold text-emerald-700 mt-2">
                    ${p.mrr.toLocaleString()} / mo <span className="text-[10px] text-slate-400">(${price}/mo ea)</span>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="text-[11px] text-slate-400 bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-900">
            <strong>Demo MRR engine:</strong> change any company's plan in the table below to see revenue recalculate live. Once Stripe is connected, subscriptions and payments will sync automatically here.
          </div>
        </div>

        {/* 6-month growth */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-emerald-600" /> New users (6 mo)
            </h2>
          </div>
          <div className="space-y-2">
            {(overview?.growth || []).map((g) => (
              <div key={g.month} className="space-y-1">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>{g.month}</span>
                  <span className="font-semibold text-slate-700">+{g.new_users}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all duration-500"
                    style={{ width: `${Math.round((g.new_users / maxGrowth) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(overview?.growth || []).length === 0 && (
              <div className="text-xs text-slate-400 text-center py-6">No historical data yet</div>
            )}
          </div>
        </div>
      </div>

      {/* Companies table with live plan switcher */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
              <Building className="w-4 h-4 text-brand-600" /> Companies & plans ({filteredCompanies.length})
            </h2>
            <p className="text-xs text-slate-400">Change any company's plan to update MRR instantly</p>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search companies…"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 w-56"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 text-left">
                <th className="py-2 px-3 font-semibold">Company</th>
                <th className="py-2 px-3 font-semibold">Owner</th>
                <th className="py-2 px-3 font-semibold">Plan (click to change)</th>
                <th className="py-2 px-3 font-semibold text-right">MRR</th>
                <th className="py-2 px-3 font-semibold text-right">Subs</th>
                <th className="py-2 px-3 font-semibold text-right">Projects</th>
                <th className="py-2 px-3 font-semibold text-right">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredCompanies.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="py-3 px-3 font-semibold text-slate-900">{c.name}</td>
                  <td className="py-3 px-3">
                    <div className="font-medium text-slate-700">{c.owner_name || '—'}</div>
                    <div className="text-[11px] text-slate-400">{c.owner_email || '—'}</div>
                  </td>
                  <td className="py-3 px-3">
                    <select
                      value={c.plan}
                      disabled={savingPlanId === c.id}
                      onChange={(e) => handlePlanChange(c.id, e.target.value)}
                      className={`text-xs font-semibold px-2 py-1 rounded-full border focus:outline-none focus:ring-2 focus:ring-brand-500 ${PLAN_COLORS[c.plan] || 'bg-slate-100'}`}
                    >
                      <option value="Free Demo">Free Demo · $0</option>
                      <option value="Starter">Starter · $49</option>
                      <option value="Professional">Professional · $149</option>
                      <option value="Enterprise">Enterprise · $499</option>
                    </select>
                  </td>
                  <td className="py-3 px-3 text-right font-bold text-emerald-700">${(c.mrr || 0).toLocaleString()}</td>
                  <td className="py-3 px-3 text-right text-slate-600">{c.subcontractor_count}</td>
                  <td className="py-3 px-3 text-right text-slate-600">{c.project_count}</td>
                  <td className="py-3 px-3 text-right text-slate-400">{c.created_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Users table */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-brand-600" /> Users ({filteredUsers.length})
            </h2>
            <p className="text-xs text-slate-400">All registered accounts with role management</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-200 p-0.5 text-xs bg-slate-50">
              {(['all', 'admin', 'gc'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRoleFilter(r)}
                  className={`px-2.5 py-1 rounded-md font-semibold transition ${roleFilter === r ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
                >
                  {r === 'all' ? 'All' : r === 'admin' ? 'Admins' : 'GCs'}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder="Search users…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="pl-9 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 w-48"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 text-left">
                <th className="py-2 px-3 font-semibold">User</th>
                <th className="py-2 px-3 font-semibold">Company</th>
                <th className="py-2 px-3 font-semibold">Role</th>
                <th className="py-2 px-3 font-semibold text-right">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-3 px-3">
                    <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                      {u.name}
                      {u.role === 'admin' && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-900">
                          <Crown className="w-3 h-3" /> Admin
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400">{u.email}</div>
                  </td>
                  <td className="py-3 px-3 text-slate-600">{u.company_name || '—'}</td>
                  <td className="py-3 px-3">
                    <select
                      value={u.role}
                      disabled={savingRoleId === u.id}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="text-xs font-semibold px-2 py-1 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
                    >
                      <option value="gc">GC</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="py-3 px-3 text-right text-slate-400">{u.created_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
