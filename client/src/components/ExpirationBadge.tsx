import type { ComplianceStatus } from '../types'
import { CheckCircle2, AlertTriangle, XCircle, Clock, HelpCircle, FileQuestion, Ban } from 'lucide-react'

interface Props {
  status?: ComplianceStatus | string
  daysLeft?: number | null
  size?: 'sm' | 'md'
  showCountdown?: boolean
}

export function ExpirationBadge({ status, daysLeft, size = 'md', showCountdown = true }: Props) {
  const norm = (status || 'missing') as ComplianceStatus
  const isSm = size === 'sm'

  let icon = <HelpCircle className={isSm ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
  let label = 'No COI on file'
  let cls = 'bg-slate-100 text-slate-700 border-slate-200'

  if (norm === 'compliant') {
    icon = <CheckCircle2 className={isSm ? 'w-3 h-3 text-emerald-600' : 'w-3.5 h-3.5 text-emerald-600'} />
    label = daysLeft !== null && daysLeft !== undefined && showCountdown
      ? `Compliant · ${daysLeft}d left`
      : 'Compliant'
    cls = 'bg-emerald-50 text-emerald-800 border-emerald-200'
  } else if (norm === 'expiring_soon') {
    icon = <AlertTriangle className={isSm ? 'w-3 h-3 text-amber-600' : 'w-3.5 h-3.5 text-amber-600'} />
    label = daysLeft !== null && daysLeft !== undefined && showCountdown
      ? (daysLeft === 0 ? 'Expires today' : daysLeft === 1 ? 'Expires in 1 day' : `Expires in ${daysLeft} days`)
      : 'Expiring soon'
    cls = 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse'
  } else if (norm === 'expired') {
    icon = <XCircle className={isSm ? 'w-3 h-3 text-rose-600' : 'w-3.5 h-3.5 text-rose-600'} />
    const days = daysLeft !== null && daysLeft !== undefined ? Math.abs(daysLeft) : null
    label = days !== null && showCountdown
      ? (days === 0 ? 'Expired today' : `Expired ${days}d ago`)
      : 'Expired'
    cls = 'bg-rose-50 text-rose-800 border-rose-300 font-semibold'
  } else if (norm === 'pending_review') {
    icon = <Clock className={isSm ? 'w-3 h-3 text-sky-600' : 'w-3.5 h-3.5 text-sky-600'} />
    label = 'Pending review'
    cls = 'bg-sky-50 text-sky-800 border-sky-200'
  } else if (norm === 'needs_revision') {
    icon = <FileQuestion className={isSm ? 'w-3 h-3 text-orange-600' : 'w-3.5 h-3.5 text-orange-600'} />
    label = 'Needs revision'
    cls = 'bg-orange-50 text-orange-800 border-orange-300'
  } else if (norm === 'rejected') {
    icon = <Ban className={isSm ? 'w-3 h-3 text-red-600' : 'w-3.5 h-3.5 text-red-600'} />
    label = 'Rejected'
    cls = 'bg-red-50 text-red-800 border-red-300'
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium ${
        isSm ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'
      } ${cls}`}
    >
      {icon}
      {label}
    </span>
  )
}
