import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, FileText, Send, Check, FolderPlus, ArrowRight, ShieldCheck, Mail } from 'lucide-react'
import type { Stats, Subcontractor, COI, GCSettings } from '../types'
import { Button } from '../components/Button'
import { apiStats, apiSubcontractors, apiCOIs, apiSettings, apiEmails, ApiError } from '../api'
import { StatsGrid } from '../components/StatsGrid'
import { ComplianceScore } from '../components/ComplianceScore'
import { ExpirationBadge } from '../components/ExpirationBadge'
import { ExpiryBanner } from '../components/ExpiryBanner'
import { RequestCOIModal } from '../components/RequestCOIModal'
import { SubcontractorModal } from '../components/SubcontractorModal'
import { COIReviewModal } from '../components/COIReviewModal'

interface Props {
  onOpenRequestCOI?: () => void
}

export function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [subs, setSubs] = useState<Subcontractor[]>([])
  const [pendingCois, setPendingCois] = useState<COI[]>([])
  const [gcSettings, setGcSettings] = useState<GCSettings | undefined>()
  const [loading, setLoading] = useState(true)
  const [requestModal, setRequestModal] = useState(false)
  const [requestSubId, setRequestSubId] = useState<string | undefined>()
  const [addSubModal, setAddSubModal] = useState(false)
  const [reviewCoi, setReviewCoi] = useState<COI | null>(null)
  const [reviewModal, setReviewModal] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const load = async () => {
    try {
      const [st, subList, pen, cfg] = await Promise.all([
        apiStats.get(),
        apiSubcontractors.list(),
        apiCOIs.list({ status: 'pending_review' }),
        apiSettings.get(),
      ])
      setStats(st)
      setSubs(subList.subcontractors)
      setPendingCois(pen.cois)
      setGcSettings(cfg.settings)
    } catch (e: any) {
      if (e instanceof ApiError && (e.status === 403 || e.message?.includes('GC access required'))) {
        // no-op; handled by the guarded render below
      }
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])
  if (loading) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-xs text-slate-400">Loading dashboard…</div>
  }
  if (!stats) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-sm text-slate-700">This account has no contractor workspace. Open Staff, or pick a company to view.</p>
        <Link to="/staff" className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-brand-700 transition">
          Open Staff
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      {/* Greeting + quick actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-xs text-slate-500 mt-0.5">Expirations, coverage limits, and compliance for your subcontractors.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setAddSubModal(true)}
            className="flex-1 sm:flex-initial"
          >
            <Plus className="w-4 h-4" /> Add subcontractor
          </Button>
          <Button
            variant="primary"
            onClick={() => { setRequestSubId(undefined); setRequestModal(true) }}
            className="flex-1 sm:flex-initial"
          >
            <FileText className="w-4 h-4" /> Request a COI
          </Button>
        </div>
      </div>

      {/* Expiration alert banner */}
      <ExpiryBanner upcoming={stats.upcoming} onReminderSent={() => { showToast('Renewal reminder queued (simulated)'); load() }} />

      {/* Stats grid */}
      <StatsGrid stats={stats} />

      {/* Compliance score + quick facts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ComplianceScore scorecard={{ ...stats.totals, pending: stats.totals.pending }} onAddSub={() => setAddSubModal(true)} />
        </div>
        <div className="bg-white rounded-xl p-5 border border-slate-200 flex flex-col justify-between text-xs space-y-3">
          <div>
            <div className="font-bold text-slate-900">Client portal</div>
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">
              Clients see coverage status only. Subcontractor contact details stay hidden, and questions come to you.
            </p>
          </div>
          <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-[11px]">
            <span className="text-slate-400 font-mono">{stats.share_links_count} active link{stats.share_links_count === 1 ? '' : 's'}</span>
            <Link
              to="/share/rcc-meridian-2026"
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-100 transition whitespace-nowrap"
            >
              Preview client view
            </Link>
          </div>
        </div>
      </div>

      {/* Pending GC reviews */}
      {pendingCois.length > 0 && (
        <div className="bg-sky-50/70 rounded-2xl p-5 border border-sky-200">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold uppercase tracking-wider text-sky-900 font-['JetBrains_Mono']">
              Needs your review
            </div>
            <span className="text-xs font-bold text-sky-900 bg-sky-200/70 px-2 py-0.5 rounded-full">
              {pendingCois.length} pending
            </span>
          </div>
          <p className="text-xs text-sky-950/80 mt-1">
            Subcontractors submitted these certificates through the self-service portal. Review coverage limits and approve or request revision.
          </p>
          <div className="mt-3 divide-y divide-sky-200/60 rounded-xl bg-white border border-sky-200 overflow-hidden text-xs">
            {pendingCois.map((c) => (
              <div key={c.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-slate-900">{c.company_name}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {c.trade} · {c.carrier} · exp. {c.expiration_date}
                  </div>
                </div>
                <div className="flex items-center gap-2 self-start sm:self-center">
                  <ExpirationBadge status="pending_review" size="sm" showCountdown={false} />
                  <Button
                    variant="primary"
                    onClick={() => { setReviewCoi(c); setReviewModal(true) }}
                  >
                    Review COI
                  </Button>
                  <Link
                    to="/subcontractors"
                    state={{ openSubId: c.subcontractor_id }}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-xs hover:bg-slate-100 transition whitespace-nowrap"
                  >
                    Review document data
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming expirations */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">Expiring in 60 days</h3>
          </div>
          <Link to="/subcontractors" className="text-xs font-bold text-brand-600 hover:text-brand-700 hidden sm:inline-flex items-center gap-1">
            View all subcontractors <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {stats.upcoming.length === 0 ? (
          <p className="text-xs text-slate-400 italic py-6 text-center">No policies expiring in the next 60 days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-wider text-[11px]">
                  <th className="py-2 pr-3">Subcontractor</th>
                  <th className="py-2 pr-3">Trade</th>
                  <th className="py-2 pr-3">Carrier</th>
                  <th className="py-2 pr-3">Expiration</th>
                  <th className="py-2 pr-3">Countdown</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stats.upcoming.map((u) => {
                  const isExp = u.days_left < 0
                  return (
                    <tr key={u.coi_id} className="hover:bg-slate-50">
                      <td className="py-3 pr-3 font-bold text-slate-900">{u.company_name}</td>
                      <td className="py-3 pr-3 text-slate-600">{u.trade}</td>
                      <td className="py-3 pr-3 text-slate-600">{u.carrier}</td>
                      <td className="py-3 pr-3 font-semibold text-slate-900">{u.expiration_date}</td>
                      <td className="py-3 pr-3">
                        <span className={`font-['JetBrains_Mono'] font-bold ${isExp ? 'text-rose-700' : u.days_left <= 30 ? 'text-amber-700' : 'text-slate-600'}`}>
                          {isExp ? `${Math.abs(u.days_left)}d ago` : `in ${u.days_left}d`}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <ExpirationBadge status={u.status} daysLeft={u.days_left} size="sm" showCountdown={false} />
                      </td>
                      <td className="py-3 text-right">
                        <Button
                          variant="secondary"
                          onClick={async () => {
                            await apiEmails.sendReminder(u.coi_id)
                            showToast(`Reminder queued for ${u.company_name} (simulated)`)
                          }}
                        >
                          <Send className="w-3.5 h-3.5" /> Remind
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Trade breakdown */}
      <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-card">
        <h3 className="text-lg font-bold text-slate-900 mb-4">Compliance by trade</h3>
        <div className="space-y-3 text-xs">
          {stats.trades.map((t) => {
            const pct = t.total > 0 ? Math.round((t.compliant / t.total) * 100) : 100
            return (
              <div key={t.trade}>
                <div className="flex justify-between font-semibold text-slate-700">
                  <span>{t.trade}</span>
                  <span className="font-['JetBrains_Mono'] text-slate-500">
                    {t.compliant}/{t.total} compliant · {pct}%
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    style={{ width: `${pct}%` }}
                    className={`h-full rounded-full ${pct === 100 ? 'bg-emerald-500' : pct >= 66 ? 'bg-amber-400' : 'bg-rose-500'}`}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Modals */}
      <RequestCOIModal
        subcontractors={subs}
        open={requestModal}
        onClose={() => setRequestModal(false)}
        initialSubId={requestSubId}
        onSuccess={() => { showToast('COI request link created'); load() }}
      />
      <SubcontractorModal
        open={addSubModal}
        onClose={() => setAddSubModal(false)}
        onSaved={() => { showToast('Subcontractor saved'); load() }}
      />
      <COIReviewModal
        coi={reviewCoi}
        open={reviewModal}
        onClose={() => setReviewModal(false)}
        onUpdated={() => { showToast('COI status updated'); load() }}
        gcSettings={gcSettings}
      />
    </div>
  )
}
