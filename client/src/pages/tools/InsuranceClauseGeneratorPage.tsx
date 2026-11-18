import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { SEO } from '../../components/SEO'
import { MarketingFooter } from '../../components/MarketingFooter'

interface TradeConfig {
  name: string
  gl: [number, number]
  auto: number
  wc: string
  umb: { small: number; mid: number; large: number }
  endos: string[]
  notes: string
}

const TRADES: Record<string, TradeConfig> = {
  remodeling: {
    name: 'General Remodeling',
    gl: [1000000, 2000000],
    auto: 1000000,
    wc: 'Statutory + $500k/$500k/$500k employers liability',
    umb: { small: 0, mid: 1000000, large: 5000000 },
    endos: ['CG 20 10 (ongoing)', 'CG 20 37 (completed ops)', 'CG 24 04 waiver of subrogation (incl. WC)', 'Primary & non-contributory wording'],
    notes: 'Completed-operations endorsement is essential for remodeling work.',
  },
  roofing: {
    name: 'Roofing & Siding',
    gl: [2000000, 4000000],
    auto: 1000000,
    wc: 'Statutory + $1M/$1M/$1M employers liability',
    umb: { small: 1000000, mid: 2000000, large: 5000000 },
    endos: ['CG 20 10 (ongoing)', 'CG 20 37 (completed ops)', 'CG 24 04 waiver of subrogation (incl. WC)', 'Primary & non-contributory wording', 'No open-roof / continuous-damage exclusions'],
    notes: 'Higher-hazard trade: umbrella recommended even on small jobs; confirm fall-protection and open-roof coverage.',
  },
  electrical: {
    name: 'Electrical',
    gl: [1000000, 2000000],
    auto: 1000000,
    wc: 'Statutory + $500k/$500k/$500k employers liability',
    umb: { small: 0, mid: 1000000, large: 5000000 },
    endos: ['CG 20 10 (ongoing)', 'CG 20 37 (completed ops)', 'CG 24 04 waiver of subrogation (incl. WC)', 'Primary & non-contributory wording'],
    notes: 'Electrical claims tend to be binary: minor or catastrophic. Completed operations coverage is critical.',
  },
  plumbing: {
    name: 'Plumbing',
    gl: [1000000, 2000000],
    auto: 1000000,
    wc: 'Statutory + $500k/$500k/$500k employers liability',
    umb: { small: 0, mid: 1000000, large: 5000000 },
    endos: ['CG 20 10 (ongoing)', 'CG 20 37 (completed ops)', 'CG 24 04 waiver of subrogation (incl. WC)', 'Primary & non-contributory wording', 'Water-damage / mold coverage without exclusions'],
    notes: 'Water damage claims are slow-burn — verify completed operations and check for water-damage exclusions.',
  },
  hvac: {
    name: 'HVAC & Mechanical',
    gl: [1000000, 2000000],
    auto: 1000000,
    wc: 'Statutory + $500k/$500k/$500k employers liability',
    umb: { small: 0, mid: 1000000, large: 5000000 },
    endos: ['CG 20 10 (ongoing)', 'CG 20 37 (completed ops)', 'CG 24 04 waiver of subrogation (incl. WC)', 'Primary & non-contributory wording', 'Pollution liability where required by the trade'],
    notes: 'Mechanical subs may require contractor pollution liability depending on the scope.',
  },
}

const TRADE_LABELS: Record<string, string> = {
  remodeling: 'Remodeling',
  roofing: 'Roofing & Siding',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
}

const ENDO_MAP: Record<string, string> = {
  '20 37': 'Covers completed work after the sub leaves the site',
  '20 10': 'Covers work while in progress',
  '24 04': "Stops the sub's insurer from suing you after paying a claim",
  'Primary': 'Ensures the sub\u2019s policy pays first',
  'WC': 'Applies to workers comp — not just GL',
}

function money(n: number): string {
  if (!n) return 'none'
  return '$' + n.toLocaleString('en-US')
}

