import { Link } from 'react-router-dom'
import { SEO } from '../../components/SEO'
import { MarketingFooter } from '../../components/MarketingFooter'

export function RemodelingContractorCompliancePage() {
  return (
    <>
      <SEO
        title="Insurance Compliance Software for Remodelers & Home Repair | Safecoi"
        description="Protect your residential remodeling business: collect and verify COIs from plumbers, electricians, roofers, and HVAC trades with one link — no sub accounts needed."
        canonical="https://safecoi.com/industries/remodeling-contractor-compliance"
        ogImage="https://safecoi.com/articles/assets/og/remodeling.png"
      />
      <div className="bg-white text-slate-800">
        <main className="max-w-4xl mx-auto px-5 pt-8 pb-14">
          <div className="text-xs font-bold uppercase tracking-wider text-amber-600">
            Residential remodelers · custom builders · home repair
          </div>
          <h1 className="mt-2 text-3xl sm:text-5xl font-black tracking-tight text-navy leading-tight">
            Your subs work inside people's homes.<br className="hidden sm:inline" /> Is every one actually insured?
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            A roofer's ladder slide or a plumber's leaking joint can create a claim that lands
            on the general contractor. Text each trade one link — they submit their certificate
            from their phone, no login. Safecoi's AI reads it and flags expired dates, wrong
            names, and missing endorsements before anyone steps inside a customer's home.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 items-center">
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm"
            >
              Collect your first COI free →
            </Link>
            <Link
              to="/tools/insurance-clause-generator"
              className="border border-slate-300 hover:border-slate-400 font-semibold px-5 py-3 rounded-lg text-sm text-slate-700"
            >
              Sub-agreement clause generator
            </Link>
          </div>

          {/* Product preview */}
          <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 pb-3 border-b border-slate-200">
              <span>Project · Kitchen &amp; bath remodel · 4 trades</span>
              <span className="font-mono text-[11px] text-slate-400">updated 2 min ago</span>
            </div>
            <div className="mt-4 divide-y divide-slate-200 text-sm">
              <div className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Ridge Line Roofing</div>
                  <div className="text-xs text-slate-500">GL $2M/$4M · umbrella $2M · expires 09/2027</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium shrink-0">verified</span>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Lakeview Electric</div>
                  <div className="text-xs text-slate-500">GL $1M/$2M · policy ends 10/30/2026</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-xs font-medium shrink-0">renewal chased</span>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Aqua Flow Plumbing</div>
                  <div className="text-xs text-slate-500">missing completed-ops endorsement (CG 20 37)</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-xs font-medium shrink-0">revision needed</span>
              </div>
              <div className="py-2.5 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">North Star HVAC</div>
                  <div className="text-xs text-slate-500">certificate submitted 8 min ago</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 text-xs font-medium shrink-0">ready to review</span>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span>One shareable link shows the homeowner every trade is verified. Subs' contacts stay private.</span>
              <span className="font-mono text-slate-700">share link · on</span>
            </div>
          </div>

          {/* Three concrete facts */}
          <div className="mt-10 grid sm:grid-cols-3 gap-5 text-sm">
            <div>
              <div className="text-2xl font-black text-navy">No sub logins</div>
              <p className="mt-1 text-slate-600">Plumbers and electricians don't want another app. One text, one upload, done.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">By trade</div>
              <p className="mt-1 text-slate-600">Roofing needs higher limits. Electrical needs completed-operations. Every trade's real gaps flagged.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">Win the job</div>
              <p className="mt-1 text-slate-600">Hand a compliance link to the homeowner: "every trade on your house is verified insured."</p>
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-12 divide-y divide-slate-200 border-t border-slate-200">
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">I only use a handful of subs. Is this worth it?</h2>
              <p className="text-sm text-slate-600 mt-1">Five subs × four policies = twenty renewal dates a year, plus endorsements. One missed expiration discovered at audit time usually costs more than a year of Safecoi.</p>
            </div>
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">What limits should remodeling subs carry?</h2>
              <p className="text-sm text-slate-600 mt-1">Typical: $1M per-occurrence / $2M aggregate GL, statutory workers' comp, auto liability, and additional insured + waiver endorsements. Use the <Link to="/tools/insurance-clause-generator" className="underline">clause generator</Link> for trade-by-trade guidance.</p>
            </div>
          </div>

          {/* Final CTA */}
          <div className="mt-10 rounded-2xl bg-brand-950 text-white p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xl sm:text-2xl font-black">Protect your next project before it starts.</div>
              <div className="text-sm text-slate-400 mt-1">Free to start · no credit card · nothing to install</div>
            </div>
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm text-center whitespace-nowrap"
            >
              Collect a COI free →
            </Link>
          </div>
        </main>
        <MarketingFooter
          links={[
            { to: '/solutions/subcontractor-coi-tracking', label: 'Sub tracking' },
            { to: '/features/acord-25-endorsement-verification', label: 'ACORD 25 verification' },
            { to: '/pricing', label: 'Pricing' },
            { to: '/articles/', label: 'Articles', external: true },
          ]}
        />
      </div>
    </>
  )
}
