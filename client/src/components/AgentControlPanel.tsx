import { useEffect, useState, useMemo } from 'react'
import { apiAgentAdmin, apiAgent } from '../api'
import type { AgentApiKey, AgentConfirmationItem, ConfirmationQueueItem } from '../types'
import { Phone, Mail, Sparkles, Key, CheckCircle2, XCircle, AlertTriangle, Clock, Copy, Check, RefreshCw, Trash2, Send, Plus } from 'lucide-react'

function statusChip(status?: string): { bg: string; label: string } {
  switch (status) {
    case 'verified': return { bg: 'bg-emerald-100 text-emerald-800', label: 'Verified' }
    case 'in_progress': return { bg: 'bg-blue-100 text-blue-800', label: 'In progress' }
    case 'unreachable': return { bg: 'bg-amber-100 text-amber-800', label: 'Unreachable' }
    case 'rejected': return { bg: 'bg-rose-100 text-rose-800', label: 'Rejected' }
    case 'failed': return { bg: 'bg-rose-100 text-rose-800', label: 'Failed' }
    case 'queued': return { bg: 'bg-slate-100 text-slate-700', label: 'Queued' }
    default: return { bg: 'bg-slate-100 text-slate-500', label: '—' }
  }
}

export function AgentControlPanel({ onRefreshMain }: { onRefreshMain?: () => void }) {
  const [tab, setTab] = useState<'queue' | 'keys' | 'activity'>('queue')
  const [keys, setKeys] = useState<AgentApiKey[]>([])
  const [queue, setQueue] = useState<ConfirmationQueueItem[]>([])
  const [stats, setStats] = useState<{ counts: Array<{ status: string; channel: string; c: number }>; recent: Array<AgentConfirmationItem & { carrier?: string | null; sub_company_name?: string | null }> }>({ counts: [], recent: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<{ name: string }>({ name: '' })
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [emailModal, setEmailModal] = useState<{ coiId: string; subName: string; toEmail: string; note: string } | null>(null)
  const [callModal, setCallModal] = useState<{ coiId: string; subName: string; toPhone: string } | null>(null)
  const [resultModal, setResultModal] = useState<{ confirmationId: string; channel: 'call' | 'email'; outcome: 'verified' | 'rejected' | 'unreachable' | 'failed' | 'voicemail'; notes: string; recordingUrl: string } | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [k, q, st] = await Promise.all([
        apiAgentAdmin.keys(),
        apiAgent.queue({ limit: 100 }),
        apiAgentAdmin.stats(),
      ])
      setKeys(k.keys)
      setQueue(q.items)
      setStats(st)
    } catch (err: any) {
      setError(err?.message || 'Failed to load agent panel')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const kpis = useMemo(() => {
    let verified = 0, inProg = 0, failed = 0, total = 0
    for (const c of stats.counts) {
      total += c.c
      if (c.status === 'verified') verified += c.c
      if (c.status === 'in_progress') inProg += c.c
      if (c.status === 'failed' || c.status === 'rejected') failed += c.c
    }
    return { total, verified, inProg, failed }
  }, [stats])

  const filteredQueue = useMemo(() => {
    if (channelFilter === 'all') return queue
    return queue.filter((i) => i.preferred_channel === channelFilter || (channelFilter === 'call' && i.producer_phone) || (channelFilter === 'email' && i.producer_email))
  }, [queue, channelFilter])

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKey.name.trim()) return
    setBusy('createKey')
    setError(null)
    try {
      const res = await apiAgentAdmin.createKey(newKey.name.trim())
      setCreatedKey({ key: res.key.key, name: res.key.name })
      setNewKey({ name: '' })
      await load()
    } catch (err: any) {
      setError(err?.message || 'Could not create key')
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (id: string, name: string) => {
    if (!window.confirm(`Revoke key "${name}"? External agents using this key will immediately be denied access.`)) return
    try {
      await apiAgentAdmin.revokeKey(id)
      await load()
    } catch (err: any) {
      setError(err?.message || 'Could not revoke key')
    }
  }

  const triggerCall = async () => {
    if (!callModal) return
    setBusy('call')
    setError(null)
    try {
      const res = await apiAgent.dispatchCall({ coiId: callModal.coiId, toPhone: callModal.toPhone ? callModal.toPhone.trim() : undefined })
      setCallModal(null)
      await load()
      setResultModal({ confirmationId: res.confirmation.id, channel: 'call', outcome: 'verified', notes: '', recordingUrl: '' })
    } catch (err: any) {
      setError(err?.message || 'Call dispatch failed')
    } finally {
      setBusy(null)
    }
  }

  const triggerEmail = async () => {
    if (!emailModal) return
    setBusy('email')
    setError(null)
    try {
      const res = await apiAgent.sendEmail({
        coiId: emailModal.coiId,
        toEmail: emailModal.toEmail ? emailModal.toEmail.trim() : undefined,
        personalMessage: emailModal.note ? emailModal.note.trim() : undefined,
      })
      setEmailModal(null)
      await load()
      setResultModal({ confirmationId: res.confirmation.id, channel: 'email', outcome: 'verified', notes: '', recordingUrl: '' })
    } catch (err: any) {
      setError(err?.message || 'Email send failed')
    } finally {
      setBusy(null)
    }
  }

  const recordResult = async () => {
    if (!resultModal) return
    setBusy('result')
    try {
      if (resultModal.channel === 'call') {
        await apiAgent.recordCallResult(resultModal.confirmationId, resultModal.outcome, {
          notes: resultModal.notes || undefined,
          recordingUrl: resultModal.recordingUrl || undefined,
        })
      } else {
        await apiAgent.recordEmailResult(resultModal.confirmationId, resultModal.outcome as any, resultModal.notes || undefined)
      }
      setResultModal(null)
      await load()
      onRefreshMain?.()
    } catch (err: any) {
      setError(err?.message || 'Could not record result')
    } finally {
      setBusy(null)
    }
  }

  const copyKey = async (k: string) => {
    try { await navigator.clipboard.writeText(k); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }

  return (
    <section id="outbound-agent" className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            <h2 className="text-base font-bold text-slate-900">Outbound AI agent — COI confirmations</h2>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">AI voice & email agents call the issuing agency or insurance company to confirm the named insured's policies are active — results verify COIs automatically.</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="h-8 px-3 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {error && <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">{error}</div>}

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-100"><p className="text-xl font-bold font-display text-slate-900">{queue.length}</p><p className="text-[11px] text-slate-500">Need confirmation</p></div>
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100"><p className="text-xl font-bold font-display text-emerald-700">{kpis.verified}</p><p className="text-[11px] text-emerald-700">Verified</p></div>
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-100"><p className="text-xl font-bold font-display text-blue-700">{kpis.inProg}</p><p className="text-[11px] text-blue-700">In progress</p></div>
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-100"><p className="text-xl font-bold font-display text-rose-700">{kpis.failed}</p><p className="text-[11px] text-rose-700">Failed / rejected</p></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-200 text-xs">
        {[
          { key: 'queue', label: `Confirmation queue (${queue.length})` },
          { key: 'activity', label: `Recent activity (${stats.recent.length})` },
          { key: 'keys', label: `API keys (${keys.filter((k) => !k.revoked_at).length})` },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key as any)}
            className={`pb-2 px-1 font-semibold border-b-2 -mb-px transition ${tab === t.key ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: QUEUE */}
      {tab === 'queue' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1 text-slate-600">
              <span>Filter:</span>
              {['all', 'call', 'email'].map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setChannelFilter(ch)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize ${channelFilter === ch ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                >
                  {ch === 'all' ? 'All channels' : ch === 'call' ? 'Phone ready' : 'Email ready'}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-slate-400">Agents pull the same queue at <code>GET /api/agent/v1/queue</code></span>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100">
                <tr>
                  <th className="p-3">Subcontractor</th>
                  <th className="p-3">Carrier / Expires</th>
                  <th className="p-3">Agency contact</th>
                  <th className="p-3">Channel</th>
                  <th className="p-3">Last attempt</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredQueue.length === 0 ? (
                  <tr><td colSpan={6} className="p-6 text-center text-slate-400">No COIs waiting for confirmation.</td></tr>
                ) : filteredQueue.map((item) => {
                  const last = item.last_confirmation
                  const lastChip = statusChip(last?.status)
                  return (
                    <tr key={item.coi_id} className="hover:bg-slate-50/60">
                      <td className="p-3 font-semibold text-slate-900">{item.sub_company_name || '—'}</td>
                      <td className="p-3 text-slate-700">{item.carrier || '—'}<span className="block text-[11px] text-slate-400">{item.expiration_date ? `Expires ${item.expiration_date}` : 'no expiration'}</span></td>
                      <td className="p-3 font-mono text-[11px] text-slate-600">
                        {item.producer_phone && <span className="block">{item.producer_phone}</span>}
                        {item.producer_email && <span className="block truncate max-w-[200px] text-slate-500">{item.producer_email}</span>}
                        {!item.producer_phone && !item.producer_email && <span className="text-slate-400">no agency contact</span>}
                      </td>
                      <td className="p-3">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                          item.preferred_channel === 'call' ? 'bg-blue-100 text-blue-800' :
                          item.preferred_channel === 'email' ? 'bg-indigo-100 text-indigo-800' :
                          item.preferred_channel === 'both' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {item.preferred_channel}
                        </span>
                      </td>
                      <td className="p-3">
                        {last ? (
                          <div className="space-y-0.5">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${lastChip.bg}`}>{lastChip.label}</span>
                            <span className="block text-[11px] text-slate-400">{last.channel} · {last.created_at?.slice(0, 10)}</span>
                          </div>
                        ) : <span className="text-slate-400 text-[11px]">not yet</span>}
                      </td>
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setCallModal({ coiId: item.coi_id, subName: item.sub_company_name || 'COI', toPhone: item.producer_phone || '' })}
                            title={item.producer_phone ? 'Start outbound AI phone confirmation' : 'No agency phone — you can supply one'}
                            className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center gap-1 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          >
                            <Phone className="w-3 h-3 text-blue-600" /> Call
                          </button>
                          <button
                            type="button"
                            onClick={() => setEmailModal({ coiId: item.coi_id, subName: item.sub_company_name || 'COI', toEmail: item.producer_email || '', note: '' })}
                            title={item.producer_email ? 'Send confirmation email to agency' : 'No agency email — you can supply one'}
                            className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center gap-1 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          >
                            <Mail className="w-3 h-3 text-indigo-600" /> Email
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab: ACTIVITY */}
      {tab === 'activity' && (
        <div className="space-y-2">
          {stats.recent.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-400">No confirmation activity yet. Start a call or email from the queue.</p>
          ) : stats.recent.map((c) => {
            const chip = statusChip(c.status)
            return (
              <div key={c.id} className="p-3 rounded-lg border border-slate-100 hover:bg-slate-50 text-xs flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${c.channel === 'call' ? 'bg-blue-100 text-blue-700' : 'bg-indigo-100 text-indigo-700'}`}>
                    {c.channel === 'call' ? <Phone className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 truncate">{c.sub_company_name || 'COI'} · <span className="text-slate-500 font-normal">{c.carrier || 'carrier'}</span></p>
                    <p className="text-[11px] text-slate-500 truncate">to {c.recipient || '—'} · via {c.created_by || 'agent'} · {c.created_at?.slice(0, 16).replace('T', ' ')}</p>
                    {c.result_notes && <p className="text-[11px] text-slate-700 italic mt-0.5 truncate max-w-xl">“{c.result_notes}”</p>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${chip.bg}`}>{chip.label}</span>
                  {c.recording_url && (
                    <a href={c.recording_url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-indigo-600 hover:underline">
                      Recording
                    </a>
                  )}
                  {c.status === 'in_progress' && (
                    <button
                      type="button"
                      onClick={() => setResultModal({ confirmationId: c.id, channel: c.channel, outcome: 'verified', notes: '', recordingUrl: '' })}
                      className="text-[11px] font-medium text-slate-700 hover:text-indigo-600 underline"
                    >
                      Record result
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Tab: API KEYS */}
      {tab === 'keys' && (
        <div className="space-y-4 text-xs">
          <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-950 flex items-start gap-2">
            <Key className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Admin-only access control</p>
              <p className="text-[11px] text-indigo-900 mt-0.5">Only admins can issue and revoke agent API keys. External voice/email agents use these keys to fetch confirmation briefs, dispatch calls, send emails, and report results — no human in the loop required.</p>
            </div>
          </div>

          <form onSubmit={createKey} className="flex flex-wrap items-end gap-2 p-3 rounded-lg bg-slate-50 border border-slate-100">
            <div className="flex-1 min-w-[200px]">
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Create new agent key</label>
              <input
                type="text"
                placeholder="e.g. elevenlabs-voice-agent, n8n-email-agent"
                value={newKey.name}
                onChange={(e) => setNewKey({ name: e.target.value })}
                className="w-full text-xs rounded-md border border-slate-300 px-2.5 py-1.5 bg-white focus:outline-none focus:border-indigo-600"
              />
            </div>
            <button
              type="submit"
              disabled={busy === 'createKey' || !newKey.name.trim()}
              className="h-8 px-3 rounded-md text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
            >
              <Plus className="w-3.5 h-3.5" /> Generate key
            </button>
          </form>

          {createdKey && (
            <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
              <p className="font-bold text-emerald-900">Key created for "{createdKey.name}" — copy it now, it won't be shown again</p>
              <div className="flex items-center gap-2 font-mono text-[11px] bg-white p-2 rounded border border-emerald-300 text-emerald-950 select-all overflow-x-auto">
                <span className="flex-1 truncate">{createdKey.key}</span>
                <button
                  type="button"
                  onClick={() => copyKey(createdKey.key)}
                  className="px-2 py-1 rounded bg-emerald-600 text-white font-sans text-xs font-semibold inline-flex items-center gap-1 shrink-0 hover:bg-emerald-700"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] text-emerald-800">Pass this key as <code>X-Agent-Key: sc_xxx</code> or <code>Authorization: Bearer sc_xxx</code> on every request.</p>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-slate-100">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Key prefix</th>
                  <th className="p-3">Scopes</th>
                  <th className="p-3">Last used</th>
                  <th className="p-3">Created</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                {keys.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-slate-400 font-sans text-xs">No keys yet. Generate one above to connect an external AI agent.</td></tr>
                ) : keys.map((k) => (
                  <tr key={k.id} className="hover:bg-slate-50/60 font-sans">
                    <td className="p-3 font-semibold text-slate-900">{k.name}</td>
                    <td className="p-3 font-mono text-slate-600">{k.key_prefix}…</td>
                    <td className="p-3 text-slate-600">{k.scopes}</td>
                    <td className="p-3 text-slate-500">{k.last_used_at ? k.last_used_at.slice(0, 16).replace('T', ' ') : 'never'}</td>
                    <td className="p-3 text-slate-500">{k.created_at.slice(0, 10)}</td>
                    <td className="p-3">
                      {k.revoked_at ? (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-800">revoked</span>
                      ) : (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">active</span>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      {!k.revoked_at && (
                        <button
                          type="button"
                          onClick={() => revoke(k.id, k.name)}
                          className="h-7 px-2 rounded-md text-[11px] font-medium inline-flex items-center gap-1 border border-rose-300 text-rose-700 bg-white hover:bg-rose-50"
                        >
                          <Trash2 className="w-3 h-3" /> Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-3 rounded-lg bg-slate-50 border border-slate-100 space-y-1.5 text-[11px] text-slate-600">
            <p className="font-semibold text-slate-800">API quick reference for external agents:</p>
            <p><a href="/agent-api.md" download className="text-indigo-600 font-semibold hover:underline">Download full API documentation (agent-api.md)</a></p>
            <p><code>GET  /api/agent/v1/queue</code> — pull COIs needing confirmation</p>
            <p><code>GET  /api/agent/v1/brief/:coiId</code> — full dossier (agency contacts, insurer list, policies, questions)</p>
            <p><code>POST /api/agent/v1/calls/dispatch</code> — trigger/record an AI phone confirmation call</p>
            <p><code>POST /api/agent/v1/calls/:id/result</code> — report call outcome (<code>outcome: verified | rejected | unreachable | failed | voicemail</code>)</p>
            <p><code>POST /api/agent/v1/emails/send</code> — send confirmation email to the agency</p>
            <p><code>GET  /api/agent/v1/emails/template/:coiId</code> — preview email template</p>
            <p><code>POST /api/agent/v1/emails/:id/result</code> — report email reply outcome</p>
            <p><code>GET  /api/agent/v1/cois/:coiId/confirmations</code> — confirmation history</p>
            <p><code>POST /api/agent/v1/webhooks/calls</code> — provider call-completed webhook</p>
            <p className="text-slate-500 pt-1">Provider dispatch uses ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID, or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER when set; without them the API acts as an external agent interface.</p>
          </div>
        </div>
      )}

      {/* Call modal */}
      {callModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900">Start AI phone confirmation</h3>
            <p className="text-slate-500">The agent will call the agency, ask verification questions about {callModal.subName}'s policies, and report the outcome.</p>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Agency phone number</label>
              <input
                type="text"
                value={callModal.toPhone}
                onChange={(e) => setCallModal({ ...callModal, toPhone: e.target.value })}
                placeholder="312-555-0100"
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 focus:outline-none focus:border-indigo-600 font-mono text-xs"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setCallModal(null)} className="px-3 py-1.5 rounded-md font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button type="button" disabled={busy === 'call'} onClick={triggerCall} className="px-3 py-1.5 rounded-md font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1">
                <Phone className="w-3.5 h-3.5" /> Start call
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Email modal */}
      {emailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900">Send confirmation email</h3>
            <p className="text-slate-500">Sends the structured confirmation request to the agency for {emailModal.subName}.</p>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Agency email</label>
              <input
                type="email"
                value={emailModal.toEmail}
                onChange={(e) => setEmailModal({ ...emailModal, toEmail: e.target.value })}
                placeholder="agency@example.com"
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 focus:outline-none focus:border-indigo-600 text-xs"
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Optional note from your team</label>
              <textarea
                value={emailModal.note}
                onChange={(e) => setEmailModal({ ...emailModal, note: e.target.value })}
                rows={3}
                placeholder="e.g. Please expedite — crew starts on Tuesday."
                className="w-full rounded-md border border-slate-300 p-2 text-xs focus:outline-none focus:border-indigo-600"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEmailModal(null)} className="px-3 py-1.5 rounded-md font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button type="button" disabled={busy === 'email'} onClick={triggerEmail} className="px-3 py-1.5 rounded-md font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1">
                <Send className="w-3.5 h-3.5" /> Send email
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Record result modal */}
      {resultModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl space-y-3 text-xs">
            <h3 className="text-sm font-bold text-slate-900">Record {resultModal.channel} outcome</h3>
            <p className="text-slate-500">Manual fallback — AI agents post here automatically via API.</p>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Outcome</label>
              <select
                value={resultModal.outcome}
                onChange={(e) => setResultModal({ ...resultModal, outcome: e.target.value as any })}
                className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:border-indigo-600"
              >
                <option value="verified">Verified — policies confirmed</option>
                <option value="rejected">Rejected — cancelled / lapsed / no record</option>
                <option value="unreachable">Unreachable / no answer</option>
                <option value="failed">Failed / wrong number</option>
                {resultModal.channel === 'call' && <option value="voicemail">Voicemail left</option>}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">Notes</label>
              <textarea
                value={resultModal.notes}
                onChange={(e) => setResultModal({ ...resultModal, notes: e.target.value })}
                rows={3}
                placeholder="e.g. Spoke with agency rep Karen; confirmed GL-9 active, exp 12/31/2026."
                className="w-full rounded-md border border-slate-300 p-2 text-xs focus:outline-none focus:border-indigo-600"
              />
            </div>
            {resultModal.channel === 'call' && (
              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">Recording URL (optional)</label>
                <input
                  type="url"
                  value={resultModal.recordingUrl}
                  onChange={(e) => setResultModal({ ...resultModal, recordingUrl: e.target.value })}
                  placeholder="https://..."
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-600"
                />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setResultModal(null)} className="px-3 py-1.5 rounded-md font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button type="button" disabled={busy === 'result'} onClick={recordResult} className="px-3 py-1.5 rounded-md font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">Save outcome</button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
