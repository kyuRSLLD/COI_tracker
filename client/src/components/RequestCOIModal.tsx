import { useState } from 'react'
import { X, Copy, Check, Send } from 'lucide-react'
import type { Subcontractor } from '../types'
import { apiEmails } from '../api'

interface Props {
  subcontractors: Subcontractor[]
  open: boolean
  onClose: () => void
  initialSubId?: string
  onSuccess?: () => void
}

export function RequestCOIModal({ subcontractors, open, onClose, initialSubId, onSuccess }: Props) {
  const [subId, setSubId] = useState(initialSubId || (subcontractors[0]?.id ?? ''))
  const [message, setMessage] = useState('')
  const [days, setDays] = useState('30')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{ portalUrl: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!open) return null

  const sub = subcontractors.find((s) => s.id === (subId || initialSubId))

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!subId) return
    setLoading(true)
    try {
      const res = await apiEmails.sendRequest({
        subcontractor_id: subId,
        custom_message: message || undefined,
        expires_in_days: Number(days),
      })
      setResult({ portalUrl: res.portalUrl, token: res.token })
      onSuccess && onSuccess()
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!result) return
    await navigator.clipboard.writeText(result.portalUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Send className="w-3.5 h-3.5" /> Self-service upload
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-1">Request a COI from a Subcontractor</h2>
            <p className="text-xs text-slate-500 mt-1">
              Generates a secure, personalized upload link. The subcontractor opens it, fills in their policy info, and attaches the certificate — no account required.
            </p>
            <p className="text-xs text-amber-800 mt-2">
              Email delivery is not configured. After generating the link, copy and share it manually with the subcontractor.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSend} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Subcontractor</label>
            <select
              value={subId}
              onChange={(e) => { setSubId(e.target.value); setResult(null) }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {subcontractors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.company_name} — {s.trade}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Link expires in</label>
            <select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Custom note (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="e.g. Please provide your renewed COI before mobilization on June 15."
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="text-[11px] text-slate-500 mt-1">Include this note when you share the link manually.</p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !subId}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-60 transition shadow-sm"
            >
              <Send className="w-3.5 h-3.5" />
              {loading ? 'Creating…' : 'Generate Request Link'}
            </button>
          </div>
        </form>

        {result && (
          <div className="mt-5 p-4 rounded-2xl bg-brand-50 border border-brand-200">
            <div className="text-xs font-bold text-brand-900">Your magic upload link is ready:</div>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={result.portalUrl}
                className="flex-1 text-xs font-['JetBrains_Mono'] bg-white border border-brand-200 rounded-lg px-2.5 py-1.5 truncate text-slate-700 select-all"
              />
              <button
                type="button"
                onClick={copy}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 hover:bg-brand-700 text-white transition"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="text-[11px] text-brand-800/80 mt-2">
              Copy and text or email this link to {sub?.company_name} yourself. No email was sent.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
