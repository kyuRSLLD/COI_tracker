import { useEffect, useState, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { apiAdmin } from '../api'
import { StaffSidebar } from '../components/StaffSidebar'
import { Button } from '../components/Button'
import { ChevronLeft, ZoomIn, ZoomOut, ExternalLink, CheckCircle2, AlertTriangle, XCircle, Mail, Phone, Sparkles } from 'lucide-react'

interface Check {
  name: string
  value: string
  result: 'pass' | 'warn' | 'fail'
}

const RESULT_CHIP: Record<Check['result'], { bg: string; text: string; label: string }> = {
  pass: { bg: 'bg-emerald-50 text-emerald-800 border border-emerald-200', text: 'text-emerald-700', label: 'Pass' },
  warn: { bg: 'bg-amber-50 text-amber-800 border border-amber-200', text: 'text-amber-700', label: 'Warn' },
  fail: { bg: 'bg-rose-50 text-rose-800 border border-rose-200', text: 'text-rose-700', label: 'Fail' },
}

export function AdminCoiReviewPage() {
  const { coiId } = useParams<{ coiId: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<{ coi: any; extracted: any; certUrl: string | null; checks: Check[]; score: number } | null>(null)
  const [queue, setQueue] = useState<Array<{ id: string; sub_company_name: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [ladder, setLadder] = useState<{ emailSent?: boolean }>({})

  const load = useCallback(async () => {
    if (!coiId) return
    setLoading(true)
    setError(null)
    try {
      const [rev, q] = await Promise.all([
        apiAdmin.coiReview(coiId),
        apiAdmin.coiQueue({ filter: 'pending', limit: 200 }),
      ])
      setData(rev)
      setQueue(q.items.map((i) => ({ id: i.id, sub_company_name: i.sub_company_name || '—' })))
      const verdict = defaultVerdict(rev)
      setNote(verdict)
    } catch (err: any) {
      setError(err?.message || 'Could not load review')
    } finally {
      setLoading(false)
    }
  }, [coiId])

  useEffect(() => { load() }, [load])

  const pendingIds = useMemo(() => queue.map((x) => x.id), [queue])
  const idx = pendingIds.indexOf(coiId || '')
  const nextId = pendingIds[(idx + 1) % pendingIds.length] || null
  const goNext = () => nextId && navigate(`/staff/coi/${nextId}`)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); goNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext])

  const decide = async (decision: 'compliant' | 'needs_revision' | 'rejected') => {
    if (!coiId) return
    setSaving(true)
    try {
      await apiAdmin.coiDecision(coiId, decision, note || undefined)
      if (nextId && nextId !== coiId) navigate(`/staff/coi/${nextId}`)
      else navigate('/staff')
    } catch (err: any) {
      setError(err?.message || 'Could not save decision')
    } finally {
      setSaving(false)
    }
  }

  const coi = data?.coi
  const fails = data?.checks.filter((c) => c.result === 'fail').length ?? 0
  const score = data?.score ?? 0

  return (
    <StaffSidebar user={null} onSignOut={() => { localStorage.removeItem('token'); window.location.href = '/login' }} pendingQueueCount={pendingIds.length}>

      <main className="flex-1 p-4 sm:p-6 lg:p-8 space-y-4 max-w-[1500px]">
        {/* Breadcrumb + queue position */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Link to="/staff" className="hover:text-ink inline-flex items-center gap-1 font-medium">
              <ChevronLeft className="w-4 h-4" /> COI queue
            </Link>
            <span>/</span>
            <span className="font-semibold text-ink">{coi?.sub_company_name || 'Loading…'}</span>
            {coi && (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                fails > 0 ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-800'
              }`}>
                {fails > 0 ? `Failed · ${fails} check${fails > 1 ? 's' : ''}` : 'Needs review'}
              </span>
            )}
          </div>
          {pendingIds.length > 0 && (
            <div className="text-xs text-slate-500 flex items-center gap-3">
              <span>{Math.max(1, idx + 1)} of {pendingIds.length} waiting</span>
              <button
                onClick={goNext}
                className="hover:text-ink font-medium underline-offset-2 hover:underline"
                title="Keyboard shortcut J"
              >
                J next
              </button>
            </div>
          )}
        </div>

        {loading && <div className="p-8 text-sm text-slate-500">Loading certificate…</div>}
        {error && <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800">{error}</div>}

        {data && coi && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* LEFT: certificate viewer */}
            <section className="lg:col-span-7 bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Uploaded certificate</p>
                <div className="flex items-center gap-1">
                  <button onClick={() => setZoom((z) => Math.max(0.6, +(z - 0.15).toFixed(2)))} className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
                  <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.15).toFixed(2)))} className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
                  {data.certUrl && (
                    <a href={data.certUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-slate-700 hover:text-ink inline-flex items-center gap-1 ml-2">
                      Open PDF <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              </div>

              <div className="relative overflow-auto max-h-[820px] rounded-lg bg-slate-50 border border-slate-100 flex items-start justify-center p-2">
                {data.certUrl ? (
                  coi.certificate_mime === 'application/pdf' ? (
                    <iframe src={data.certUrl} title="certificate" className="w-full h-[800px] border-0" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }} />
                  ) : (
                    <div className="relative inline-block" style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
                      <img src={data.certUrl} alt="certificate" className="max-w-full rounded shadow" />
                      {/* overlay highlighting insurer section when holding company */}
                      {coi.carrier && (/cna financial|travelers companies|hartford financial|nationwide mutual insurance co|berkshire hathaway/i.test(coi.carrier)) && (
                        <div className="absolute top-[3%] left-[2%] right-[52%] h-[12%] rounded-md border-2 border-rose-500 bg-rose-500/10 pointer-events-none">
                          <span className="absolute -top-3 left-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-rose-600 text-white shadow">
                            Parent company, not issuing insurer
                          </span>
                        </div>
                      )}
                    </div>
                  )
                ) : (
                  <p className="text-sm text-slate-400 py-20">No file uploaded for this certificate</p>
                )}
              </div>
            </section>

            {/* RIGHT: verdict + checks + ladder + decision */}
            <section className="lg:col-span-5 space-y-4">
              {/* Score badge + verdict */}
              <div className={`p-4 rounded-xl border flex items-start gap-4 ${
                score < 60
                  ? 'bg-rose-50/70 border-rose-200'
                  : score < 90
                  ? 'bg-amber-50/70 border-amber-200'
                  : 'bg-emerald-50/70 border-emerald-200'
              }`}>
                <div className={`w-14 h-14 rounded-full flex items-center justify-center font-display font-bold text-xl text-white shrink-0 ${
                  score < 60 ? 'bg-rose-600' : score < 90 ? 'bg-amber-600' : 'bg-emerald-600'
                }`}>
                  {score}
                </div>
                <div className="text-sm">
                  <p className="font-semibold text-ink">{verdictTitle(data)}</p>
                  <p className="text-slate-600 mt-1">{verdictParagraph(data)}</p>
                </div>
              </div>

              {/* Automated checks */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Automated checks</p>
                <div className="divide-y divide-slate-100 text-xs">
                  {data.checks.map((c, i) => {
                    const chip = RESULT_CHIP[c.result]
                    return (
                      <div key={i} className="py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-700">{c.name}</p>
                          <p className="text-[11px] text-slate-500 truncate">{c.value}</p>
                        </div>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${chip.bg}`}>
                          {chip.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Verification ladder */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3">
                <p className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Verification ladder</p>
                <ol className="space-y-2 text-xs">
                  <li className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0 ${fails > 0 ? 'bg-rose-600' : 'bg-emerald-600'}`}>
                      {fails > 0 ? <XCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    </span>
                    <span className="flex-1 font-medium text-slate-700">Digital checks</span>
                    <span className="text-[11px] text-slate-500">{fails > 0 ? `${fails} failed` : 'passed'}</span>
                  </li>
                  <li className="flex items-center gap-3">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${ladder.emailSent ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'}`}>
                      2
                    </span>
                    <span className="flex-1">
                      <span className="font-medium text-slate-700">Email agent</span>
                      {data.extracted?.producer?.name && (
                        <span className="text-[11px] text-slate-500 block truncate">{data.extracted.producer.name}</span>
                      )}
                    </span>
                    <button
                      onClick={() => setLadder((l) => ({ ...l, emailSent: true }))}
                      disabled={ladder.emailSent}
                      className="text-[11px] font-medium px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-60 inline-flex items-center gap-1"
                    >
                      <Mail className="w-3 h-3" /> {ladder.emailSent ? 'Sent' : 'Send now'}
                    </button>
                  </li>
                  <li className="flex items-center gap-3 opacity-60">
                    <span className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-[11px] font-bold shrink-0">3</span>
                    <span className="flex-1 text-slate-600 font-medium">AI call to agent</span>
                    <span className="text-[11px] text-slate-500">after 7 days · planned</span>
                  </li>
                  <li className="flex items-center gap-3 opacity-60">
                    <span className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-[11px] font-bold shrink-0">4</span>
                    <span className="flex-1 text-slate-600 font-medium">AI call to insurer</span>
                    <span className="text-[11px] text-slate-500">planned</span>
                  </li>
                </ol>
              </div>

              {/* Extracted fields */}
              {data?.extracted && (
                <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                    <span className="text-[11px] uppercase tracking-wider font-semibold text-slate-400">Extracted data (all fields)</span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      (coi?.review_source || data.extracted?.source || 'ocr') === 'manual'
                        ? 'bg-slate-100 text-slate-700'
                        : 'bg-amber-100 text-amber-900'
                    }`}>
                      {(coi?.review_source || data.extracted?.source || 'ocr') === 'manual' ? 'manual review' : 'AI extraction · pending validation'}
                    </span>
                  </div>
                  {/* Producer */}
                  {(data.extracted.producer?.name || data.extracted.producer?.phone || data.extracted.producer?.email || data.extracted.producer?.address) && (
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Producer / Agent</div>
                      {data.extracted.producer?.name && <div className="font-semibold text-slate-900">{data.extracted.producer.name}</div>}
                      <div className="flex flex-wrap gap-3 text-slate-600 text-[11px]">
                        {data.extracted.producer?.phone && <a href={`tel:${data.extracted.producer.phone}`} className="hover:text-ink">{data.extracted.producer.phone}</a>}
                        {data.extracted.producer?.email && <a href={`mailto:${data.extracted.producer.email}`} className="hover:text-ink">{data.extracted.producer.email}</a>}
                      </div>
                      {data.extracted.producer?.address && <div className="text-[11px] text-slate-500">{data.extracted.producer.address}</div>}
                    </div>
                  )}
                  {/* Insured */}
                  {(data.extracted.insured?.name || data.extracted.insured?.address) && (
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 space-y-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Insured</div>
                      {data.extracted.insured?.name && <div className="font-semibold text-slate-900">{data.extracted.insured.name}</div>}
                      {data.extracted.insured?.address && <div className="text-[11px] text-slate-500">{data.extracted.insured.address}</div>}
                    </div>
                  )}
                  {/* Insurers affording coverage */}
                  {(() => {
                    const insurers: Array<{ letter?: string; name?: string; naic?: string }> =
                      data.extracted.insurers && Array.isArray(data.extracted.insurers) && data.extracted.insurers.length
                        ? data.extracted.insurers
                        : data.extracted.insurer?.name
                        ? [{ letter: 'A', name: data.extracted.insurer.name, naic: data.extracted.insurer.naic }]
                        : []
                    return insurers.length ? (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 space-y-1.5">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Insurers affording coverage ({insurers.length})</div>
                        <div className="space-y-1">
                          {insurers.map((ins, idx) => (
                            <div key={idx} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="font-medium text-slate-900 truncate">
                                <span className="font-mono text-slate-400 mr-1.5">{ins.letter || '—'}:</span>
                                {ins.name || '—'}
                              </span>
                              <span className="font-mono text-slate-500 shrink-0">{ins.naic ? `NAIC ${ins.naic}` : 'no NAIC'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null
                  })()}
                  {/* Policies & limits */}
                  {(() => {
                    const policies: any[] = Array.isArray(data.extracted.policies) ? data.extracted.policies : []
                    return policies.length ? (
                      <div className="space-y-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Policies & coverage limits ({policies.length})</div>
                        <div className="space-y-2">
                          {policies.map((po: any, idx) => {
                            const pn = po.policyNumber || po.policy_number
                            const eff = po.effectiveDate || po.effective_date
                            const exp = po.expirationDate || po.expiration_date
                            const limits: Array<{ name?: string; label?: string; amount?: string | number }> = Array.isArray(po.limits) ? po.limits : []
                            return (
                              <div key={idx} className="p-2.5 rounded-lg border border-slate-200 bg-white space-y-1.5">
                                <div className="flex flex-wrap items-center justify-between gap-1">
                                  <span className="font-semibold text-slate-900 text-[11px]">
                                    {po.insurerLetter ? <span className="font-mono text-slate-400 mr-1">[{po.insurerLetter}]</span> : null}
                                    {po.type || 'Coverage'}
                                  </span>
                                  <span className="font-mono text-[11px] text-slate-500">{pn ? `Pol. ${pn}` : '—'}</span>
                                </div>
                                <div className="text-[10px] text-slate-500 font-mono">
                                  {eff || exp ? `${eff || '—'} → ${exp || '—'}` : 'no dates'}
                                </div>
                                {limits.length > 0 && (
                                  <div className="pt-1 border-t border-slate-100 space-y-0.5">
                                    {limits.map((l, j) => (
                                      <div key={j} className="flex items-center justify-between gap-2 text-[10px]">
                                        <span className="text-slate-600 truncate">{l.name || l.label || `Limit ${j + 1}`}</span>
                                        <span className="font-mono text-slate-900 font-semibold shrink-0">{l.amount != null && l.amount !== '' ? String(l.amount) : '—'}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : null
                  })()}
                  <p className="text-[10px] text-slate-400 italic">
                    Machine-extracted fields for review only — verify against the certificate image before validating.
                  </p>
                </div>
              )}
              {/* Note to subcontractor */}
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-2">
                <label className="text-[11px] uppercase tracking-wider font-semibold text-slate-400 block">
                  Note to subcontractor (sent with decision)
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  className="w-full text-xs rounded-lg border border-slate-300 p-2.5 focus:border-brand-primary focus:outline-none"
                  placeholder="Leave guidance for the subcontractor…"
                />
              </div>

              {/* Decision buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => decide('rejected')}
                    disabled={saving}
                    className="min-h-[44px] px-4 py-2 rounded-lg text-xs font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <Button variant="secondary" onClick={() => decide('needs_revision')} disabled={saving} className="border-amber-400 text-amber-800 hover:bg-amber-50">
                    Request revision
                  </Button>
                </div>
                <Button variant="secondary" onClick={() => decide('compliant')} disabled={saving} className="border-slate-300 text-slate-700 hover:bg-slate-50">
                  Override & approve…
                </Button>
              </div>
            </section>
          </div>
        )}
      </main>
    </StaffSidebar>
  )
}

function verdictTitle(data: any): string {
  const fails = data.checks.filter((c: any) => c.result === 'fail').length
  if (fails > 1) return "Insurers couldn't be verified"
  if (fails === 1) return 'One verification issue found'
  const warns = data.checks.filter((c: any) => c.result === 'warn').length
  if (warns > 0) return 'Needs manual review'
  return 'Certificate looks verified'
}

function verdictParagraph(data: any): string {
  const c = data.checks
  const failNames = c.filter((x: any) => x.result === 'fail').map((x: any) => x.name.toLowerCase())
  if (failNames.length) return `Issues found: ${failNames.join(', ')}. Limits and dates should still be checked manually.`
  const warnNames = c.filter((x: any) => x.result === 'warn').map((x: any) => x.name.toLowerCase())
  if (warnNames.length) return `Heads-up: ${warnNames.join(', ')} could not be fully confirmed.`
  return 'All automated checks passed. Review the image once more and approve.'
}

function defaultVerdict(data: any): string {
  const fails = data.checks.filter((c: any) => c.result === 'fail').length
  if (fails > 0) return "The insurers listed on your certificate couldn't be verified. Please ask your agent for a corrected certificate."
  return ''
}
