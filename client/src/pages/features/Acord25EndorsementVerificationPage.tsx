import { Link } from 'react-router-dom'
import { SEO } from '../../components/SEO'
import { MarketingFooter } from '../../components/MarketingFooter'

export function Acord25EndorsementVerificationPage() {
  return (
    <>
      <SEO
        title="ACORD 25 & Endorsement Verification Software | Safecoi"
        description="AI-powered ACORD 25 review with checks for Additional Insured CG 20 10/CG 20 37, Waiver of Subrogation, Primary & Non-Contributory wording, and expiration alerts."
        canonical="https://safecoi.com/features/acord-25-endorsement-verification"
      />
      <div className="bg-white text-slate-800">
        <main className="max-w-4xl mx-auto px-5 pt-8 pb-14">
          <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-navy leading-tight">
            The certificate grants no coverage.<br className="hidden sm:inline" /> The endorsement is what gets you paid.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            A checked “additional insured” box on an ACORD 25 only means a document clerk checked
            a box. Safecoi's AI reads the certificate <em>and</em> the endorsement pages behind
            it — additional insured (ongoing and completed ops), waiver of subrogation, and
            primary &amp; non-contributory wording — and queues every gap for a human review
            decision.
          </p>
          <div className="mt-6 flex flex-wrap gap-3 items-center">
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm"
            >
              Validate a COI free →
            </Link>
            <Link
              to="/blog/check-acord-25-before-sub-on-site"
              className="border border-slate-300 hover:border-slate-400 font-semibold px-5 py-3 rounded-lg text-sm text-slate-700"
            >
              9-step ACORD 25 review guide
            </Link>
          </div>

          {/* Product preview */}
          <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-6 shadow-sm">
            <div className="flex items-center justify-between text-xs text-slate-500 pb-3 border-b border-slate-200">
              <span>Endorsement review · CG 20 10 vs CG 20 37 check</span>
              <span className="font-mono text-[11px] text-slate-400">1 certificate · 3 pages</span>
            </div>
            <div className="mt-4 space-y-2 text-sm">
              <div className="bg-white rounded-xl p-3 border border-slate-200 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Additional insured — ongoing operations</div>
                  <div className="text-xs text-slate-500">ISO CG 20 10 (or equivalent) in favor of the general contractor</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium shrink-0">found · page 2</span>
              </div>
              <div className="bg-white rounded-xl p-3 border border-amber-300 bg-amber-50/40 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Additional insured — completed operations</div>
                  <div className="text-xs text-slate-500">ISO CG 20 37 missing — claims arising after the job are not covered</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-xs font-medium shrink-0">gap flagged</span>
              </div>
              <div className="bg-white rounded-xl p-3 border border-slate-200 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Waiver of subrogation</div>
                  <div className="text-xs text-slate-500">GL + workers' compensation waivers confirmed</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium shrink-0">found · page 3</span>
              </div>
              <div className="bg-white rounded-xl p-3 border border-slate-200 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">Primary &amp; non-contributory wording</div>
                  <div className="text-xs text-slate-500">endorsement or policy language confirmed</div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium shrink-0">found · page 2</span>
              </div>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <span>AI flags. Your reviewer accepts, rejects, or requests a revision — every decision logged.</span>
              <span className="font-mono text-slate-700">status: <b className="text-amber-800">revision needed</b></span>
            </div>
          </div>

          {/* Three concrete facts */}
          <div className="mt-10 grid sm:grid-cols-3 gap-5 text-sm">
            <div>
              <div className="text-2xl font-black text-navy">Beyond the box</div>
              <p className="mt-1 text-slate-600">Checks the endorsements themselves, not just the certificate checkboxes.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">Human decision</div>
              <p className="mt-1 text-slate-600">Accept, reject, or request revision in one click — never a machine-certified claim.</p>
            </div>
            <div>
              <div className="text-2xl font-black text-navy">Any format</div>
              <p className="mt-1 text-slate-600">PDFs, JPG/PNG photos, and iPhone HEIC images all read the same way.</p>
            </div>
          </div>

          {/* FAQ */}
          <div className="mt-12 divide-y divide-slate-200 border-t border-slate-200">
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">Why isn't the certificate alone enough?</h2>
              <p className="text-sm text-slate-600 mt-1">The ACORD 25 is a summary from the broker — it grants no coverage. The endorsement forms (CG 20 10, CG 20 37, CG 24 04) are what amend the policy to protect you.</p>
            </div>
            <div className="py-4">
              <h2 className="font-bold text-slate-900 text-sm">How does Safecoi handle altered certificates?</h2>
              <p className="text-sm text-slate-600 mt-1">NAIC verification, name-mismatch flagging, and version comparison catch most alterations; suspicious certificates can be routed for independent agency verification.</p>
            </div>
          </div>

          {/* Final CTA */}
          <div className="mt-10 rounded-2xl bg-brand-950 text-white p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="text-xl sm:text-2xl font-black">Upload an ACORD 25 right now. Free.</div>
              <div className="text-sm text-slate-400 mt-1">Line-by-line checks in under a minute · nothing to install</div>
            </div>
            <Link
              to="/login"
              className="bg-amber-450 hover:bg-amber-500 text-brand-950 font-bold px-5 py-3 rounded-lg text-sm text-center whitespace-nowrap"
            >
              Verify a COI free →
            </Link>
          </div>
        </main>
        <MarketingFooter
          links={[
            { to: '/solutions/subcontractor-coi-tracking', label: 'Sub tracking' },
            { to: '/industries/remodeling-contractor-compliance', label: 'Remodeling' },
            { to: '/pricing', label: 'Pricing' },
            { to: '/articles/', label: 'Articles', external: true },
          ]}
        />
      </div>
    </>
  )
}
