import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { apiAdmin, apiMe } from '../api'
import type { AdminOverview, AdminCompany, AdminUser, User } from '../types'
import { RefreshCw, Search, Trash2, RotateCcw } from 'lucide-react'

export function AdminDashboardPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'gc'>('all')
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())

  const notify = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3500)
  }

  const load = async () => {
    try {
      setLoading(true)
      setError(null)
      const [ov, comps, usrs, meData] = await Promise.all([
        apiAdmin.overview(),
        apiAdmin.companies(),
        apiAdmin.users(),
        apiMe().catch(() => null),
      ])
      setOverview(ov)
      setCompanies(comps.companies)
      setUsers(usrs.users)
      if (meData?.user) setMe(meData.user)
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

  const handlePlanChange = async (id: string, plan: string) => {
    try {
      setSavingPlanId(id)
      await apiAdmin.updatePlan(id, plan)
      notify('Plan updated')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Plan update failed')
    } finally {
      setSavingPlanId(null)
    }
  }

  const handleRoleChange = async (id: string, role: string) => {
    try {
      setSavingRoleId(id)
      await apiAdmin.updateRole(id, role)
      notify('Role updated')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Role update failed')
    } finally {
      setSavingRoleId(null)
    }
  }

  const handleDeleteCompany = async (c: AdminCompany) => {
    if (!confirm(`Delete "${c.name}"? This removes the company and its record.`)) return
    try {
      await apiAdmin.deleteCompany(c.id)
      notify(`Deleted ${c.name}`)
      await load()
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    }
  }

  const handleDeleteUser = async (u: AdminUser) => {
    if (me && u.id === me.id) {
      notify('You cannot delete your own account')
      return
    }
    if (!confirm(`Delete user "${u.name || u.email}"?`)) return
    try {
      await apiAdmin.deleteUser(u.id)
      notify(`Deleted ${u.email}`)
      await load()
    } catch (err: any) {
      notify(err?.message || 'Delete failed')
    }
  }

  const handleResetData = async () => {
    if (!confirm('Reset all demo data? This restores the full demo dataset (companies, users, COIs, growth history).'))
      return
    try {
      await apiAdmin.resetDemoData()
      notify('Reset to fresh demo data')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Reset failed')
    }
  }

  const filteredCompanies = useMemo(() => {
    const q = companySearch.trim().toLowerCase()
    if (!q) return companies
    return companies.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.plan?.toLowerCase().includes(q) ||
        c.owner_name?.toLowerCase().includes(q) ||
        c.owner_email?.toLowerCase().includes(q)
    )
  }, [companies, companySearch])

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase()
    return users.filter((u) => {
      const matchRole = roleFilter === 'all' ? true : roleFilter === 'admin' ? u.role === 'admin' : u.role !== 'admin'
      if (!matchRole) return false
      if (!q) return true
      return (
        u.email?.toLowerCase().includes(q) ||
        u.name?.toLowerCase().includes(q) ||
        u.company_name?.toLowerCase().includes(q)
      )
    })
  }, [users, userSearch, roleFilter])

  const plans = overview?.revenue.plan_breakdown || []
  const maxGrowth = Math.max(1, ...(overview?.growth.map((g) => g.new_users) || [1]))

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Staff</h1>
          <p className="text-xs text-slate-500 font-mono mt-0.5">Platform command center · live data</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-400 font-mono hidden sm:inline">
            {lastRefreshed.toLocaleTimeString()}
          </span>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100 transition disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <button
            onClick={handleResetData}
            title="Restore full demo dataset (companies, users, COIs, growth history)"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 transition"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Reset demo data
          </button>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-800 hover:bg-emerald-50 transition font-mono"
          >
            Contractor view →
          </Link>
        </div>
      </div>

      {statusMsg && (
        <div className="text-xs font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {statusMsg}
        </div>
      )}

      {error && (
        <div className="text-xs font-mono text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Users</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {overview ? overview.users.total : '—'}
          </div>
          <div className="text-[11px] font-mono text-emerald-700 mt-0.5">
            +{overview?.users.new_this_month ?? 0} this month
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">MRR</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            ${overview ? overview.revenue.mrr.toLocaleString() : '0'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
            ${overview ? overview.revenue.arr.toLocaleString() : '0'} ARR
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Paying</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {overview ? overview.revenue.paying_subscribers : '—'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
            of {overview?.platform.companies ?? 0} companies
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">ARPU</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            ${overview ? overview.revenue.arpu : '—'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">per paying subscriber</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">COIs on file</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {overview ? overview.platform.cois : '—'}
          </div>
          <div className="text-[11px] font-mono text-amber-700 mt-0.5">
            {overview?.platform.pending_reviews ?? 0} pending review
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-3">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">Subs tracked</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {overview ? overview.platform.subcontractors : '—'}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
            {overview?.platform.client_share_links ?? 0} share links
          </div>
        </div>
      </div>

      {/* Revenue & growth */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-4">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">Revenue by plan</h2>
            <span className="text-[11px] font-mono text-slate-400">MRR from assigned plans</span>
          </div>
          <div className="divide-y divide-slate-100 text-xs font-mono">
            <div className="grid grid-cols-4 py-2 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
              <div>Plan</div>
              <div className="text-right">Price</div>
              <div className="text-right">Subscribers</div>
              <div className="text-right">MRR</div>
            </div>
            {plans.map((p) => {
              const price = overview?.revenue.available_plans.find((ap) => ap.plan === p.plan)?.price ?? 0
              return (
                <div key={p.plan} className="grid grid-cols-4 py-2 items-center">
                  <div className="font-semibold text-slate-900">{p.plan}</div>
                  <div className="text-right text-slate-600">${price}</div>
                  <div className="text-right text-slate-600">{p.count}</div>
                  <div className="text-right font-bold text-emerald-800">${p.mrr.toLocaleString()}</div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">Sign-ups</h2>
            <span className="text-[11px] font-mono text-slate-400">new users / month</span>
          </div>
          <div className="space-y-2 pt-3 font-mono text-xs">
            {overview && overview.growth.length > 0 ? (
              overview.growth.map((g) => (
                <div key={g.month} className="flex items-center gap-2">
                  <span className="w-16 text-[11px] text-slate-500">{g.month}</span>
                  <div className="flex-1 bg-slate-100 rounded h-3 overflow-hidden">
                    <div
                      className="bg-slate-800 h-3 rounded"
                      style={{ width: `${Math.max(6, (g.new_users / maxGrowth) * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-bold text-slate-900 text-[11px]">+{g.new_users}</span>
                </div>
              ))
            ) : (
              <div className="text-center text-slate-400 text-xs py-6">no data</div>
            )}
          </div>
          <div className="text-[10px] font-mono text-slate-400 pt-3 border-t border-slate-100 mt-3">
            Last 6 months, ISO string month buckets
          </div>
        </div>
      </div>

      {/* Companies */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
            Companies ({filteredCompanies.length})
          </h2>
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search companies…"
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-500 w-56"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3">Company</th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">Plan</th>
                <th className="py-2 pr-3 text-right">MRR</th>
                <th className="py-2 pr-3 text-right">Subs</th>
                <th className="py-2 pr-3 text-right">Projects</th>
                <th className="py-2 pr-3">Joined</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredCompanies.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3 font-semibold text-slate-900">{c.name}</td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    <div>{c.owner_name || '—'}</div>
                    <div className="text-[10px] text-slate-400">{c.owner_email || '—'}</div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <select
                      value={c.plan || 'Free Demo'}
                      disabled={savingPlanId === c.id}
                      onChange={(e) => handlePlanChange(c.id, e.target.value)}
                      className="text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:border-slate-500"
                    >
                      {overview?.revenue.available_plans.map((ap) => (
                        <option key={ap.plan} value={ap.plan}>
                          {ap.plan} · ${ap.price}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 pr-3 text-right font-bold text-slate-900">${(c.mrr || 0).toLocaleString()}</td>
                  <td className="py-2.5 pr-3 text-right text-slate-600">{c.subcontractor_count}</td>
                  <td className="py-2.5 pr-3 text-right text-slate-600">{c.project_count}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{c.created_at ? c.created_at.slice(0, 10) : '—'}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleDeleteCompany(c)}
                      title="Delete company"
                      className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Users */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
            Users ({filteredUsers.length})
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex text-xs font-mono border border-slate-300 rounded-lg overflow-hidden">
              {(['all', 'admin', 'gc'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRoleFilter(r)}
                  className={`px-2.5 py-1 ${
                    roleFilter === r ? 'bg-slate-900 text-white font-bold' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {r === 'gc' ? 'gcs' : r === 'admin' ? 'admins' : 'all'}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                placeholder="Search users…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-500 w-52"
              />
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono text-left">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3">User</th>
                <th className="py-2 pr-3">Company</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Joined</th>
                <th className="py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredUsers.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-2.5 pr-3">
                    <div className="font-semibold text-slate-900">{u.name || '—'}</div>
                    <div className="text-[10px] text-slate-400">{u.email}</div>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">{u.company_name || '—'}</td>
                  <td className="py-2.5 pr-3">
                    <select
                      value={u.role || 'gc'}
                      disabled={savingRoleId === u.id}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                      className="text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:border-slate-500"
                    >
                      <option value="gc">gc</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-500">{u.created_at ? u.created_at.slice(0, 10) : '—'}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleDeleteUser(u)}
                      disabled={me ? u.id === me.id : false}
                      title={me && u.id === me.id ? 'Cannot delete your own account' : 'Delete user'}
                      className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
