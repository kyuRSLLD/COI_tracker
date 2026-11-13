import { Button } from '../components/Button'
import { useState } from 'react'
import { X, Copy, Check, Lock, ExternalLink, ShieldAlert } from 'lucide-react'
import type { Project } from '../types'
import { apiProjects } from '../api'

interface Props {
  project: Project | null
  open: boolean
  onClose: () => void
  onCreated: () => void
}

export function ShareModal({ project, open, onClose, onCreated }: Props) {
  const [days, setDays] = useState('0')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [share, setShare] = useState<{ url: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)

  if (!open || !project) return null

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await apiProjects.createShare(project.id, {
        expires_in_days: Number(days),
        note: note || undefined,
      })
      const fullUrl = `${window.location.origin}${res.url}`
      setShare({ url: fullUrl, token: res.share.token })
      onCreated()
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!share) return
    await navigator.clipboard.writeText(share.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-200">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-bold text-brand-600 uppercase tracking-wider font-['JetBrains_Mono']">
              <Lock className="w-3.5 h-3.5" /> Client-safe sharing
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 mt-1">Share {project.name}</h2>
            <p className="text-xs text-slate-500 mt-1">
              Create a read-only live compliance link to send to the project owner or client.
            </p>
          </div>
          <button onClick={onClose} className="w-11 h-11 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Privacy guarantee banner */}
        <div className="mt-4 p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-950 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Built-in privacy protection</div>
            <div className="text-[11px] text-emerald-900/80 mt-0.5">
              Subcontractor phone numbers, emails, contact persons, and addresses are completely stripped from this view — both in the UI and the API response. Clients see verified company names, coverage limits, policy numbers, and expiration dates only. All inquiries route back to you.
            </div>
          </div>
        </div>

        <form onSubmit={handleCreate} className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Link expiration</label>
            <select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="0">Never expires (demo)</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Internal note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Q3 2026 client meeting link"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading}
            >
              {loading ? 'Creating…' : 'Generate client link'}
            </Button>
          </div>
        </form>

        {share && (
          <div className="mt-5 p-4 rounded-2xl bg-brand-50 border border-brand-200">
            <div className="text-xs font-bold text-brand-900">Live client share link:</div>
            <div className="mt-2 flex items-center gap-2">
              <input
                readOnly
                value={share.url}
                className="flex-1 text-xs font-['JetBrains_Mono'] bg-white border border-brand-200 rounded-lg px-2.5 py-1.5 truncate text-slate-700 select-all"
              />
              <Button
                type="button"
                variant="primary"
                onClick={copy}
                className="shrink-0"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <a
                href={share.url}
                target="_blank"
                rel="noreferrer"
                title="Preview client view"
                className="shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-lg text-brand-700 hover:bg-brand-100 transition"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
