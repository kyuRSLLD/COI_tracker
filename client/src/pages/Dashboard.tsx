import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, FileText, Send, Sparkles, FolderPlus, ArrowRight, ShieldCheck, Mail } from 'lucide-react'
import type { Stats, Subcontractor, COI, GCSettings } from '../types'
import { apiStats, apiSubcontractors, apiCOIs, apiSettings, apiEmails } from '../api'
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
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  if (loading || !stats) {
    return <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 text-center text-xs text-slate-400">Loading dashboard…</div>
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      {/* Greeting + quick actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
            {gcSettings?.company_name || 'COI Shield'} · Compliance Command Center
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-0.5">Insurance Dashboard</h1>
          <p className="text-xs text-slate-500 mt-1">
            Track expirations, verify coverage limits, and share verified compliance with clients.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setAddSubModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 transition shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" /> Add subcontractor
          </button>
          <button
            onClick={() => { setRequestSubId(undefined); setRequestModal(true) }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
          >
            <FileText className="w-3.5 h-3.5" /> Request a COI
          </button>
        </div>
      </div>

      {/* Expiration alert banner */}
      <ExpiryBanner upcoming={stats.upcoming} onReminderSent={() => { showToast('Renewal reminder queued (simulated)'); load() }} />

      {/* Stats grid */}
      <StatsGrid stats={stats} />

      {/* Compliance score + quick facts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ComplianceScore scorecard={{ ...stats.totals, pending: stats.totals.pending }} />
        </div>
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-card flex flex-col justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
              Client sharing
            </div>
            <h3 className="text-lg font-bold text-slate-900 mt-1">Privacy-safe client portal</h3>
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">
              When clients view project compliance, all subcontractor phone numbers, emails, contact persons, and addresses are stripped. Verified company names, coverage limits, policy numbers, and expiration dates remain visible — inquiries route back to you.
            </p>
          </div>
          <div className="mt-5 flex items-center justify-between pt-4 border-t border-slate-200 text-xs">
            <span className="text-slate-500">{stats.share_links_count} active share link{stats.share_links_count === 1 ? '' : 's'}</span>
            <Link
              to="/share/rcc-meridian-2026"
              className="inline-flex items-center gap-1 font-bold text-brand-600 hover:text-brand-700"
            >
              Preview client view <ArrowRight className="w-3.5 h-3.5" />
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
                  <button
                    onClick={() => { setReviewCoi(c); setReviewModal(true) }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-sky-600 hover:bg-sky-700 transition"
                  >
                    Review COI
                  </button>
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
            <h3 className="text-lg font-bold text-slate-900">Upcoming policy expirations (next 60 days)</h3>
            <p className="text-xs text-slate-500">Track countdowns and send renewal reminders before coverage lapses.</p>
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
                        <button
                          onClick={async () => {
                            await apiEmails.sendReminder(u.coi_id)
                            showToast(`Reminder queued for ${u.company_name} (simulated)`)
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-amber-950 bg-amber-50 border border-amber-300 hover:bg-amber-100 transition"
                        >
                          <Send className="w-3 h-3" /> Remind
                        </button>
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
        <h3 className="text-lg font-bold text-slate-900">Compliance by trade</h3>
        <p className="text-xs text-slate-500 mb-4">Identify which trades carry the most insurance risk on your projects.</p>
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
