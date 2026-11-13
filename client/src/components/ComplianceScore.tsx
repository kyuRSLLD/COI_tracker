import type { Scorecard } from '../types'
import { Button } from './Button'

interface Props {
  scorecard: Scorecard
  title?: string
  subtitle?: string
  onAddSub?: () => void
}

export function ComplianceScore({ scorecard, title = 'Compliance', subtitle = 'Across all assigned subcontractors', onAddSub }: Props) {
  const score = Math.max(0, Math.min(100, scorecard.score))
  const total = scorecard.total || 0
  const compliant = scorecard.compliant || 0
  const expiring = scorecard.expiring || 0
  const expired = scorecard.expired || 0
  const missing = scorecard.missing || 0
  const pending = scorecard.pending || 0

  const color = score >= 90 ? '#10b981' : score >= 70 ? '#f59e0b' : '#ef4444'

  const size = 150
  const stroke = 12
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ

  return (
    <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-card flex flex-col sm:flex-row items-center gap-6">
      {total === 0 ? (
        <div className="flex flex-col items-center justify-center text-center w-full py-2">
          <p className="text-sm font-semibold text-slate-700">No subcontractors yet</p>
          <p className="text-xs text-slate-400 mt-1 max-w-xs">Add your first subcontractor to start tracking COIs and compliance.</p>
          {onAddSub && (
            <Button
              type="button"
              variant="primary"
              onClick={onAddSub}
              className="mt-4"
            >
              Add subcontractor
            </Button>
          )}
        </div>
      ) : (
      <>
      <div className="relative flex items-center justify-center shrink-0">
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} stroke="#e2e8f0" strokeWidth={stroke} fill="none" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            fill="none"
            className="transition-all duration-700 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-4xl font-extrabold tracking-tight text-slate-900 font-['JetBrains_Mono']">{score}%</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">compliant</span>
        </div>
      </div>

      <div className="flex-1 w-full text-center sm:text-left">
        <h3 className="text-lg font-bold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>

        {/* segmented bar */}
        {total > 0 && (
          <div className="mt-4 flex h-2.5 rounded-full overflow-hidden bg-slate-100">
            <div style={{ width: `${(compliant / total) * 100}%` }} className="bg-emerald-500" title="Compliant" />
            <div style={{ width: `${(expiring / total) * 100}%` }} className="bg-amber-400" title="Expiring soon" />
            <div style={{ width: `${(expired / total) * 100}%` }} className="bg-rose-500" title="Expired" />
            <div style={{ width: `${(missing / total) * 100}%` }} className="bg-slate-400" title="Missing" />
            <div style={{ width: `${(pending / total) * 100}%` }} className="bg-sky-400" title="Pending review" />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />{compliant} compliant</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400" />{expiring} expiring soon</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500" />{expired} expired</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-slate-400" />{missing} missing</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-sky-400" />{pending} pending</span>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
