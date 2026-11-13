import { useState, useEffect } from 'react'
import { Mail, Search, Send, Check } from 'lucide-react'
import type { EmailLog } from '../types'
import { Button } from '../components/Button'
import { apiEmails } from '../api'

export function EmailLogPage() {
  const [logs, setLogs] = useState<EmailLog[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (m: string) => {
    setToast(m)
    setTimeout(() => setToast(null), 3000)
  }

  const load = async () => {
    try {
      const res = await apiEmails.logs()
      setLogs(res.logs)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const filtered = logs.filter(
    (l) => l.to_email.toLowerCase().includes(search.toLowerCase()) || l.subject.toLowerCase().includes(search.toLowerCase())
  )

  const handleBatch = async () => {
    const res = await apiEmails.batchReminders()
    showToast(`Batch reminders sent: ${res.sent} simulated emails`)
    load()
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {toast && (
        <div className="fixed bottom-6 right-6 z-40 bg-slate-900 text-white text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-emerald-400" /> {toast}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900">Email log</h1>
          <p className="text-xs text-slate-500 mt-1">Every COI request and expiration reminder sent, with date and recipient.</p>
        </div>
        <Button
          variant="secondary"
          onClick={handleBatch}
          className="self-start sm:self-auto"
        >
          <Send className="w-4 h-4" /> Remind all expiring
        </Button>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by recipient or subject…"
          className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-card overflow-hidden">
        {loading ? (
          <p className="text-center text-xs text-slate-400 py-12">Loading email log…</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-xs text-slate-400 italic py-12">No emails logged yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 text-xs">
            {filtered.map((l) => (
              <div key={l.id} className="p-4 hover:bg-slate-50 transition">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11px] text-slate-400 font-['JetBrains_Mono']">
                  <span>to: {l.to_email}</span>
                  <span>{new Date(l.sent_at).toLocaleString()}</span>
                </div>
                <div className="font-bold text-slate-900 mt-1">{l.subject}</div>
                {l.body && <div className="text-slate-500 text-[11px] mt-1 whitespace-pre-wrap truncate max-h-16">{l.body}</div>}
                <div className="mt-2 flex items-center gap-2 text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">{l.type || 'general'}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">{l.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
