import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { ShieldAlert, Printer, ShieldCheck } from 'lucide-react'
import type { ClientSharePayload } from '../types'
import { apiClientView } from '../api'
import { ComplianceScore } from '../components/ComplianceScore'
import { ExpirationBadge } from '../components/ExpirationBadge'
import { PrintableReport } from '../components/PrintableReport'

export function ClientSharePage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<ClientSharePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [printOpen, setPrintOpen] = useState(false)

  useEffect(() => {
    if (!token) return
    apiClientView.get(token)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) {
    return <div className="max-w-6xl mx-auto px-4 py-16 text-center text-xs text-slate-400">Loading compliance report…</div>
  }
  if (error || !data) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <div className="w-12 h-12 rounded-2xl bg-rose-100 text-rose-700 flex items-center justify-center mx-auto text-xl font-bold">!</div>
        <h2 className="text-xl font-extrabold text-slate-900 mt-4">Unable to load this compliance report</h2>
        <p className="text-xs text-slate-500 mt-2">{error || 'This link may have expired or is no longer valid.'}</p>
        <p className="text-xs text-slate-400 mt-4">Please contact the general contractor for an updated link.</p>
      </div>
    )
  }

  // Whitelist the fields used in both views, even if the API ever returns more.
  // In particular, never pass original documents or private contacts to the report.
  const safeData: ClientSharePayload = {
    project: { id: '', name: data.project.name, code: data.project.code, client_name: data.project.client_name },
    contractor: { company_name: data.contractor.company_name },
    scorecard: data.scorecard,
    subcontractors: data.subcontractors.map((s, index) => {
      const coi = s.cois?.[0] || s.best_coi
      const summary = coi ? {
        id: '', carrier: 'Withheld', effective_date: coi.effective_date, expiration_date: coi.expiration_date,
        status: coi.status, simulated_carrier_connect: coi.simulated_carrier_connect,
        coverages: coi.coverages?.map((coverage) => ({
          type: coverage.type,
          per_occurrence_limit: coverage.per_occurrence_limit,
          aggregate_limit: coverage.aggregate_limit,
          additional_insured: coverage.additional_insured,
          waiver_of_subrogation: coverage.waiver_of_subrogation,
        })),
      } : null
      return {
        id: String(index), company_name: `Subcontractor ${index + 1}`, trade: 'Trade withheld',
        computed_status: s.computed_status, days_left: s.days_left,
        best_coi: summary, cois: summary ? [summary] : [],
      }
    }),
    share: { token: '', created_at: data.share.created_at, expires_at: data.share.expires_at },
    generated_at: data.generated_at,
  }
  const { project, contractor, scorecard, subcontractors, generated_at } = safeData

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Contractor header */}
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-brand-600 text-white flex items-center justify-center shadow-sm">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="font-extrabold text-slate-900 text-base">{contractor.company_name}</div>
              <div className="text-xs text-slate-400">
                Certificate of Insurance Compliance Portal
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <button
              onClick={() => setPrintOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm"
            >
              <Printer className="w-3.5 h-3.5" /> Print compliance report
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Privacy notice */}
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-950 flex items-start gap-3">
          <ShieldAlert className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Compliance report</div>
            <div className="text-[11px] text-emerald-900/80 mt-0.5 leading-relaxed">
              This report summarizes records on <strong>{project.name}</strong>; it does not verify insurance with carriers. Pending or simulated records are not verification of insurance. For any subcontractor-related question, please contact <strong>{contractor.company_name}</strong> directly — subcontractor direct-contact information is omitted by design.
            </div>
          </div>
        </div>

        {/* Project overview */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-6 border-b border-slate-200">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">
                Project compliance summary
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900 mt-1">{project.name}</h1>
              <p className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                {project.code && <span className="font-['JetBrains_Mono']">Code: {project.code}</span>}
                {project.client_name && <span>Client: {project.client_name}</span>}
              </p>
            </div>
            <div className="text-right text-xs text-slate-400 font-['JetBrains_Mono']">
              Report generated {new Date(generated_at).toLocaleString()}
            </div>
          </div>

          <div className="mt-6">
            <ComplianceScore
              scorecard={scorecard}
              title="Overall project compliance"
              subtitle={`Based on records for ${scorecard.total} subcontractors assigned to this job`}
            />
          </div>
        </div>

        {/* Subcontractors coverage table — NO CONTACT INFO COLUMNS */}
        <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Subcontractors on this project</h2>
              <p className="text-xs text-slate-500">Coverage types, limits, and expiration dates on file.</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400 uppercase tracking-wider text-[11px] bg-slate-50/70">
                  <th className="py-3 pl-3 pr-3">Subcontractor</th>
                  <th className="py-3 pr-3">Trade</th>
                  <th className="py-3 pr-3">Expires</th>
                  <th className="py-3 pr-3">Coverage summary</th>
                  <th className="py-3 pr-3">Endorsements</th>
                  <th className="py-3 pr-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {subcontractors.map((s) => {
                  const coi = s.cois?.[0] || s.best_coi
                  const endorsements = coi
                    ? [coi.coverages?.some((c) => Boolean(c.additional_insured)) && 'Add\'l Insured', coi.coverages?.some((c) => Boolean(c.waiver_of_subrogation)) && 'Waiver of Subrogation']
                        .filter(Boolean)
                        .join(' · ') || '—'
                    : '—'
                  return (
                    <tr key={s.id} className="hover:bg-slate-50/70 align-top">
                      <td className="py-3.5 pl-3 pr-3 font-bold text-slate-900">{s.company_name}</td>
                      <td className="py-3.5 pr-3 text-slate-600">{s.trade}</td>
                      <td className="py-3.5 pr-3 font-semibold text-slate-900 font-['JetBrains_Mono']">
                        {coi?.expiration_date || '—'}
                        {coi?.simulated_carrier_connect && <div className="text-amber-800 font-semibold">Simulated — not verified</div>}
                      </td>
                      <td className="py-3.5 pr-3 text-slate-600">
                        {coi?.coverages && coi.coverages.length > 0 ? (
                          <div className="space-y-0.5 text-[11px]">
                            {coi.coverages.map((cv, i) => (
                              <div key={i}>
                                <span className="font-semibold">{cv.type}:</span> {cv.per_occurrence_limit?.trim() || 'Limit not provided'}
                                {cv.aggregate_limit && ` / ${cv.aggregate_limit} agg`}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">No coverage lines captured</span>
                        )}
                      </td>
                      <td className="py-3.5 pr-3 text-[11px] text-slate-600">{endorsements}</td>
                      <td className="py-3.5 pr-3 text-right">
                        <ExpirationBadge status={s.computed_status} daysLeft={s.days_left} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <footer className="text-center text-[11px] text-slate-400 py-6 space-y-1">
          <div>Prepared by {contractor.company_name} · Confidential client compliance report</div>
          <div>All inquiries regarding subcontractors must be directed to the general contractor</div>
        </footer>
      </main>

      <PrintableReport open={printOpen} onClose={() => setPrintOpen(false)} payload={safeData} />
    </div>
  )
}
