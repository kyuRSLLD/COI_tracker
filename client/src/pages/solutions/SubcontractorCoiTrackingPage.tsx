import { Link } from 'react-router-dom'
import { SEO } from '../../components/SEO'
import { MarketingFooter } from '../../components/MarketingFooter'

export function SubcontractorCoiTrackingPage() {
  return (
    <>
      <SEO
        title="Subcontractor COI Tracking Software for General Contractors | Safecoi"
        description="Stop chasing subcontractor insurance in spreadsheets. Safecoi automates COI collection, expiration alerts, and endorsement checks — so every sub is covered on every job site."
        canonical="https://safecoi.com/solutions/subcontractor-coi-tracking"
        ogImage="https://safecoi.com/articles/assets/og/solutions.png"
      />
      <div className="bg-white text-slate-800">
        <main className="max-w-4xl mx-auto px-5 pt-8 pb-14">
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-navy leading-tight">
            Know every sub is insured.<br className="hidden sm:inline" /> Before they walk the job.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            Subs send their certificate of insurance by text or QR — no account required.
            Safecoi's AI reads it and flags what's missing: names that don't match, expired
            dates, gaps in limits, and endorsements like additional insured and waiver of
            subrogation. A real person on your team makes the call. Every version stays filed
            for your next audit.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 items-center">
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm"
            >
              Validate your first COI free →
            </Link>
            <Link
              to="/tools/insurance-clause-generator"
              className="border border-slate-300 hover:border-slate-400 font-semibold px-5 py-3 rounded-lg text-sm text-slate-700"
            >
              Free clause generator
            </Link>
          </div>

          {/* Product preview */}
          <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 pb-3 border-b border-slate-200">
              <span>Review · ACORD 25 certificate</span>
              <span className="font-mono text-[11px] text-slate-400">ID 4f8a–2c1e</span>
            </div>
            <div className="mt-4 grid sm:grid-cols-3 gap-3 text-sm">
              <div className="bg-white rounded-xl p-3 border border-slate-200">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">Named insured</div>
                <div className="font-semibold text-slate-900 mt-1">Apex Electric LLC</div>
                <div className="text-xs text-emerald-700 mt-1 font-medium">✓ matches subcontract name</div>
              </div>
              <div className="bg-white rounded-xl p-3 border border-slate-200">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">Policy window</div>
                <div className="font-semibold text-slate-900 mt-1">10/01/26 → 10/01/27</div>
                <div className="text-xs text-slate-600 mt-1">renewals chased 30 days out</div>
              </div>
              <div className="bg-white rounded-xl p-3 border border-slate-200">
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">Limits</div>
                <div className="font-semibold text-slate-900 mt-1">GL $1M/$2M · Auto $1M · WC stat</div>
                <div className="text-xs text-slate-600 mt-1">umbrella $1M on file</div>
              </div>
            </div>
            <div className="mt-3 bg-white rounded-xl p-3 border border-slate-200 text-xs">
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold mb-2">Endorsements checked</div>
              <div className="flex flex-wrap gap-1.5">
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">Additional insured — ongoing (CG 20 10) ✓</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">Additional insured — completed ops (CG 20 37) ✓</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">Waiver of subrogation (incl. WC) ✓</span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">Primary &amp; non-contributory ✓</span>
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 font-medium">Description of operations: review wording</span>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 text-xs text-slate-600">
              <span>AI assists. Your reviewer makes the final call.</span>
              <span className="font-mono text-slate-700">status: <b className="text-emerald-700">verified</b></span>
            </div>
          </div>

          {/* Three concrete facts */}
          <div className="mt-10 grid sm:grid-cols-3 gap-5 text-sm">
            <div>
              <div className="text-2xl font-black text-navy">One link</div>
              <p className="mt-1 text-slate-600">Subs submit a photo or PDF from their phone. No app, no password, no excuses.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">4 checks</div>
              <p className="mt-1 text-slate-600">Named insured, dates, limits, endorsements. Every field extracted, every gap flagged.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">Audit-ready</div>
              <p className="mt-1 text-slate-600">Old versions stay filed. When the workers' comp auditor asks, the answer is one export.</p>
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-12 divide-y divide-slate-200 border-t border-slate-200">
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">Do subs have to create accounts?</h2>
              <p className="text-sm text-slate-600 mt-1">No. They open a link or scan a QR code and submit in under two minutes.</p>
            </div>
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">Does Safecoi guarantee coverage?</h2>
              <p className="text-sm text-slate-600 mt-1">No. The AI flags; your reviewer decides. Honest records are what actually hold up in an audit.</p>
            </div>
          </div>

          {/* Final CTA */}
          <div className="mt-10 rounded-2xl bg-brand-950 text-white p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xl sm:text-2xl font-black">Upload one COI and see what the AI catches.</div>
              <div className="text-sm text-slate-400 mt-1">Free to start · no credit card · nothing to install</div>
            </div>
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm text-center whitespace-nowrap"
            >
              Validate a COI free →
            </Link>
          </div>
        </main>
        <MarketingFooter
          links={[
            { to: '/tools/insurance-clause-generator', label: 'Clause generator' },
            { to: '/pricing', label: 'Pricing' },
            { to: '/articles/', label: 'Articles', external: true },
            { to: '/legal/privacy', label: 'Privacy' },
          ]}
        />
      </div>
    </>
  )
}
