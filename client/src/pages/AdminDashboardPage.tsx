import { Button } from '../components/Button'
import { useEffect, useState, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { apiAdmin, apiMe } from '../api'
import type { AdminOverview, AdminCompany, AdminUser, User, AdminCoiValidationItem, AdminCoiCounts } from '../types'
import { RefreshCw, Search, Trash2, RotateCcw, CheckCircle2, Sparkles, ExternalLink, ChevronDown, ChevronUp, AlertCircle, FileText } from 'lucide-react'
import { formatDisplayDate } from '../lib/date'
import { formatAmount } from '../lib/currency'

const GC_PLANS: Array<{ plan: string; price: number }> = [
  { plan: 'Free Demo', price: 0 },
  { plan: 'General Contractor', price: 10 },
  { plan: 'Pro GC', price: 29 },
]

export function AdminDashboardPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [companies, setCompanies] = useState<AdminCompany[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [me, setMe] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [companySearch, setCompanySearch] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'gc' | 'pro_gc' | 'sub'>('all')
  const [savingPlanId, setSavingPlanId] = useState<string | null>(null)
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null)
  const [planModal, setPlanModal] = useState<{ open: boolean; company: AdminCompany | null; newPlan: string; reason: string }>({
    open: false,
    company: null,
    newPlan: 'General Contractor',
    reason: '',
  })
  const [excludeTest, setExcludeTest] = useState(false)
  const [testFlagLoading, setTestFlagLoading] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())
  const [coiQueue, setCoiQueue] = useState<AdminCoiValidationItem[]>([])
  const [coiCounts, setCoiCounts] = useState<AdminCoiCounts | null>(null)
  const [coiLoading, setCoiLoading] = useState(false)
  const [coiError, setCoiError] = useState<string | null>(null)
  const [coiFilter, setCoiFilter] = useState<'pending' | 'ai_pending' | 'compliant' | 'needs_revision' | 'rejected' | 'all'>('pending')
  const [coiSearch, setCoiSearch] = useState('')
  const [selectedCoiIds, setSelectedCoiIds] = useState<Set<string>>(new Set())
  const [coiBusy, setCoiBusy] = useState<Record<string, string>>({})
  const [expandedCoiId, setExpandedCoiId] = useState<string | null>(null)

  const notify = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3500)
  }

  const load = async (excludeTestOverride?: boolean) => {
    try {
      setLoading(true)
      setError(null)
      const xt = excludeTestOverride ?? excludeTest
      const [ov, comps, usrs, meData] = await Promise.all([
        apiAdmin.overview({ exclude_test: xt }),
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
  const loadCoiQueue = useCallback(async (filter = coiFilter, search = coiSearch) => {
    try {
      setCoiLoading(true)
      setCoiError(null)
      const data = await apiAdmin.cois({ filter, search: search.trim() || undefined, limit: 200 })
      setCoiQueue(data.items)
      setCoiCounts(data.counts)
    } catch (err: any) {
      setCoiError(err?.message || 'Failed to load validation queue')
    } finally {
      setCoiLoading(false)
    }
  }, [coiFilter, coiSearch])
  useEffect(() => {
    loadCoiQueue(coiFilter, coiSearch)
  }, [coiFilter])
  const setBusy = (id: string, action: string | null) =>
    setCoiBusy((prev) => (action ? { ...prev, [id]: action } : (({ [id]: _, ...rest }) => rest)(prev)))
  const handleValidate = async (id: string) => {
    try {
      setBusy(id, 'validating')
      await apiAdmin.validateCoi(id)
      notify('COI validated — marked compliant')
      setSelectedCoiIds((prev) => { const s = new Set(prev); s.delete(id); return s })
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Validation failed')
    } finally {
      setBusy(id, null)
    }
  }
  const handleExtract = async (id: string) => {
    try {
      setBusy(id, 'extracting')
      await apiAdmin.extractCoi(id)
      notify('AI validation completed — fields auto-filled (pending verification)')
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'AI validation failed')
    } finally {
      setBusy(id, null)
    }
  }
  const handleSetStatus = async (id: string, status: string) => {
    try {
      setBusy(id, 'saving')
      await apiAdmin.setCoiStatus(id, status)
      notify(`Status updated to ${status}`)
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Update failed')
    } finally {
      setBusy(id, null)
    }
  }
  const handleViewCert = async (id: string) => {
    try {
      const { url } = await apiAdmin.coiCertificateUrl(id)
      if (url) window.open(url, '_blank')
    } catch (err: any) {
      notify(err?.message || 'Could not open certificate')
    }
  }
  const handleBatchValidate = async () => {
    const ids = Array.from(selectedCoiIds)
    if (!ids.length) return
    try {
      setCoiLoading(true)
      const res = await apiAdmin.batchValidateCois(ids)
      notify(`${res.validated} COIs validated and marked compliant`)
      setSelectedCoiIds(new Set())
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Batch validation failed')
    } finally {
      setCoiLoading(false)
    }
  }
  const handleBatchExtract = async () => {
    const ids = Array.from(selectedCoiIds)
    if (!ids.length) return
    try {
      setCoiLoading(true)
      const res = await apiAdmin.batchExtractCois(ids)
      const ok = res.results.filter((r) => r.ok).length
      notify(`AI validation finished: ${ok}/${res.results.length} succeeded`)
      setSelectedCoiIds(new Set())
      await Promise.all([loadCoiQueue(coiFilter, coiSearch), load()])
    } catch (err: any) {
      notify(err?.message || 'Batch AI validation failed')
    } finally {
      setCoiLoading(false)
    }
  }

  const openPlanModal = (c: AdminCompany) => {
    setPlanModal({ open: true, company: c, newPlan: c.plan || 'General Contractor', reason: '' })
  }
  const confirmPlanChange = async () => {
    if (!planModal.company) return
    try {
      setSavingPlanId(planModal.company.id)
      await apiAdmin.updatePlan(planModal.company.id, planModal.newPlan, planModal.reason)
      notify('Plan updated — change logged')
      setPlanModal({ open: false, company: null, newPlan: '', reason: '' })
      await load()
    } catch (err: any) {
      notify(err?.message || 'Plan update failed')
    } finally {
      setSavingPlanId(null)
    }
  }
  const handleToggleTest = async (c: AdminCompany) => {
    try {
      setTestFlagLoading(c.id)
      await apiAdmin.toggleTestFlag(c.id, !c.is_test)
      notify(c.is_test ? 'Unmarked as test' : 'Marked as test/demo')
      await load()
    } catch (err: any) {
      notify(err?.message || 'Update failed')
    } finally {
      setTestFlagLoading(null)
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
      const matchRole = roleFilter === 'all' ? true : u.role === roleFilter
      if (!matchRole) return false
      if (!q) return true
      return (
        u.email?.toLowerCase().includes(q) ||
        u.name?.toLowerCase().includes(q) ||
        u.company_name?.toLowerCase().includes(q)
      )
    })
  }, [users, userSearch, roleFilter])

  const plans = useMemo(() => {
    const list = [...(overview?.revenue.plan_breakdown || [])]
    if (!list.some((pl) => pl.plan === 'Enterprise')) list.push({ plan: 'Enterprise', count: 0, mrr: 0 })
    return list
  }, [overview])
  const totalSignups = overview?.users.total ?? 0
  const paidSubs = overview?.revenue.paying_subscribers ?? 0
  const paidPct = totalSignups ? Math.round((paidSubs / totalSignups) * 100) : 0
  const nonTestCompanies = companies.filter((c) => !excludeTest || !c.is_test)
  const totalComp = nonTestCompanies.length || 1
  const withSubs = nonTestCompanies.filter((c) => c.subcontractor_count > 0).length
  const withSubsPct = totalComp ? Math.round((withSubs / totalComp) * 100) : 0
  const withCompliant = overview?.platform.verified_cois ?? 0
  const withCompliantPct = totalComp ? Math.round((Math.min(withCompliant, totalComp) / totalComp) * 100) : 0

  const reviewNext = () => {
    const first = coiQueue.find((c) => c.status === 'pending_review' || c.ai_pending) || coiQueue[0]
    if (first) setExpandedCoiId(first.id)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as any).isContentEditable)) return
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        const ids = coiQueue.map((c) => c.id)
        if (!ids.length) return
        const idx = ids.indexOf(expandedCoiId || '')
        const next = ids[Math.min(idx + 1, ids.length - 1)]
        setExpandedCoiId(next)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const ids = coiQueue.map((c) => c.id)
        if (!ids.length) return
        const idx = ids.indexOf(expandedCoiId || '')
        const prev = ids[Math.max(idx - 1, 0)]
        setExpandedCoiId(prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [coiQueue, expandedCoiId])

  const maxGrowth = Math.max(1, ...(overview?.growth.map((g) => g.new_users) || [1]))

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Staff</h1>
          <p className="text-xs text-slate-500 mt-0.5">All companies and users</p>
        </div>
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 text-xs w-full sm:w-auto">
          <span className="text-slate-400 font-mono hidden sm:inline">
            {lastRefreshed.toLocaleTimeString()}
          </span>
          <Button
            variant="secondary"
            onClick={() => { void load(); void loadCoiQueue() }}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button
            variant="danger"
            onClick={handleResetData}
            title="Restore full demo dataset (companies, users, COIs, growth history)"
          >
            <RotateCcw className="w-4 h-4" /> Reset demo data
          </Button>
          <Link
            to="/dashboard"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-100 transition whitespace-nowrap"
          >
            Contractor view
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <button
          type="button"
          onClick={() => { const next = !excludeTest; setExcludeTest(next); void load(next) }}
          className={`min-h-[44px] px-3 py-2 rounded-lg border flex items-center gap-2 transition ${
            excludeTest
              ? 'bg-slate-900 text-white font-bold border-slate-900'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
          }`}
        >
          <span className={`w-3 h-3 rounded-sm border inline-flex items-center justify-center text-[9px] ${
            excludeTest ? 'bg-white text-slate-900 border-white font-bold' : 'border-slate-400'
          }`}>{excludeTest ? '\u2713' : ''}</span>
          Exclude test &amp; demo accounts
        </button>
        <span className="text-[11px] text-slate-400">
          MRR, paying subscribers, plans, and growth cards filter demo accounts
        </span>
      </div>

      {statusMsg && (
        <div className="text-xs font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          {statusMsg}
        </div>
      )}
      {overview?.email?.simulated !== false ? (
        <div className="text-xs font-mono text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          <span>Email: simulated mode — no real provider configured. Outgoing mail is recorded in the log but not delivered.</span>
          <span className="text-[10px] text-amber-700">staff only</span>
        </div>
      ) : (
        <div className="text-xs font-mono text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
          <span>Email: live delivery enabled ({overview?.email?.mode?.toUpperCase()}) — outgoing mail is really delivered.</span>
          <span className="text-[10px] text-emerald-700">staff only</span>
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
        <button
          type="button"
          onClick={() => { setCoiFilter('pending'); document.getElementById('validation-queue')?.scrollIntoView({ behavior: 'smooth' }) }}
          className="bg-white border border-slate-200 rounded-xl p-3 text-left hover:border-slate-400 transition cursor-pointer"
        >
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-400">COIs on file</div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {overview ? overview.platform.cois : '—'}
          </div>
          <div className="text-[11px] font-mono text-amber-700 mt-0.5 font-bold">
            {overview?.platform.pending_reviews ?? 0} pending review →
          </div>
        </button>
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
          </div>
          <div className="overflow-x-auto"><div className="min-w-[420px] divide-y divide-slate-100 text-xs font-mono">
            <div className="grid grid-cols-4 gap-2 py-2 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
              <div>Plan</div>
              <div className="text-right">Price</div>
              <div className="text-right">Subs</div>
              <div className="text-right">MRR</div>
            </div>
            {plans.map((p) => {
              const price = overview?.revenue.available_plans.find((ap) => ap.plan === p.plan)?.price ?? (p.plan === 'Enterprise' ? 59 : 0)
              return (
                <div key={p.plan} className="grid grid-cols-4 gap-2 py-2 items-center">
                  <div>
                    <span className="font-semibold text-slate-900">{p.plan}</span>
                    {p.plan === 'Subcontractor' && (
                      <span className="text-[10px] text-slate-400 block sm:inline sm:ml-1 font-mono">
                        · free for subcontractors
                      </span>
                    )}
                  </div>
                  <div className="text-right text-slate-600">${price}</div>
                  <div className="text-right text-slate-600">{p.count}</div>
                  <div className="text-right font-bold text-emerald-800">${p.mrr.toLocaleString()}</div>
                </div>
              )
            })}
          </div>
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

        </div>
      </div>

      {/* Activation funnel */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100 flex-wrap gap-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">Activation funnel</h2>
          <span className="text-[11px] font-mono text-slate-400">Signed up → On paid plan → Added ≥1 sub → ≥1 compliant COI</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3 bg-slate-50 rounded-lg">
            <div className="text-[10px] text-slate-400 uppercase">Signed up</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{totalSignups}</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-lg">
            <div className="text-[10px] text-slate-400 uppercase">On paid plan</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{paidSubs}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{paidPct}% of sign-ups</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-lg">
            <div className="text-[10px] text-slate-400 uppercase">Added ≥ 1 sub</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{withSubs}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{withSubsPct}% of companies</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-lg">
            <div className="text-[10px] text-slate-400 uppercase">≥ 1 compliant COI</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-1">{withCompliant}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">{withCompliantPct}% of companies</div>
          </div>
        </div>
      </div>

      {/* Validation queue */}
      <div id="validation-queue" className="bg-white border border-slate-200 rounded-xl p-4 scroll-mt-6">
        <div className="flex flex-col gap-3 pb-3 border-b border-slate-100 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
              COIs needing validation
            </h2>
            <p className="text-[11px] text-slate-500 font-mono mt-0.5">
              Review submitted certificates, auto-filled AI data, and push validation
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="text-xs"
              onClick={() => { void loadCoiQueue(coiFilter, coiSearch); void load() }}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${coiLoading ? 'animate-spin' : ''}`} /> Refresh queue
            </Button>
            <Button
              className="text-xs"
              onClick={reviewNext}
              disabled={coiQueue.length === 0}
              title="Open the next pending certificate for review (or press J/K)"
            >
              Review next →
            </Button>
          </div>
        </div>

        {/* Filter chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
          {[
            { key: 'pending', label: 'Pending validation', count: coiCounts?.pending, cls: 'bg-amber-100 text-amber-900 border-amber-300' },
            { key: 'ai_pending', label: 'AI pending verification', count: coiCounts?.ai_pending, cls: 'bg-amber-50 text-amber-900 border-amber-200' },
            { key: 'compliant', label: 'Compliant', count: coiCounts?.compliant, cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' },
            { key: 'needs_revision', label: 'Needs revision', count: coiCounts?.needs_revision, cls: 'bg-orange-100 text-orange-900 border-orange-300' },
            { key: 'rejected', label: 'Rejected', count: coiCounts?.rejected, cls: 'bg-rose-100 text-rose-900 border-rose-300' },
            { key: 'all', label: 'All', count: coiCounts?.all, cls: 'bg-slate-100 text-slate-800 border-slate-200' },
          ].map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setCoiFilter(f.key as typeof coiFilter)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold font-mono transition min-h-[36px] flex items-center gap-1.5 ${
                coiFilter === f.key ? `${f.cls} ring-2 ring-slate-800 ring-offset-1` : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {f.label}
              {f.count !== undefined && <span className="font-bold">{f.count}</span>}
            </button>
          ))}
        </div>

        {/* Search & batch bar */}
        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="Search by company, trade, carrier, policy #, or GC…"
              value={coiSearch}
              onChange={(e) => setCoiSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-500 w-full"
            />
          </div>
          {selectedCoiIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" className="text-xs" onClick={handleBatchValidate}>
                <CheckCircle2 className="w-3.5 h-3.5" /> Validate selected ({selectedCoiIds.size})
              </Button>
              <Button variant="secondary" className="text-xs" onClick={handleBatchExtract}>
                <Sparkles className="w-3.5 h-3.5" /> Run AI on selected
              </Button>
              <button
                type="button"
                onClick={() => setSelectedCoiIds(new Set())}
                className="text-xs text-slate-500 hover:underline font-mono"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {coiError && (
          <div className="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 font-mono">
            {coiError}
          </div>
        )}

        {/* Desktop table */}
        <div className="mt-3 overflow-x-auto hidden md:block">
          <table className="w-full text-left text-xs font-mono min-w-[960px]">
            <thead>
              <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-2 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={coiQueue.length > 0 && selectedCoiIds.size === coiQueue.length}
                    onChange={(e) =>
                      setSelectedCoiIds(e.target.checked ? new Set(coiQueue.map((c) => c.id)) : new Set())
                    }
                  />
                </th>
                <th className="py-2 pr-3">Subcontractor</th>
                <th className="py-2 pr-3">Carrier / policy</th>
                <th className="py-2 pr-3">Dates</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">AI data</th>
                <th className="py-2 pr-3">GC</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {coiQueue.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-slate-400 py-8">
                    {coiLoading ? 'Loading queue…' : 'No COIs match this filter'}
                  </td>
                </tr>
              ) : (
                coiQueue.map((item) => {
                  const busy = coiBusy[item.id]
                  const isExp = item.days_left !== null && item.days_left < 0
                  return (
                    <tr key={item.id} className="hover:bg-slate-50 align-top">
                      <td className="py-2.5 pr-2 pt-3">
                        <input
                          type="checkbox"
                          checked={selectedCoiIds.has(item.id)}
                          onChange={(e) =>
                            setSelectedCoiIds((prev) => {
                              const s = new Set(prev)
                              e.target.checked ? s.add(item.id) : s.delete(item.id)
                              return s
                            })
                          }
                          aria-label={`Select ${item.sub_company_name || 'COI'}`}
                        />
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="font-bold text-slate-900">{item.sub_company_name || '—'}</div>
                        <div className="text-[11px] text-slate-500">
                          {item.trade || '—'} {item.sub_email ? `· ${item.sub_email}` : ''}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="font-bold text-slate-800">{item.carrier || '—'}</div>
                        <div className="text-[11px] text-slate-500">
                          {item.policy_number || 'No policy #'}
                          {!item.insurer_naic && item.carrier ? (
                            <span className="ml-1.5 text-[10px] font-bold text-rose-600 font-mono">NAIC not found</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div>{formatDisplayDate(item.effective_date)} → {formatDisplayDate(item.expiration_date)}</div>
                        <div className="text-[11px]">
                          <span className={`font-bold ${isExp ? 'text-rose-700' : (item.days_left ?? 999) <= 30 ? 'text-amber-700' : 'text-slate-500'}`}>
                            {item.days_left !== null ? (isExp ? `${Math.abs(item.days_left)}d expired` : `${item.days_left}d left`) : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${
                          item.status === 'compliant'
                            ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                            : item.status === 'pending_review'
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : item.status === 'needs_revision'
                            ? 'bg-orange-100 text-orange-900 border border-orange-300'
                            : item.status === 'rejected'
                            ? 'bg-rose-100 text-rose-900 border border-rose-300'
                            : 'bg-slate-100 text-slate-700'
                        }`}>
                          {item.status === 'pending_review' ? 'Pending validation' : item.status === 'needs_revision' ? 'Needs revision' : item.status === 'compliant' ? 'Compliant' : item.status}
                        </span>
                        {item.review_date && (
                          <div className="text-[10px] text-slate-400 mt-0.5">verified {formatDisplayDate(item.review_date)}</div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        {item.review_source ? (
                          <div className="space-y-0.5">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${
                              item.review_source === 'ocr'
                                ? 'bg-amber-100 text-amber-900 border border-amber-300'
                                : item.review_source === 'mixed'
                                ? 'bg-amber-50 text-amber-900 border border-amber-200'
                                : 'bg-slate-100 text-slate-700'
                            }`}>
                              {item.review_source === 'ocr' ? 'AI auto-filled' : item.review_source === 'mixed' ? 'AI · edited' : 'Manual'}
                            </span>
                            {item.ai_pending && (
                              <div className="text-[10px] text-amber-800 font-bold">pending verification</div>
                            )}
                            {item.review_insured && (
                              <div className="text-[11px] text-slate-600 truncate max-w-[200px]" title={item.review_insured}>
                                insured: {item.review_insured}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-400">
                              {item.review_policy_count} policies · {item.review_limit_count} limits
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 text-[11px]">No AI data</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="text-slate-800 font-bold">{item.gc_company_name || '—'}</div>
                        <div className="text-[10px] text-slate-400">{item.gc_email || ''}</div>
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="primary"
                            className="text-xs !py-1 !px-2.5"
                            onClick={() => handleValidate(item.id)}
                            disabled={busy === 'validating'}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {busy === 'validating' ? 'Validating…' : 'Validate'}
                          </Button>
                          <Button
                            variant="secondary"
                            className="text-xs !py-1 !px-2.5"
                            onClick={() => handleExtract(item.id)}
                            disabled={!item.has_file || busy === 'extracting'}
                            title={!item.has_file ? 'No certificate file uploaded to extract' : 'Run AI extraction now'}
                          >
                            <Sparkles className={`w-3.5 h-3.5 ${busy === 'extracting' ? 'animate-spin' : ''}`} />
                            {busy === 'extracting' ? 'Extracting…' : 'Run AI'}
                          </Button>
                          {item.has_file && (
                            <Button
                              variant="secondary"
                              className="text-xs !py-1 !px-2"
                              onClick={() => handleViewCert(item.id)}
                              title="View certificate PDF/image"
                            >
                              <ExternalLink className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="secondary"
                            className="text-xs !py-1 !px-2"
                            onClick={() => setExpandedCoiId(expandedCoiId === item.id ? null : item.id)}
                            title="Toggle extracted details"
                          >
                            {expandedCoiId === item.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </Button>
                          <select
                            aria-label={`Set status for ${item.sub_company_name || 'COI'}`}
                            value={item.status}
                            onChange={(e) => handleSetStatus(item.id, e.target.value)}
                            disabled={busy === 'saving'}
                            className="text-[11px] font-mono border border-slate-300 rounded px-1.5 py-1 bg-white focus:outline-none focus:border-slate-500"
                          >
                            <option value="pending_review">Pending validation</option>
                            <option value="compliant">Compliant</option>
                            <option value="needs_revision">Needs revision</option>
                            <option value="rejected">Rejected</option>
                          </select>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="mt-3 space-y-3 md:hidden">
          {coiQueue.length === 0 ? (
            <div className="text-center text-slate-400 py-6 text-xs font-mono">
              {coiLoading ? 'Loading queue…' : 'No COIs match this filter'}
            </div>
          ) : (
            coiQueue.map((item) => {
              const busy = coiBusy[item.id]
              const isExp = item.days_left !== null && item.days_left < 0
              return (
                <div key={item.id} className="rounded-xl border border-slate-200 p-3 text-xs font-mono space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedCoiIds.has(item.id)}
                        onChange={(e) =>
                          setSelectedCoiIds((prev) => {
                            const s = new Set(prev)
                            e.target.checked ? s.add(item.id) : s.delete(item.id)
                            return s
                          })
                        }
                        aria-label={`Select ${item.sub_company_name || 'COI'}`}
                        className="mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 truncate">{item.sub_company_name || '—'}</div>
                        <div className="text-[11px] text-slate-500">{item.trade || '—'}</div>
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap ${
                      item.status === 'compliant'
                        ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                        : item.status === 'pending_review'
                        ? 'bg-amber-100 text-amber-900 border border-amber-300'
                        : 'bg-slate-100 text-slate-700'
                    }`}>
                      {item.status === 'pending_review' ? 'Pending validation' : item.status}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600">
                    <span className="font-bold">{item.carrier || '—'}</span> · {item.policy_number || 'No policy #'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {formatDisplayDate(item.effective_date)} → {formatDisplayDate(item.expiration_date)}
                    {' '}·{' '}
                    <span className={`font-bold ${isExp ? 'text-rose-700' : 'text-slate-700'}`}>
                      {item.days_left !== null ? (isExp ? `${Math.abs(item.days_left)}d expired` : `${item.days_left}d left`) : '—'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {item.review_source ? (
                      <span className="text-[10px] bg-amber-100 text-amber-900 border border-amber-300 rounded-full px-2 py-0.5 font-bold">
                        {item.review_source === 'ocr' ? 'AI auto-filled' : item.review_source}
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-400">No AI data</span>
                    )}
                    {item.ai_pending && <span className="text-[10px] text-amber-800 font-bold">pending verification</span>}
                  </div>
                  {item.gc_company_name && (
                    <div className="text-[10px] text-slate-400">GC: {item.gc_company_name}</div>
                  )}
                  <div className="flex flex-wrap items-center gap-1 pt-1">
                    <Button
                      variant="primary"
                      className="text-xs !py-1 !px-2.5 flex-1"
                      onClick={() => handleValidate(item.id)}
                      disabled={busy === 'validating'}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {busy === 'validating' ? 'Validating…' : 'Validate'}
                    </Button>
                    <Button
                      variant="secondary"
                      className="text-xs !py-1 !px-2.5"
                      onClick={() => handleExtract(item.id)}
                      disabled={!item.has_file || busy === 'extracting'}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {busy === 'extracting' ? 'Extracting…' : 'Run AI'}
                    </Button>
                    {item.has_file && (
                      <Button
                        variant="secondary"
                        className="text-xs !py-1 !px-2"
                        onClick={() => handleViewCert(item.id)}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      className="text-xs !py-1 !px-2"
                      onClick={() => setExpandedCoiId(expandedCoiId === item.id ? null : item.id)}
                    >
                      {expandedCoiId === item.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                  <div>
                    <select
                      aria-label={`Set status for ${item.sub_company_name || 'COI'}`}
                      value={item.status}
                      onChange={(e) => handleSetStatus(item.id, e.target.value)}
                      disabled={busy === 'saving'}
                      className="w-full text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:border-slate-500"
                    >
                      <option value="pending_review">Pending validation</option>
                      <option value="compliant">Compliant</option>
                      <option value="needs_revision">Needs revision</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Expandable details panel */}
        {expandedCoiId && (() => {
          const item = coiQueue.find((c) => c.id === expandedCoiId)
          if (!item) return null
          const d: any = item.review_details
          return (
            <div className="mt-3 p-4 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800">
                  Extracted details — {item.sub_company_name || 'COI'}
                </span>
                <button
                  type="button"
                  onClick={() => setExpandedCoiId(null)}
                  className="text-slate-400 hover:text-slate-700"
                >
                  <ChevronUp className="w-4 h-4 inline" /> close
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase text-slate-400">Insured (policyholder company)</div>
                  <div className="font-bold text-slate-900">{d?.insured?.name || '—'}</div>
                  <div className="text-slate-500 text-[11px]">{d?.insured?.address || ''}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-slate-400">Producer (agency/broker)</div>
                  <div className="font-bold text-slate-900">{d?.producer?.name || '—'}</div>
                  <div className="text-slate-500 text-[11px]">
                    {[d?.producer?.phone, d?.producer?.email].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-400 mb-1">Insurers affording coverage</div>
                {Array.isArray(d?.insurers) && d.insurers.length > 0 ? (
                  <div className="space-y-1">
                    {d.insurers.map((ins: any, i: number) => (
                      <div key={i} className="flex gap-2">
                        <span className="font-bold text-slate-800 w-6">[{ins.letter || '-'}]</span>
                        <span className="text-slate-900 flex-1">{ins.name || '—'}</span>
                        <span className="text-slate-500">NAIC #{ins.naic || '—'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-slate-400">No insurers</div>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-400 mb-1">Policies &amp; limits</div>
                {Array.isArray(d?.policies) && d.policies.length > 0 ? (
                  <div className="space-y-2">
                    {d.policies.map((p: any, i: number) => (
                      <div key={i} className="p-2 rounded bg-white border border-slate-200">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <span className="font-bold text-slate-900">{p.type || 'Policy'}</span>
                          <span className="text-slate-500">
                            #{p.policyNumber || '—'} · Insurer {p.insurerLetter || '—'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-600">
                          {formatDisplayDate(p.effectiveDate)} → {formatDisplayDate(p.expirationDate)}
                        </div>
                        {Array.isArray(p.limits) && p.limits.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                            {p.limits.map((l: any, j: number) => (
                              <span key={j} className="bg-slate-100 rounded px-1.5 py-0.5 text-slate-700">
                                {l.label ? `${l.label}: ` : ''}{formatAmount(l.amount)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-slate-400">No policy lines</div>
                )}
              </div>
              {item.reviewer_notes && (
                <div>
                  <div className="text-[10px] uppercase text-slate-400">Reviewer notes</div>
                  <div className="text-slate-700 italic">{item.reviewer_notes}</div>
                </div>
              )}
            </div>
          )
        })()}
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
              className="pl-8 pr-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-500 w-full sm:w-56"
            />
          </div>
        </div>
        <div className="sm:hidden divide-y divide-slate-100 text-xs font-mono">
          {filteredCompanies.map((c) => (
            <div key={c.id} className={`py-3 space-y-2 rounded-lg px-2 -mx-2 ${c.is_test ? 'bg-amber-50/60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-900 truncate">{c.name}</span>
                    {c.is_test && (
                      <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900">
                        TEST
                      </span>
                    )}
                  </div>
                  <div className="text-slate-500 truncate">{c.owner_name || '—'}</div>
                  <div className="text-[10px] text-slate-400 truncate">{c.owner_email || '—'}</div>
                </div>
                <button
                  onClick={() => handleDeleteCompany(c)}
                  title="Delete company"
                  className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-800">
                  {c.plan || 'Free Demo'} · ${(c.mrr || 0).toLocaleString()}/mo
                </span>
                <button
                  type="button"
                  onClick={() => openPlanModal(c)}
                  className="text-[11px] font-mono text-brand-700 hover:text-brand-900 underline"
                >
                  Change plan…
                </button>
                <button
                  type="button"
                  onClick={() => void handleToggleTest(c)}
                  disabled={testFlagLoading === c.id}
                  className="text-[10px] font-mono text-slate-400 hover:text-slate-700 underline"
                  title="Toggle whether this company is counted in MRR/metrics"
                >
                  {c.is_test ? 'unmark test' : 'mark as test'}
                </button>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-slate-600 pt-1">
                <span>MRR <strong className="text-slate-900">${(c.mrr || 0).toLocaleString()}</strong></span>
                <span>Subs {c.subcontractor_count}</span>
                <span>Projects {c.project_count}</span>
                <span className="text-slate-400">Joined {c.created_at ? c.created_at.slice(0, 10) : '—'}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="hidden sm:block overflow-x-auto">
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
                <tr key={c.id} className={c.is_test ? 'bg-amber-50/50 hover:bg-amber-100/50' : 'hover:bg-slate-50'}>
                  <td className="py-2.5 pr-3 font-semibold text-slate-900">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>{c.name}</span>
                      {c.is_test && (
                        <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900">
                          TEST
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleToggleTest(c)}
                        disabled={testFlagLoading === c.id}
                        className="text-[10px] font-mono text-slate-400 hover:text-slate-700 underline"
                        title="Toggle whether this company is counted in MRR/metrics"
                      >
                        {c.is_test ? 'unmark' : 'mark test'}
                      </button>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    <div>{c.owner_name || '—'}</div>
                    <div className="text-[10px] text-slate-400">{c.owner_email || '—'}</div>
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-800">
                        {c.plan || 'Free Demo'}
                      </span>
                      <button
                        type="button"
                        onClick={() => openPlanModal(c)}
                        className="text-[11px] font-mono text-brand-700 hover:text-brand-900 underline"
                      >
                        Change…
                      </button>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-right font-bold text-slate-900">${(c.mrr || 0).toLocaleString()}</td>
                  <td className="py-2.5 pr-3 text-right text-slate-600">{c.subcontractor_count}</td>
                  <td className="py-2.5 pr-3 text-right text-slate-600">{c.project_count}</td>
                  <td className="py-2.5 pr-3 text-slate-500">{c.created_at ? c.created_at.slice(0, 10) : '—'}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleDeleteCompany(c)}
                      title="Delete company"
                      className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
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
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            <div className="flex flex-wrap gap-1 w-full sm:w-auto text-xs font-mono">
              {(['all', 'admin', 'gc', 'pro_gc', 'sub'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRoleFilter(r)}
                  className={`flex-1 sm:flex-initial min-h-[44px] px-2.5 py-2 rounded-md border ${
                    roleFilter === r ? 'bg-slate-900 text-white font-bold border-slate-900' : 'text-slate-600 bg-white border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {r === 'admin' ? 'Admins' : r === 'gc' ? 'GCs' : r === 'pro_gc' ? 'Pro GCs' : r === 'sub' ? 'Sub Cs' : 'All'}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-56">
              <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                placeholder="Search users…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                className="w-full sm:w-56 pl-8 pr-3 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-500"
              />
            </div>
          </div>
        </div>
        <div className="sm:hidden divide-y divide-slate-100 text-xs font-mono">
          {filteredUsers.map((u) => (
            <div key={u.id} className="py-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900 truncate">{u.name || '—'}</div>
                  <div className="text-[10px] text-slate-400 truncate">{u.email}</div>
                  <div className="text-slate-500 mt-1 truncate">{u.company_name || '—'}</div>
                </div>
                <button
                  onClick={() => handleDeleteUser(u)}
                  disabled={me ? u.id === me.id : false}
                  title={me && u.id === me.id ? 'Cannot delete your own account' : 'Delete user'}
                  className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div>
                <select
                  value={u.role || 'gc'}
                  disabled={savingRoleId === u.id}
                  onChange={(e) => handleRoleChange(u.id, e.target.value)}
                  className="w-full text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:border-slate-500"
                >
                  <option value="admin">Admin</option>
                  <option value="gc">GC</option>
                  <option value="pro_gc">Pro GC</option>
                  <option value="sub">Sub C</option>
                </select>
              </div>
              <div className="text-[11px] text-slate-400 pt-1">
                Joined {u.created_at ? u.created_at.slice(0, 10) : '—'}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden sm:block overflow-x-auto">
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
                      <option value="admin">Admin</option>
                      <option value="gc">GC</option>
                      <option value="pro_gc">Pro GC</option>
                      <option value="sub">Sub C</option>
                    </select>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-500">{u.created_at ? u.created_at.slice(0, 10) : '—'}</td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleDeleteUser(u)}
                      disabled={me ? u.id === me.id : false}
                      title={me && u.id === me.id ? 'Cannot delete your own account' : 'Delete user'}
                      className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition disabled:opacity-30 disabled:cursor-not-allowed"
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
      {planModal.open && planModal.company && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60" onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900">Change plan</h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">{planModal.company.name}</p>
              </div>
              <button
                type="button"
                onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })}
                className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 text-lg"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div>
              <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">Current plan</div>
              <div className="mt-1 inline-block text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-slate-100 text-slate-800">
                {planModal.company.plan || 'Free Demo'} · ${(planModal.company.mrr || 0).toLocaleString()}/mo
              </div>
            </div>
            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block mb-1">New plan</label>
              <select
                value={planModal.newPlan}
                onChange={(e) => setPlanModal((m) => ({ ...m, newPlan: e.target.value }))}
                className="w-full text-sm font-mono border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-slate-500 min-h-[44px]"
              >
                {GC_PLANS.map((p) => (
                  <option key={p.plan} value={p.plan}>
                    {p.plan} · ${p.price}/mo
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-mono text-slate-400 uppercase tracking-wider block mb-1">Reason (audit log)</label>
              <textarea
                value={planModal.reason}
                onChange={(e) => setPlanModal((m) => ({ ...m, reason: e.target.value }))}
                placeholder="Reason for this change (e.g. upgraded to Pro GC per sales request)"
                rows={2}
                className="w-full text-xs font-mono border border-slate-300 rounded-lg p-2.5 focus:outline-none focus:border-slate-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setPlanModal({ open: false, company: null, newPlan: '', reason: '' })}>
                Cancel
              </Button>
              <Button onClick={() => void confirmPlanChange()} disabled={savingPlanId === planModal.company.id}>
                Confirm plan change
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
