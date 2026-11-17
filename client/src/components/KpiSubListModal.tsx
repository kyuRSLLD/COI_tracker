import { useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Search, Phone, Mail, MapPin, ExternalLink, FileText, Upload } from 'lucide-react'
import type { Subcontractor } from '../types'
import { formatDisplayDate } from '../lib/date'
import { ExpirationBadge } from './ExpirationBadge'

export type KpiBucket = 'all' | 'compliant' | 'expiring_soon' | 'expired' | 'missing' | 'pending_review'

interface Props {
  open: boolean
  bucket: KpiBucket
  subs: Subcontractor[]
  onClose: () => void
  onRequestCOI?: (subId?: string) => void
  onUploadCOI?: (subId?: string) => void
}

const META: Record<KpiBucket, { title: string; subtitle: string }> = {
  all: {
    title: 'All subcontractors',
    subtitle: 'Every subcontractor connected to your company with their current COI status.',
  },
  compliant: {
    title: 'Fully compliant subcontractors',
    subtitle: 'Subcontractors whose active COI has been verified and is not expired.',
  },
  expiring_soon: {
    title: 'COIs expiring in 30 days',
    subtitle: 'Policies that expire within the next 30 days — send renewal reminders early.',
  },
  expired: {
    title: 'Expired policies',
    subtitle: 'Policies whose expiration date has passed — stop-work risk until renewed.',
  },
  missing: {
    title: 'Missing COIs',
    subtitle: 'Subcontractors who do not have a Certificate of Insurance on file.',
  },
  pending_review: {
    title: 'COIs pending your review',
    subtitle: 'Certificates submitted through the self-service portal waiting for your approval.',
  },
}

export function KpiSubListModal({ open, bucket = 'all', subs = [], onClose, onRequestCOI, onUploadCOI }: Props) {
  const [search, setSearch] = useState('')

  const meta = META[bucket] || META.all
  const safeSubs = subs || []

  let list = bucket === 'all' ? safeSubs : safeSubs.filter((s) => s.computed_status === bucket)
  if (search.trim()) {
    const q = search.toLowerCase()
    list = list.filter(
      (s) =>
        (s.company_name || '').toLowerCase().includes(q) ||
        (s.trade || '').toLowerCase().includes(q) ||
        (s.contact_person || '').toLowerCase().includes(q) ||
        (s.best_coi?.carrier || '').toLowerCase().includes(q),
    )
  }
  const filtered = list

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-slate-400 font-['JetBrains_Mono']">
              {bucket === 'all' ? 'total subcontractors' : bucket.replace('_', ' ')}
            </div>
            <h2 className="text-base sm:text-lg font-bold text-slate-900 mt-0.5">
              {meta.title}
              <span className="ml-2 text-xs font-semibold font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                {filtered.length}
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">{meta.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pt-3 pb-2 border-b border-slate-100">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by company, trade, contact or carrier…"
              className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-xl focus:border-brand-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Sub list */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1">
          {filtered.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-xs">
              {search.trim() ? 'No subcontractors match your search.' : 'None found in this category.'}
            </div>
          ) : (
            filtered.map((s) => {
              const exp = s.best_coi?.expiration_date
              return (
                <div
                  key={s.id}
                  className="rounded-xl border border-slate-200 p-4 space-y-3 hover:border-slate-300 transition"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-slate-900">{s.company_name}</span>
                        <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full">
                          {s.trade}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                        {s.contact_person && <span>Contact: {s.contact_person}</span>}
                        {s.phone && (
                          <a
                            href={`tel:${s.phone}`}
                            className="inline-flex items-center gap-1 text-slate-600 hover:text-brand-600 font-mono text-[11px]"
                          >
                            <Phone className="w-3 h-3 text-slate-400" /> {s.phone}
                          </a>
                        )}
                        {s.email && (
                          <a
                            href={`mailto:${s.email}`}
                            className="inline-flex items-center gap-1 text-slate-600 hover:text-brand-600 font-mono text-[11px]"
                          >
                            <Mail className="w-3 h-3 text-slate-400" /> {s.email}
                          </a>
                        )}
                        {s.address && (
                          <span className="inline-flex items-center gap-1 text-slate-500 text-[11px]">
                            <MapPin className="w-3 h-3 text-slate-400" /> {s.address}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <ExpirationBadge
                        status={s.computed_status}
                        daysLeft={s.days_left}
                        size="md"
                        showCountdown
                      />
                    </div>
                  </div>

                  {/* COI expiration row */}
                  <div className="rounded-lg bg-slate-50 border border-slate-150 p-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="font-semibold text-slate-700">COI expires</span>
                      <span className="font-mono text-slate-900">
                        {exp ? formatDisplayDate(exp) : 'No certificate on file'}
                      </span>
                      {s.best_coi?.carrier && (
                        <span className="text-slate-500">
                          {s.best_coi.carrier}
                          {s.best_coi.am_best_rating ? ` · ${s.best_coi.am_best_rating}` : ''}
                        </span>
                      )}
                      {s.best_coi?.policy_number && (
                        <span className="font-mono text-slate-500 text-[11px]">
                          Policy #{s.best_coi.policy_number}
                        </span>
                      )}
                    </div>
                    {exp && (
                      <span className="font-bold text-[11px] font-mono shrink-0">
                        {(s.days_left ?? 0) < 0 ? (
                          <span className="text-rose-700">Expired {Math.abs(s.days_left ?? 0)} days ago</span>
                        ) : s.days_left === 0 ? (
                          <span className="text-amber-700">Expires today</span>
                        ) : (
                          <span className="text-slate-600">{s.days_left} days remaining</span>
                        )}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100 text-xs">
                    <Link
                      to={`/subcontractors?highlight=${s.id}`}
                      className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:text-brand-700"
                    >
                      View subcontractor <ExternalLink className="w-3.5 h-3.5" />
                    </Link>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => { onRequestCOI?.(s.id); onClose() }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50"
                      >
                        <FileText className="w-3.5 h-3.5" /> Request COI
                      </button>
                      <button
                        type="button"
                        onClick={() => { onUploadCOI?.(s.id); onClose() }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700"
                      >
                        <Upload className="w-3.5 h-3.5" /> Upload COI
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between text-xs text-slate-500">
          <span>{filtered.length} subcontractor{filtered.length === 1 ? '' : 's'}</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl border border-slate-300 bg-white text-slate-700 font-semibold hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
