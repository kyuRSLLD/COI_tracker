import type { Stats } from '../types'
import { Users, CheckCircle2, AlertTriangle, XCircle, FileQuestion, Clock } from 'lucide-react'

interface Props {
  stats: Stats
  onFilterClick?: (status: string) => void
}

export function StatsGrid({ stats, onFilterClick }: Props) {
  const t = stats.totals
  const cards = [
    { num: '01', key: 'all', label: 'Total subcontractors', value: t.total, icon: Users, tint: 'bg-slate-100 text-slate-700', sub: 'across all projects' },
    { num: '02', key: 'compliant', label: 'Fully compliant', value: t.compliant, icon: CheckCircle2, tint: 'bg-emerald-100 text-emerald-700', sub: 'active COI verified' },
    { num: '03', key: 'expiring_soon', label: 'Expiring ≤30 days', value: t.expiring, icon: AlertTriangle, tint: 'bg-amber-100 text-amber-700', sub: 'send reminders' },
    { num: '04', key: 'expired', label: 'Expired policies', value: t.expired, icon: XCircle, tint: 'bg-rose-100 text-rose-700', sub: 'stop-work risk' },
    { num: '05', key: 'missing', label: 'Missing COI', value: t.missing, icon: FileQuestion, tint: 'bg-slate-100 text-slate-600', sub: 'no certificate on file' },
    { num: '06', key: 'pending_review', label: 'Pending GC review', value: t.pending, icon: Clock, tint: 'bg-sky-100 text-sky-700', sub: 'submitted, await review' },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c) => {
        const Icon = c.icon
        const clickable = Boolean(onFilterClick)
        return (
          <button
            key={c.num}
            type="button"
            onClick={() => onFilterClick && onFilterClick(c.key)}
            className={`text-left bg-white rounded-2xl p-4 border border-slate-200 shadow-card transition-all ${
              clickable ? 'hover:shadow-card-hover hover:-translate-y-0.5 cursor-pointer' : ''
            }`}
          >
            <div className="flex items-center justify-between text-xs text-slate-400 font-['JetBrains_Mono']">
              <span className="text-[10px] uppercase tracking-wider">{c.key === 'all' ? 'total' : c.key.replace('_', ' ')}</span>
              <span className={`w-6 h-6 rounded-md flex items-center justify-center ${c.tint}`}>
                <Icon className="w-3.5 h-3.5" />
              </span>
            </div>
            <div className="mt-2 text-2xl font-extrabold text-slate-900 tracking-tight font-['JetBrains_Mono']">
              {c.value}
            </div>
            <div className="mt-1 text-xs font-semibold text-slate-700 leading-snug">{c.label}</div>
            <div className="text-[11px] text-slate-400 mt-0.5 truncate">{c.sub}</div>
          </button>
        )
      })}
    </div>
  )
}
