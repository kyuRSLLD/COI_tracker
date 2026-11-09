import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { apiAdmin } from '../api'
import type { AdminOverview, AdminCompany, AdminUser } from '../types'
import { RefreshCw, Search } from 'lucide-react'

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
      setError(err?.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const flash = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3000)
  }

  const handlePlanChange = async (companyId: string, plan: string) => {
    try {
      setSavingPlanId(companyId)
      const res = await apiAdmin.updatePlan(companyId, plan)
      setCompanies((prev) =>
        prev.map((c) => (c.id === companyId ? { ...c, plan: res.company.plan, mrr: res.company.mrr } : c))
      )
      flash('Plan saved')
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
      flash('Role saved')
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
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.owner_name || '').toLowerCase().includes(q) ||
        (c.owner_email || '').toLowerCase().includes(q)
    )
  }, [companies, companySearch])

  const filteredUsers = useMemo(() => {
    const q = userSearch.toLowerCase().trim()
    return users.filter((u) => {
      if (roleFilter !== 'all' && (roleFilter === 'admin' ? u.role !== 'admin' : u.role === 'admin'))
        return false
      if (!q) return true
      return (
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.company_name || '').toLowerCase().includes(q)
      )
    })
  }, [users, userSearch, roleFilter])

  const maxGrowth = Math.max(1, ...(overview?.growth?.map((g) => g.new_users) || [1]))

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Staff</h1>
          <p className="text-xs text-slate-500">Platform command center · live data</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400 font-mono text-[11px]">{lastRefreshed.toLocaleTimeString()}</span>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <Link
            to="/dashboard"
            className="px-3 py-1.5 rounded-md text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 transition"
          >
            Contractor view →
          </Link>
        </div>
      </div>

      {statusMsg && (
        <div className="px-3 py-1.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-mono">
          {statusMsg}
        </div>
      )}
      {error && (
        <div className="px-3 py-1.5 rounded-md bg-rose-50 border border-rose-200 text-rose-800 text-xs font-mono">
          {error}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">Users</div>
          <div className="text-xl font-bold text-slate-900 mt-1">{overview?.users?.total ?? '—'}</div>
          <div className="text-[11px] text-emerald-700 font-mono mt-0.5">+{overview?.users?.new_this_month ?? 0} this month</div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">MRR</div>
          <div className="text-xl font-bold text-slate-900 mt-1">${(overview?.revenue?.mrr || 0).toLocaleString()}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">${(overview?.revenue?.arr || 0).toLocaleString()} ARR</div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">Paying</div>
          <div className="text-xl font-bold text-slate-900 mt-1">{overview?.revenue?.paying_subscribers ?? '—'}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">of {overview?.platform?.companies ?? 0} companies</div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">ARPU</div>
          <div className="text-xl font-bold text-slate-900 mt-1">${overview?.revenue?.arpu ?? '—'}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">per paying subscriber</div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">COIs on file</div>
          <div className="text-xl font-bold text-slate-900 mt-1">{overview?.platform?.cois ?? '—'}</div>
          <div className="text-[11px] text-amber-700 font-mono mt-0.5">{overview?.platform?.pending_reviews ?? 0} pending review</div>
        </div>
        <div className="bg-white rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">Subs tracked</div>
          <div className="text-xl font-bold text-slate-900 mt-1">{overview?.platform?.subcontractors ?? '—'}</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">{overview?.platform?.client_share_links ?? 0} share links</div>
        </div>
      </div>

      {/* Revenue by plan + growth */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-white rounded-lg p-4 border border-slate-200 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <h2 className="font-bold text-slate-900">Revenue by plan</h2>
            <span className="text-slate-400 font-mono text-[11px]">MRR from assigned plans</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 text-left font-mono text-[10px]">
                  <th className="py-1 px-2 font-semibold">PLAN</th>
                  <th className="py-1 px-2 font-semibold text-right">PRICE</th>
                  <th className="py-1 px-2 font-semibold text-right">SUBSCRIBERS</th>
                  <th className="py-1 px-2 font-semibold text-right">MRR</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {(overview?.revenue?.plan_breakdown || []).map((p) => {
                  const price =
                    overview?.revenue?.available_plans?.find((a) => a.plan === p.plan)?.price ?? 0
                  return (
                    <tr key={p.plan}>
                      <td className="py-2 px-2 font-semibold font-sans text-slate-900">{p.plan}</td>
                      <td className="py-2 px-2 text-right text-slate-600">${price}</td>
                      <td className="py-2 px-2 text-right text-slate-600">{p.count}</td>
                      <td className="py-2 px-2 text-right font-bold text-emerald-800">${p.mrr.toLocaleString()}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-white rounded-lg p-4 border border-slate-200 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <h2 className="font-bold text-slate-900">Sign-ups</h2>
            <span className="text-slate-400 font-mono text-[11px]">new users / month</span>
          </div>
          <div className="space-y-1.5">
            {(overview?.growth || []).map((g) => (
              <div key={g.month} className="space-y-0.5">
                <div className="flex justify-between text-[11px] font-mono text-slate-500">
                  <span>{g.month}</span>
                  <span className="font-semibold text-slate-700">+{g.new_users}</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-slate-900 transition-all duration-300"
                    style={{ width: `${Math.round((g.new_users / maxGrowth) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(overview?.growth || []).length === 0 && (
              <div className="text-xs text-slate-400 text-center py-4 font-mono">no data</div>
            )}
          </div>
        </div>
      </div>

      {/* Companies */}
      <div className="bg-white rounded-lg p-4 border border-slate-200 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h2 className="font-bold text-slate-900 text-xs">Companies ({filteredCompanies.length})</h2>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              placeholder="Search companies…"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              className="pl-8 pr-3 py-1 text-xs rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-900 w-52 font-mono"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 text-left font-mono text-[10px]">
                <th className="py-1 px-2 font-semibold">COMPANY</th>
                <th className="py-1 px-2 font-semibold">OWNER</th>
                <th className="py-1 px-2 font-semibold">PLAN</th>
                <th className="py-1 px-2 font-semibold text-right">MRR</th>
                <th className="py-1 px-2 font-semibold text-right">SUBS</th>
                <th className="py-1 px-2 font-semibold text-right">PROJECTS</th>
                <th className="py-1 px-2 font-semibold text-right">JOINED</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredCompanies.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="py-2 px-2 font-semibold text-slate-900">{c.name}</td>
                  <td className="py-2 px-2">
                    <div className="text-slate-700">{c.owner_name || '—'}</div>
                    <div className="text-[11px] text-slate-400 font-mono">{c.owner_email || '—'}</div>
                  </td>
                  <td className="py-2 px-2">
                    <select
                      value={c.plan}
                      disabled={savingPlanId === c.id}
                      onChange={(e) => handlePlanChange(c.id, e.target.value)}
                      className="text-xs px-2 py-0.5 rounded border border-slate-200 bg-white font-mono"
                    >
                      <option value="Free Demo">Free Demo · $0</option>
                      <option value="Starter">Starter · $49</option>
                      <option value="Professional">Professional · $149</option>
                      <option value="Enterprise">Enterprise · $499</option>
                    </select>
                  </td>
                  <td className="py-2 px-2 text-right font-mono font-semibold text-slate-900">${(c.mrr || 0).toLocaleString()}</td>
                  <td className="py-2 px-2 text-right font-mono text-slate-600">{c.subcontractor_count}</td>
                  <td className="py-2 px-2 text-right font-mono text-slate-600">{c.project_count}</td>
                  <td className="py-2 px-2 text-right font-mono text-slate-400">{c.created_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Users */}
      <div className="bg-white rounded-lg p-4 border border-slate-200 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h2 className="font-bold text-slate-900 text-xs">Users ({filteredUsers.length})</h2>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-200 p-0.5 text-xs bg-slate-50 font-mono text-[11px]">
              {(['all', 'admin', 'gc'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRoleFilter(r)}
                  className={`px-2 py-0.5 rounded transition ${
                    roleFilter === r ? 'bg-white text-slate-900 font-bold shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {r === 'all' ? 'all' : r === 'admin' ? 'admins' : 'gcs'}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                placeholder="Search users…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="pl-8 pr-3 py-1 text-xs rounded-md border border-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-900 w-44 font-mono"
              />
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 text-left font-mono text-[10px]">
                <th className="py-1 px-2 font-semibold">USER</th>
                <th className="py-1 px-2 font-semibold">COMPANY</th>
                <th className="py-1 px-2 font-semibold">ROLE</th>
                <th className="py-1 px-2 font-semibold text-right">JOINED</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-2 px-2">
                    <span className="font-semibold text-slate-900">{u.name}</span>
                    <span className="text-[11px] text-slate-400 font-mono ml-2">{u.email}</span>
                  </td>
                  <td className="py-2 px-2 text-slate-600">{u.company_name || '—'}</td>
                  <td className="py-2 px-2">
                    <select
                      value={u.role}
                      disabled={savingRoleId === u.id}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="text-xs px-2 py-0.5 rounded border border-slate-200 bg-white font-mono"
                    >
                      <option value="gc">gc</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="py-2 px-2 text-right font-mono text-slate-400">{u.created_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
