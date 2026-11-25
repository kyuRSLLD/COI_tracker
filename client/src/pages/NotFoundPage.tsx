import { Link } from 'react-router-dom'
import { SEO } from '../components/SEO'
import { MarketingFooter } from '../components/MarketingFooter'
import { ShieldCheck, ArrowRight } from 'lucide-react'

export function NotFoundPage() {
  return (
    <>
      <SEO
        title="Page not found | Safecoi"
        description="The page you were looking for doesn't exist."
        canonical="https://safecoi.com/"
        noindex
      />
      <div className="bg-white text-slate-800">
        <section className="relative overflow-hidden bg-gradient-to-b from-slate-900 via-slate-900 to-slate-950 text-white">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 pb-16 sm:pb-20 text-center">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-rose-300 bg-rose-500/10 border border-rose-400/30 rounded-full px-3 py-1">
              404
            </span>
            <h1 className="mt-4 text-3xl sm:text-5xl font-extrabold tracking-tight">
              This page doesn&apos;t exist.
            </h1>
            <p className="mt-4 text-base sm:text-lg text-slate-300 max-w-xl mx-auto">
              The link you followed may be broken or the page may have been moved. Try one of these pages instead.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/"
                className="inline-flex items-center gap-2 bg-white text-slate-900 font-semibold px-5 py-3 rounded-lg text-sm hover:bg-slate-100 transition shadow-sm"
              >
                Go to homepage
              </Link>
              <Link
                to="/pricing"
                className="inline-flex items-center gap-2 bg-slate-800 text-white font-semibold px-5 py-3 rounded-lg text-sm hover:bg-slate-700 transition border border-slate-700"
              >
                View pricing <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>

        <section className="max-w-4xl mx-auto px-4 sm:px-6 py-14">
          <h2 className="text-xl font-bold text-slate-900 mb-6">Popular pages</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Link
              to="/solutions/subcontractor-coi-tracking"
              className="group p-5 rounded-xl border border-slate-200 hover:border-slate-400 hover:shadow-sm transition"
            >
              <div className="text-sm font-bold text-slate-900 group-hover:text-blue-600 flex items-center justify-between">
                <span>Subcontractor COI tracking</span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition" />
              </div>
              <p className="mt-1 text-xs text-slate-600">Automate COI collection and expiration alerts for every subcontractor.</p>
            </Link>
            <Link
              to="/features/acord-25-endorsement-verification"
              className="group p-5 rounded-xl border border-slate-200 hover:border-slate-400 hover:shadow-sm transition"
            >
              <div className="text-sm font-bold text-slate-900 group-hover:text-blue-600 flex items-center justify-between">
                <span>ACORD 25 &amp; endorsement verification</span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition" />
              </div>
              <p className="mt-1 text-xs text-slate-600">AI-assisted endorsement checks with human-in-the-loop review.</p>
            </Link>
            <Link
              to="/tools/insurance-clause-generator"
              className="group p-5 rounded-xl border border-slate-200 hover:border-slate-400 hover:shadow-sm transition"
            >
              <div className="text-sm font-bold text-slate-900 group-hover:text-blue-600 flex items-center justify-between">
                <span>Free insurance clause generator</span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition" />
              </div>
              <p className="mt-1 text-xs text-slate-600">Copy-paste insurance clauses for your subcontractor agreements.</p>
            </Link>
            <a
              href="/articles/"
              className="group p-5 rounded-xl border border-slate-200 hover:border-slate-400 hover:shadow-sm transition"
            >
              <div className="text-sm font-bold text-slate-900 group-hover:text-blue-600 flex items-center justify-between">
                <span>Field guides &amp; articles</span>
                <ArrowRight className="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition" />
              </div>
              <p className="mt-1 text-xs text-slate-600">Practical guides on COIs, endorsements, and workers' comp audits.</p>
            </a>
          </div>
        </section>

        <MarketingFooter />
      </div>
    </>
  )
}
