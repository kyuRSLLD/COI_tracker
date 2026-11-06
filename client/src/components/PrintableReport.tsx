import { Printer, X } from 'lucide-react'
import type { ClientSharePayload } from '../types'
import { ExpirationBadge } from './ExpirationBadge'

interface Props {
  open: boolean
  onClose: () => void
  payload: ClientSharePayload
}

export function PrintableReport({ open, onClose, payload }: Props) {
  if (!open) return null
  const { project, contractor, scorecard, subcontractors, generated_at } = payload

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-4xl w-full p-8 shadow-2xl border border-slate-200 max-h-[95vh] overflow-y-auto">
        <div className="no-print flex items-center justify-between pb-4 border-b border-slate-200 mb-6">
          <div className="text-xs text-slate-500">
            Print preview — use your browser's print dialog to save as PDF
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition"
            >
              <Printer className="w-3.5 h-3.5" /> Print / Save as PDF
            </button>
            <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Printable page content */}
        <div className="print-page text-slate-900">
          {/* Letterhead */}
          <div className="flex items-start justify-between pb-6 border-b border-slate-300">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
                Certificate of Insurance — Compliance Report
              </div>
              <h1 className="text-2xl font-extrabold text-slate-900 mt-1">{project.name}</h1>
              <p className="text-xs text-slate-500 mt-0.5">
                {project.code && `Code: ${project.code} · `}
                {project.address}
              </p>
            </div>
            <div className="text-right text-xs text-slate-600 leading-relaxed">
              <div className="font-bold text-slate-900">{contractor.company_name}</div>
              {contractor.license_number && <div>Lic. {contractor.license_number}</div>}
              {contractor.phone && <div>{contractor.phone}</div>}
              {contractor.email && <div>{contractor.email}</div>}
              <div className="text-[11px] text-slate-400 mt-2">
                Generated {new Date(generated_at).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Scorecard summary */}
          <div className="my-6 grid grid-cols-4 gap-3 text-center text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-2xl font-extrabold text-slate-900 font-['JetBrains_Mono']">{scorecard.score}%</div>
              <div className="text-[11px] text-slate-500 font-semibold">Compliance score</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-2xl font-extrabold text-emerald-600 font-['JetBrains_Mono']">{scorecard.compliant}</div>
              <div className="text-[11px] text-slate-500 font-semibold">Fully compliant</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-2xl font-extrabold text-amber-600 font-['JetBrains_Mono']">{scorecard.expiring}</div>
              <div className="text-[11px] text-slate-500 font-semibold">Expiring ≤30 days</div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-2xl font-extrabold text-rose-600 font-['JetBrains_Mono']">{scorecard.expired}</div>
              <div className="text-[11px] text-slate-500 font-semibold">Expired</div>
            </div>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b-2 border-slate-300 text-[11px] text-slate-500 uppercase tracking-wider font-semibold">
                  <th className="py-2 pr-3">Subcontractor</th>
                  <th className="py-2 pr-3">Trade</th>
                  <th className="py-2 pr-3">Carrier / Policy</th>
                  <th className="py-2 pr-3">Effective</th>
                  <th className="py-2 pr-3">Expires</th>
                  <th className="py-2 pr-3">Endorsements</th>
                  <th className="py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {subcontractors.map((s) => {
                  const coi = s.cois?.[0] || s.best_coi
                  const endorsements = coi
                    ? [coi.coverages?.some((c) => Boolean(c.additional_insured)) && 'Add\'l Insured', coi.coverages?.some((c) => Boolean(c.waiver_of_subrogation)) && 'Waiver']
                        .filter(Boolean)
                        .join(' · ') || '—'
                    : '—'
                  return (
                    <tr key={s.id} className="align-top">
                      <td className="py-2.5 pr-3 font-bold text-slate-900">{s.company_name}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{s.trade}</td>
                      <td className="py-2.5 pr-3">
                        {coi ? (
                          <>
                            <div className="font-semibold text-slate-800">{coi.carrier}</div>
                            <div className="text-[11px] text-slate-400 font-['JetBrains_Mono']">{coi.policy_number || '—'}</div>
                          </>
                        ) : (
                          <span className="text-slate-400 italic">No policy</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">{coi?.effective_date || '—'}</td>
                      <td className="py-2.5 pr-3 font-semibold text-slate-900">{coi?.expiration_date || '—'}</td>
                      <td className="py-2.5 pr-3 text-[11px] text-slate-600">{endorsements}</td>
                      <td className="py-2.5 text-right">
                        <ExpirationBadge status={s.computed_status} daysLeft={s.days_left} size="sm" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-8 pt-4 border-t border-slate-300 text-[11px] text-slate-400 flex justify-between">
            <span>Prepared by {contractor.company_name} · Confidential client report</span>
            <span>All subcontractor contact routed through the General Contractor</span>
          </div>
        </div>
      </div>
    </div>
  )
}