export function InsuranceClauseGeneratorPage() {
  const [trade, setTrade] = useState('remodeling')
  const [size, setSize] = useState<'small' | 'mid' | 'large'>('mid')
  const [gcName, setGcName] = useState('')
  const [copiedClause, setCopiedClause] = useState(false)
  const [copiedList, setCopiedList] = useState(false)

  const t = TRADES[trade]
  const gc = (gcName.trim() || '[GENERAL CONTRACTOR]').toUpperCase()

  const occ = money(t.gl[0])
  const agg = money(t.gl[1])
  const umb = money(t.umb[size])
  const auto = money(t.auto)

  const clause = `INSURANCE. Subcontractor shall maintain, at its expense: (a) Commercial General Liability of not less than ${occ} per occurrence / ${agg} general aggregate; (b) Workers' Compensation at statutory limits plus Employers' Liability of ${t.wc}; (c) Commercial Automobile Liability of not less than ${auto} combined single limit; (d) Umbrella/Excess Liability of not less than ${umb}. All policies (except workers' compensation) shall name ${gc} as an additional insured on endorsements ISO CG 20 10 (ongoing operations) and ISO CG 20 37 (completed operations), or equivalents, on a primary and non-contributory basis. All policies shall include a waiver of subrogation (including workers' compensation) in favor of ${gc}. Subcontractor shall provide a Certificate of Insurance and the endorsement forms prior to commencing work.`

  const list = [
    `\u2022 Commercial General Liability: ${occ} / ${agg}`,
    `\u2022 Workers' Compensation: ${t.wc}`,
    `\u2022 Automobile Liability: ${auto}`,
    `\u2022 Umbrella/Excess Liability: ${umb}`,
  ]
    .concat(t.endos.map((e) => '\u2022 Endorsement: ' + e))
    .join('\n')

  const endoRows = useMemo(
    () =>
      t.endos.map((e) => {
        const key = Object.keys(ENDO_MAP).find((k) => e.includes(k))
        return { endorsement: e, reason: key ? ENDO_MAP[key] : 'Trade-specific requirement' }
      }),
    [t]
  )

  function copy(text: string, which: 'clause' | 'list') {
    if (navigator.clipboard) navigator.clipboard.writeText(text)
    if (which === 'clause') {
      setCopiedClause(true)
      setTimeout(() => setCopiedClause(false), 1500)
    } else {
      setCopiedList(true)
      setTimeout(() => setCopiedList(false), 1500)
    }
  }

  return (
    <>
      <SEO
        title="Free Subcontractor Insurance Clause & Requirement Generator | Safecoi"
        description="Generate copy-paste insurance requirement clauses for subcontractor agreements. Pick your trade and project size — free, no signup."
        canonical="https://safecoi.com/tools/insurance-clause-generator"
      />
      <div className="bg-white text-slate-800">
        <main className="max-w-4xl mx-auto px-4 py-8">
          <h1 className="text-2xl sm:text-4xl font-black text-navy leading-tight">
            Subcontractor insurance clause generator
          </h1>
          <p className="text-sm text-slate-600 mt-2 max-w-xl">
            Pick a trade and project size. Copy the clause into your subcontract. Then verify the incoming COI with Safecoi.
          </p>

          <div className="mt-6 bg-white rounded-2xl border border-slate-200 p-5 sm:p-7 shadow-sm space-y-6">
            {/* Step 1 */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">1. Trade</label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {Object.entries(TRADE_LABELS).map(([key, label]) => {
                  const active = trade === key
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTrade(key)}
                      className={`min-h-[44px] p-3 rounded-xl border-2 text-xs font-bold transition ${
                        active ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 hover:border-slate-400 text-slate-700'
                      }`}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Step 2 */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">2. Project size</label>
              <div className="grid sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setSize('small')}
                  className={`min-h-[44px] p-3 rounded-xl border-2 text-left text-xs transition ${
                    size === 'small' ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="font-bold">Small</div>
                  <div className="text-slate-500">Under $50k subcontract</div>
                </button>
                <button
                  type="button"
                  onClick={() => setSize('mid')}
                  className={`min-h-[44px] p-3 rounded-xl border-2 text-left text-xs transition ${
                    size === 'mid' ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="font-bold">Mid-sized</div>
                  <div className="text-slate-500">$50k – $250k subcontract</div>
                </button>
                <button
                  type="button"
                  onClick={() => setSize('large')}
                  className={`min-h-[44px] p-3 rounded-xl border-2 text-left text-xs transition ${
                    size === 'large' ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 hover:border-slate-400'
                  }`}
                >
                  <div className="font-bold">Large</div>
                  <div className="text-slate-500">$250k+ subcontract</div>
                </button>
              </div>
            </div>

            {/* Step 3 */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">
                3. Your company name (appears in the clause)
              </label>
              <input
                type="text"
                value={gcName}
                onChange={(e) => setGcName(e.target.value)}
                placeholder="e.g. Apex Construction LLC"
                className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy"
              />
            </div>

            {/* Output */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Subcontract insurance clause — copy &amp; paste
                </label>
                <button type="button" onClick={() => copy(clause, 'clause')} className="text-xs font-bold text-navy hover:underline">
                  {copiedClause ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <textarea
                readOnly
                rows={9}
                value={clause}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg p-3"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Required endorsements</label>
                <button type="button" onClick={() => copy(list, 'list')} className="text-xs font-bold text-navy hover:underline">
                  {copiedList ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <textarea
                readOnly
                rows={5}
                value={list}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full font-mono text-xs bg-slate-50 border border-slate-200 rounded-lg p-3"
              />
              <div className="mt-3 text-xs overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500 border-b">
                      <th className="pb-1">Endorsement</th>
                      <th className="pb-1">Why it matters</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endoRows.map((r) => (
                      <tr key={r.endorsement} className="border-b">
                        <td className="py-1.5 pr-3 font-mono font-bold text-navy">{r.endorsement}</td>
                        <td className="py-1.5 text-slate-600">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-950">
              <strong>Trade note ({t.name}):</strong> {t.notes}
            </div>

            <div className="border-t border-slate-200 pt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="font-bold text-sm text-navy">Got the clause? Now verify the COI.</div>
                <div className="text-xs text-slate-500">
                  Safecoi's AI checks these exact endorsements line by line — human reviewer decides.
                </div>
              </div>
              <Link
                to="/login"
                className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-4 py-2.5 rounded-lg text-xs text-center whitespace-nowrap min-h-[44px] inline-flex items-center justify-center"
              >
                Validate a COI free →
              </Link>
            </div>
          </div>

          <div className="text-center text-xs text-slate-500 mt-6 space-y-1">
            <p>
              <strong>Disclaimer:</strong> General guidance, not legal or insurance advice. Have your attorney or broker review clauses for your jurisdiction.
            </p>
            <p>
              Safecoi is independent B2B compliance software — <strong>not affiliated with Safeco Insurance</strong>. •{' '}
              <Link to="/pricing" className="underline">
                Pricing
              </Link>
            </p>
          </div>
        </main>
        <MarketingFooter />
      </div>
    </>
  )
}
