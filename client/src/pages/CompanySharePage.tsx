import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ShieldCheck,
  CheckCircle2,
  Calendar,
  Printer,
  AlertCircle,
  FileText,
  Shield,
  Layers,
} from 'lucide-react'
import { apiCompanyShare, type PublicCompanyCOIResponse } from '../api'
import { formatDisplayDate, isExpiredDate, daysFromNow } from '../lib/date'
import { formatCurrencyString } from '../lib/currency'

export function CompanySharePage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<PublicCompanyCOIResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    apiCompanyShare
      .get(token)
      .then(setData)
      .catch((err) => setError(err?.message || 'Unable to load company certificate'))
      .finally(() => setLoading(false))
  }, [token])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-sm text-slate-500">
        Loading certificate…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-3xl p-8 border border-slate-200 text-center space-y-3">
          <AlertCircle className="w-10 h-10 text-rose-500 mx-auto" />
          <h1 className="text-xl font-extrabold text-slate-900">Certificate unavailable</h1>
          <p className="text-xs text-slate-500">{error || 'This share link could not be found.'}</p>
          <Link to="/" className="inline-block text-xs font-semibold text-brand-700 hover:underline pt-2">
            Go to SafeCOI
          </Link>
        </div>
      </div>
    )
  }

  const { company, coi, share } = data
  const expired = isExpiredDate(coi.expiration_date)
  const days = daysFromNow(coi.expiration_date)
  const isValidated = coi.status === 'compliant'

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-brand-600 text-white flex items-center justify-center shadow-sm">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <div className="font-extrabold text-slate-900 text-base">{company.company_name}</div>
              <div className="text-xs text-slate-400">Company Certificate of Insurance</div>
            </div>
          </div>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 transition shadow-sm self-start sm:self-auto"
          >
            <Printer className="w-3.5 h-3.5" /> Print certificate
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-950 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold">Insurance record on file</div>
            <div className="text-[11px] text-emerald-900/80 mt-0.5 leading-relaxed">
              This page summarizes the Certificate of Insurance on file with SafeCOI for {company.company_name}.
              It does not constitute independent verification with insurance carriers.
            </div>
          </div>
        </div>

        <section className="bg-white rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-6 border-b border-slate-100">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
                Insurance certificate
              </div>
              <h1 className="text-3xl font-extrabold text-slate-900 mt-1">{company.company_name}</h1>
              <p className="text-xs text-slate-500 mt-1">
                Shared via SafeCOI · link valid through {formatDisplayDate(share.expires_at)}
              </p>
            </div>
            <div>
              {expired ? (
                <span className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
                  Expired
                </span>
              ) : isValidated ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                  <CheckCircle2 className="w-4 h-4" /> Validated
                </span>
              ) : (
                <span className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                  Pending validation
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Insurer</div>
              <div className="font-bold text-slate-800 text-base mt-1 truncate">{coi.carrier || '—'}</div>
              {coi.am_best_rating && (
                <div className="text-slate-500 text-[11px] mt-0.5">AM Best: {coi.am_best_rating}</div>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Policy number</div>
              <div className="font-bold text-slate-800 text-base mt-1 font-mono truncate">
                {coi.policy_number || '—'}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Effective</div>
              <div className="font-bold text-slate-800 text-base mt-1">{formatDisplayDate(coi.effective_date)}</div>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4 bg-slate-50">
              <div className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Expiration</div>
              <div className="font-bold text-slate-800 text-base mt-1">{formatDisplayDate(coi.expiration_date)}</div>
              {days != null && (
                <div className={`text-[11px] mt-0.5 ${expired ? 'text-rose-600 font-semibold' : 'text-slate-500'}`}>
                  {expired ? 'Policy expired' : `${days} days remaining`}
                </div>
              )}
            </div>
          </div>

          <div className="pt-2">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-brand-600" />
              <h2 className="text-sm font-bold text-slate-900">Coverage details</h2>
            </div>
            {coi.coverages && coi.coverages.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-400 uppercase tracking-wider text-[10px]">
                      <th className="py-2 font-semibold">Coverage</th>
                      <th className="py-2 font-semibold text-right">Per occurrence</th>
                      <th className="py-2 font-semibold text-right">Aggregate</th>
                      <th className="py-2 font-semibold text-center">Add'l insured</th>
                      <th className="py-2 font-semibold text-center">Waiver subrogation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {coi.coverages.map((cv: any, i: number) => (
                      <tr key={i}>
                        <td className="py-2.5 font-semibold text-slate-800">{cv.type}</td>
                        <td className="py-2.5 text-right font-mono text-slate-700">
                          {formatCurrencyString(cv.per_occurrence_limit)}
                        </td>
                        <td className="py-2.5 text-right font-mono text-slate-700">
                          {formatCurrencyString(cv.aggregate_limit)}
                        </td>
                        <td className="py-2.5 text-center text-slate-600">
                          {cv.additional_insured === 1 || cv.additional_insured === true ? 'Yes' : '—'}
                        </td>
                        <td className="py-2.5 text-center text-slate-600">
                          {cv.waiver_of_subrogation === 1 || cv.waiver_of_subrogation === true ? 'Yes' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400">Coverage breakdown will appear once reviewed.</p>
            )}
          </div>
        </section>

        <footer className="text-center text-[11px] text-slate-400 py-6 space-y-1">
          <div>Powered by <Link to="/" className="text-brand-700 hover:underline font-semibold">SafeCOI</Link> · Certificate of Insurance tracking for contractors</div>
          <div>Report generated {formatDisplayDate(data.generated_at)}</div>
        </footer>
      </main>
    </div>
  )
}
