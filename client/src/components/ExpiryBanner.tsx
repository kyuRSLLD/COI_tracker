import { useState } from 'react'
import { AlertTriangle, Send, Check, ChevronDown, ChevronUp } from 'lucide-react'
import { apiEmails } from '../api'

interface Props {
  upcoming: Array<{
    sub_id: string
    company_name: string
    trade: string
    carrier: string
    expiration_date: string
    days_left: number
    status: string
    coi_id: string
    email?: string | null
  }>
  onReminderSent?: () => void
}

export function ExpiryBanner({ upcoming, onReminderSent }: Props) {
  const [open, setOpen] = useState(false)
  const [batching, setBatching] = useState(false)
  const [sentMap, setSentMap] = useState<Record<string, boolean>>({})

  const expiringSoon = upcoming.filter((u) => u.days_left >= 0 && u.days_left <= 30)
  const expired = upcoming.filter((u) => u.days_left < 0)

  if (expiringSoon.length === 0 && expired.length === 0) return null

  const handleRemindAll = async () => {
    setBatching(true)
    try {
      await apiEmails.batchReminders()
      onReminderSent && onReminderSent()
    } finally {
      setBatching(false)
    }
  }

  const handleRemindOne = async (coiId: string) => {
    await apiEmails.sendReminder(coiId)
    setSentMap((m) => ({ ...m, [coiId]: true }))
    onReminderSent && onReminderSent()
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg bg-amber-400 text-amber-950 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4" />
          </span>
          <div>
            <div className="text-sm font-bold text-amber-950">
              {expired.length > 0 && <span className="text-rose-700 font-extrabold">{expired.length} expired</span>}
              {expired.length > 0 && expiringSoon.length > 0 && ' · '}
              {expiringSoon.length > 0 && <span>{expiringSoon.length} expire within 30 days</span>}
            </div>
            <p className="text-xs text-amber-900/80 mt-0.5 font-mono text-[11px]">
              renewal reminders queued automatically on the expiration window
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
          <button
            onClick={handleRemindAll}
            disabled={batching}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 transition shadow-sm"
          >
            <Send className="w-3.5 h-3.5" />
            {batching ? 'Sending…' : 'Remind all'}
          </button>
          <button
            onClick={() => setOpen((o) => !o)}
            className="p-1.5 rounded-lg text-amber-900 hover:bg-amber-100 transition"
            title="Expand list"
          >
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-amber-200/80 divide-y divide-amber-200/60 text-xs">
          {upcoming.slice(0, 8).map((u) => {
            const isExp = u.days_left < 0
            const done = sentMap[u.coi_id]
            return (
              <div key={u.coi_id} className="py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-semibold text-slate-900">{u.company_name}</span>
                  <span className="text-slate-400"> · {u.trade}</span>
                  <span className="text-slate-500"> — {u.carrier} exp. {u.expiration_date}</span>
                  <span className={`ml-2 font-bold ${isExp ? 'text-rose-700' : 'text-amber-800'}`}>
                    {isExp ? `expired ${Math.abs(u.days_left)}d ago` : `in ${u.days_left}d`}
                  </span>
                </div>
                <button
                  onClick={() => handleRemindOne(u.coi_id)}
                  disabled={done}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-white border border-amber-300 text-amber-950 hover:bg-amber-100 disabled:opacity-60 transition"
                >
                  {done ? <Check className="w-3 h-3 text-emerald-600" /> : <Send className="w-3 h-3" />}
                  {done ? 'Sent' : 'Remind'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
