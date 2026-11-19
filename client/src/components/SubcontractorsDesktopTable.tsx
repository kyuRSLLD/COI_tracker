import { useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import {
  X,
  Search,
  Phone,
  Mail,
  MapPin,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  FileText,
  Upload,
  Eye,
  ShieldCheck,
  Calendar,
  Building2,
  AlertCircle,
} from 'lucide-react'
import type { Subcontractor } from '../types'
import { formatDisplayDate } from '../lib/date'
import { ExpirationBadge } from './ExpirationBadge'
import { viewCertificate } from '../lib/certificateFile'

interface Props {
  open: boolean
  subs: Subcontractor[]
  onClose: () => void
  onRequestCOI?: (subId?: string) => void
  onUploadCOI?: () => void
}

function coverageTypes(s: Subcontractor): string[] {
  const fromCoverages = (s.cois || []).flatMap((c) => (c.coverages || []).map((cv) => cv.type))
  const fromTrade = s.trade ? [s.trade] : []
  const all = Array.from(new Set([...fromCoverages, ...fromTrade].filter(Boolean)))
  return all
}

function bestExpiration(s: Subcontractor): string | null {
  const dates = (s.cois || []).map((c) => c.expiration_date).filter(Boolean) as string[]
  if (dates.length > 0) dates.sort((a, b) => (a < b ? 1 : -1))
  return dates[0] || s.best_coi?.expiration_date || null
}

function insuringCompany(s: Subcontractor): { carrier?: string | null; amBest?: string | null } {
  return { carrier: s.best_coi?.carrier, amBest: s.best_coi?.am_best_rating }
}

export function SubcontractorsDesktopTable({ open, subs = [], onClose, onRequestCOI, onUploadCOI }: Props) {
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const list = subs.filter((s) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      (s.company_name || '').toLowerCase().includes(q) ||
      (s.trade || '').toLowerCase().includes(q) ||
      (s.contact_person || '').toLowerCase().includes(q) ||
      (s.best_coi?.carrier || '').toLowerCase().includes(q) ||
      (s.cois || []).some((c) =>
        (c.coverages || []).some((cv) => (cv.type || '').toLowerCase().includes(q)),
      )
    )
  })

  if (!open) return null

  return (
    <div
      className="hidden md:block bg-white rounded-2xl border border-slate-200 shadow-card p-5 space-y-4"
      data-testid="total-subcontractors-table"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 font-['JetBrains_Mono']">
            KPI drill-down
          </div>
          <h2 className="text-lg font-bold text-slate-900 mt-0.5">
            Total subcontractors{' '}
            <span className="ml-1 text-xs font-semibold font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
              {list.length}
            </span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Name, policy type, expiration date, and insuring company for every connected subcontractor — click any
            row to expand full details.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          aria-label="Close table"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, trade/policy type, carrier, contact..."
          className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500 bg-slate-50/60"
        />
      </div>

      {/* Table */}
      {list.length === 0 ? (
        <div className="text-center py-10 text-xs text-slate-400 italic">No subcontractors match.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-wider text-[11px] bg-slate-50/70 font-['JetBrains_Mono']">
                <th className="py-3 pl-4 pr-3">Subcontractor</th>
                <th className="py-3 pr-3">Policy type</th>
                <th className="py-3 pr-3">Expiration date</th>
                <th className="py-3 pr-3">Insuring company</th>
                <th className="py-3 pr-3">Status</th>
                <th className="py-3 pr-4 text-right w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((s) => {
                const exp = bestExpiration(s)
                const types = coverageTypes(s)
                const { carrier, amBest } = insuringCompany(s)
                const expanded = expandedId === s.id
                return (
                  <Fragment key={s.id}>
                    <tr
                      onClick={() => setExpandedId(expanded ? null : s.id)}
                      className="hover:bg-brand-50/20 cursor-pointer transition text-xs"
                    >
                      {/* Subcontractor name */}
                      <td className="py-3.5 pl-4 pr-3 font-bold text-slate-900">{s.company_name}</td>
                      {/* Policy type */}
                      <td className="py-3.5 pr-3 text-slate-600">
                        {types.length ? (
                          <span className="flex flex-wrap gap-1">
                            {types.slice(0, 3).map((t) => (
                              <span
                                key={t}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium"
                              >
                                {t}
                              </span>
                            ))}
                            {types.length > 3 && (
                              <span className="text-[10px] text-slate-400">+{types.length - 3}</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      {/* Expiration date */}
                      <td className="py-3.5 pr-3 font-mono text-slate-800 whitespace-nowrap">
                        {exp ? formatDisplayDate(exp) : <span className="text-slate-400">No COI on file</span>}
                      </td>
                      {/* Insuring company */}
                      <td className="py-3.5 pr-3 text-slate-700">
                        {carrier || <span className="text-slate-400">—</span>}
                        {amBest ? <span className="text-[10px] text-slate-400 ml-1">· {amBest}</span> : null}
                      </td>
                      {/* Status */}
                      <td className="py-3.5 pr-3">
                        <ExpirationBadge status={s.computed_status} daysLeft={s.days_left} size="sm" showCountdown={false} />
                      </td>
                      {/* Expand chevron */}
                      <td className="py-3.5 pr-4 text-right text-slate-400 w-10">
                        {expanded ? (
                          <ChevronDown className="w-4 h-4 inline" />
                        ) : (
                          <ChevronRight className="w-4 h-4 inline" />
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="bg-slate-50/70 border-t border-slate-200">
                        <td colSpan={6} className="p-4 space-y-4 text-xs">
                          {/* Contacts + status */}
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-white rounded-xl p-3 border border-slate-200">
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400 font-mono">Contact</div>
                              <div className="font-semibold text-slate-800 mt-0.5">{s.contact_person || '—'}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400 font-mono">Phone</div>
                              <div className="mt-0.5 font-mono text-slate-700">
                                {s.phone ? (
                                  <a href={`tel:${s.phone}`} className="hover:text-brand-600 inline-flex items-center gap-1">
                                    <Phone className="w-3 h-3 text-slate-400" /> {s.phone}
                                  </a>
                                ) : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400 font-mono">Email</div>
                              <div className="mt-0.5 font-mono text-slate-700 truncate">
                                {s.email ? (
                                  <a href={`mailto:${s.email}`} className="hover:text-brand-600 inline-flex items-center gap-1 truncate">
                                    <Mail className="w-3 h-3 text-slate-400" /> {s.email}
                                  </a>
                                ) : '—'}
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase font-bold text-slate-400 font-mono">Compliance</div>
                              <div className="mt-0.5">
                                <ExpirationBadge status={s.computed_status} daysLeft={s.days_left} size="md" showCountdown />
                              </div>
                            </div>
                          </div>

                          {/* COIs list — all policy information */}
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 font-mono">
                                Certificates of insurance ({(s.cois || []).length})
                              </span>
                              <div className="flex items-center gap-2">
                                {onRequestCOI && (
                                  <button
                                    type="button"
                                    onClick={() => onRequestCOI(s.id)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100 transition cursor-pointer"
                                  >
                                    <Upload className="w-3 h-3" /> Request COI
                                  </button>
                                )}
                                {onUploadCOI && (
                                  <button
                                    type="button"
                                    onClick={onUploadCOI}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition cursor-pointer"
                                  >
                                    <FileText className="w-3 h-3" /> Upload COI
                                  </button>
                                )}
                              </div>
                            </div>

                            {(s.cois || []).length === 0 ? (
                              <div className="text-slate-400 italic bg-white rounded-xl p-3 border border-slate-200 text-center">
                                No certificate on file yet.
                              </div>
                            ) : (
                              <div className="space-y-3">
                                {(s.cois || []).map((c) => {
                                  const rd = c.review_details
                                  return (
                                    <div key={c.id} className="bg-white rounded-xl p-3.5 border border-slate-200 space-y-3">
                                      {/* Policy header */}
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="font-bold text-slate-900">{c.carrier}</span>
                                          {c.am_best_rating && (
                                            <span className="text-[10px] font-mono text-slate-400">AM Best {c.am_best_rating}</span>
                                          )}
                                          {c.policy_number && (
                                            <span className="text-[11px] font-mono text-slate-500">#{c.policy_number}</span>
                                          )}
                                          <span className="text-[10px] px-1.5 py-0.5 rounded font-mono font-bold bg-slate-100 text-slate-600">
                                            {c.status}
                                          </span>
                                        </div>
                                        <div className="flex items-center gap-2 text-slate-500 font-mono text-[11px]">
                                          <Calendar className="w-3 h-3 text-slate-400" />
                                          <span>{c.effective_date ? formatDisplayDate(c.effective_date) : '—'}</span>
                                          <span>→</span>
                                          <span className="font-bold text-slate-900">{c.expiration_date ? formatDisplayDate(c.expiration_date) : '—'}</span>
                                          {c.certificate_url && (
                                            <button
                                              type="button"
                                              onClick={() => viewCertificate(c)}
                                              className="ml-2 inline-flex items-center gap-1 text-brand-600 hover:underline cursor-pointer"
                                            >
                                              <Eye className="w-3 h-3" /> view file
                                            </button>
                                          )}
                                        </div>
                                      </div>

                                      {/* Coverages table */}
                                      {(c.coverages || []).length > 0 && (
                                        <div className="overflow-x-auto rounded-lg border border-slate-200">
                                          <table className="w-full text-left text-[11px]">
                                            <thead>
                                              <tr className="bg-slate-50 text-slate-400 uppercase text-[10px] font-mono">
                                                <th className="py-1.5 pl-3 pr-2">Coverage type</th>
                                                <th className="py-1.5 pr-2">Per occurrence</th>
                                                <th className="py-1.5 pr-2">Aggregate</th>
                                                <th className="py-1.5 pr-2">Addl. insured</th>
                                                <th className="py-1.5 pr-3">Waiver</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-slate-100">
                                              {(c.coverages || []).map((cv) => (
                                                <tr key={cv.id || cv.type}>
                                                  <td className="py-1.5 pl-3 pr-2 font-medium text-slate-800">{cv.type}</td>
                                                  <td className="py-1.5 pr-2 font-mono text-slate-700">{cv.per_occurrence_limit || '—'}</td>
                                                  <td className="py-1.5 pr-2 font-mono text-slate-700">{cv.aggregate_limit || '—'}</td>
                                                  <td className="py-1.5 pr-2">{cv.additional_insured ? '✓' : '—'}</td>
                                                  <td className="py-1.5 pr-3">{cv.waiver_of_subrogation ? '✓' : '—'}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}

                                      {/* Review / AI-extracted fields summary */}
                                      {rd && (
                                        <div className="rounded-lg bg-sky-50/60 border border-sky-200 p-2.5 text-[11px] text-sky-950 space-y-1">
                                          <div className="font-bold flex items-center gap-1 text-sky-900">
                                            <ShieldCheck className="w-3 h-3" /> Extracted review data
                                          </div>
                                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sky-900/80">
                                            {rd.insured_name && <span>Insured: <b>{rd.insured_name}</b></span>}
                                            {rd.producer_name && <span>Producer: {rd.producer_name}</span>}
                                            {rd.cg2010 != null && <span>CG 20 10: {rd.cg2010 ? '✓' : '✗'}</span>}
                                            {rd.cg2037 != null && <span>CG 20 37: {rd.cg2037 ? '✓' : '✗'}</span>}
                                            {rd.primary_noncontributory != null && <span>Primary &amp; non-contributory: {rd.primary_noncontributory ? '✓' : '✗'}</span>}
                                            {rd.waiver_subrogation != null && <span>Waiver of subrogation: {rd.waiver_subrogation ? '✓' : '✗'}</span>}
                                          </div>
                                        </div>
                                      )}

                                      {c.reviewer_notes && (
                                        <div className="text-[11px] text-slate-500 italic">Notes: {c.reviewer_notes}</div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>

                          {/* Full detail page link */}
                          <div className="pt-1 flex items-center justify-between text-[11px] text-slate-400">
                            <span>{s.notes || ''}</span>
                            <Link
                              to={`/subcontractors?id=${s.id}`}
                              className="text-brand-600 hover:underline inline-flex items-center gap-1 font-semibold"
                            >
                              Open full subcontractor record <ExternalLink className="w-3 h-3" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
