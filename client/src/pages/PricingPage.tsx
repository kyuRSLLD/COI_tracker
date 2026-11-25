import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ArrowRight, ShieldCheck, HelpCircle } from 'lucide-react'
import { SEO } from '../components/SEO'
import { MarketingFooter } from '../components/MarketingFooter'

interface Plan {
  name: string
  price: number | null
  period: string
  /** Months the paid plan runs free before billing starts. */
  freeMonths?: number
  desc: string
  highlight: boolean
  badge?: string
  cta: string
  ctaHref: string
  features: string[]
}

const PLANS: Plan[] = [
  {
    name: 'Free Demo',
    price: 0,
    period: '',
    desc: 'Test the workflow with simulated renewals before you pay.',
    highlight: false,
    cta: 'Try free',
    ctaHref: '/login?mode=register',
    features: [
      'Upload and validate certificates',
      'AI ACORD 25 field reading',
      'Simulated reminder emails',
      'Sample data to explore',
    ],
  },
  {
    name: 'General Contractor',
    price: 10,
    period: '/month',
    freeMonths: 6,
    desc: 'Everything you need to collect, verify, and monitor sub COIs.',
    highlight: true,
    badge: 'Free for 6 months',
    cta: 'Start free',
    ctaHref: '/login?mode=register',
    features: [
      'Unlimited subcontractor COIs',
      'AI + human verification workflow',
      'Expiration tracking & renewal reminders',
      'Waiver of subrogation, additional insured, P&NC checks',
      'Workers’ comp audit-ready records',
      'Client-safe compliance sharing links',
      'QR code & invite-link onboarding',
    ],
  },
  {
    name: 'Pro GC',
    price: 29,
    period: '/month',
    desc: 'For growing contractors managing more subs and more projects.',
    highlight: false,
    cta: 'Go Pro',
    ctaHref: '/login?mode=register',
    features: [
      'Everything in General Contractor',
      'Priority verification queue',
      'Advanced compliance reports',
      'Multiple company workspaces',
      'Bulk reminders & exports',
      'Priority support',
    ],
  },
  {
    name: 'Enterprise',
    price: null,
    period: '',
    desc: 'Custom limits, carrier-lookup integrations, and SSO for large teams.',
    highlight: false,
    cta: 'Talk to us',
    ctaHref: '/login?mode=register',
    features: [
      'Unlimited everything',
      'Dedicated onboarding & training',
      'Custom integrations & exports',
      'SLA & account manager',
      'Invoice billing',
    ],
  },
]

const FAQS = [
  {
    q: 'How does the free trial work?',
    a: 'Create an account in 60 seconds — no credit card required. The General Contractor plan is free for your first six months. If you stay on after that, it is $10/month, cancel anytime.',
  },
  {
    q: 'Do subcontractors ever pay?',
    a: 'No. Subcontractors never pay to submit a certificate. You send them a secure link or QR code; they open it on their phone, attach the COI, and they are done. No account or download needed.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Month-to-month, no contracts. You can export all your compliance records whenever you want — your data is always yours.',
  },
  {
    q: 'What counts as a COI?',
    a: 'Any certificate of insurance — ACORD 25 forms, binders, and endorsement pages. The AI reads each policy, and someone on your team makes the final verification call.',
  },
  {
    q: 'Is this affiliated with Safeco Insurance?',
    a: 'No. Safecoi is independent B2B compliance software for general contractors. We are not affiliated with Safeco Insurance.',
  },
]

export function PricingPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null)

  return (
    <>
      <SEO
        title="SafeCOI Pricing — Free for Your First Six Months"
        description="Collect, verify, and monitor subcontractor COIs. Free for your first six months, no credit card required — then $10/month. Subcontractors never pay."
        canonical="https://safecoi.com/pricing"
        ogImage="https://safecoi.com/articles/assets/og/home.png"
      />
      <div className="bg-white text-slate-800">
        {/* Hero */}
        <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-12 pb-8 text-center">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">PRICING</div>
          <h1 className="text-3xl sm:text-5xl font-extrabold text-slate-900 mt-2 tracking-tight">
            One sub with lapsed insurance costs more than this software ever will.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl mx-auto">
            Collect, verify, and monitor subcontractor COIs. Free for your first six months —
            no credit card, no contracts.
          </p>

          {/* Guarantee banner */}
          <div className="mt-8 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-800">
            <ShieldCheck className="w-4 h-4" />
            <span>6 months free · no credit card · cancel anytime · your data is always exportable</span>
          </div>

          {/* Plan cards */}
          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 text-left">
            {PLANS.map((p) => {
              const free = p.price === 0
              const custom = p.price === null
              return (
                <div
                  key={p.name}
                  className={`relative rounded-2xl p-6 flex flex-col justify-between transition ${
                    p.highlight
                      ? 'bg-navy text-white shadow-xl ring-2 ring-brand-500 scale-[1.02]'
                      : 'bg-white border border-slate-200 text-slate-900'
                  }`}
                >
                  {p.badge && (
                    <span className="absolute -top-3 left-6 text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-400 text-slate-900">
                      {p.badge}
                    </span>
                  )}
                  <div>
                    <h2 className="text-sm font-bold uppercase tracking-wider text-brand-400 font-['JetBrains_Mono']">
                      {p.name}
                    </h2>
                    <p className={`mt-2 text-xs ${p.highlight ? 'text-slate-300' : 'text-slate-500'}`}>
                      {p.desc}
                    </p>
                    <div className="mt-6">
                      {custom ? (
                        <span className="text-3xl font-extrabold">Custom</span>
                      ) : free ? (
                        <span className="text-4xl font-extrabold">$0</span>
                      ) : (
                        <>
                          {p.freeMonths ? (
                            <div className="flex items-baseline gap-2">
                              <span className="text-4xl font-extrabold">Free</span>
                              <span className={`text-xs font-semibold ${p.highlight ? 'text-emerald-300' : 'text-emerald-700'}`}>
                                first {p.freeMonths} months
                              </span>
                            </div>
                          ) : null}
                          <div className={`flex items-baseline gap-1 ${p.freeMonths ? 'mt-1.5' : ''}`}>
                            <span
                              className={
                                p.freeMonths
                                  ? `text-base font-bold line-through decoration-2 ${p.highlight ? 'text-slate-300' : 'text-slate-400'}`
                                  : 'text-4xl font-extrabold'
                              }
                            >
                              ${p.price}
                            </span>
                            <span className={`text-xs ${p.highlight ? 'text-slate-300' : 'text-slate-500'}`}>
                              {p.period}
                            </span>
                            {p.freeMonths ? (
                              <span className={`text-[11px] ${p.highlight ? 'text-slate-300' : 'text-slate-400'}`}>
                                after 6 months
                              </span>
                            ) : null}
                          </div>
                        </>
                      )}
                    </div>
                    <ul className="mt-6 space-y-2.5 text-xs">
                      {p.features.map((f) => (
                        <li key={f} className="flex items-start gap-2">
                          <Check className={`w-4 h-4 shrink-0 mt-0.5 ${p.highlight ? 'text-emerald-400' : 'text-emerald-600'}`} />
                          <span className={p.highlight ? 'text-slate-200' : 'text-slate-700'}>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <Link
                    to={p.ctaHref}
                    className={`mt-8 w-full py-3 rounded-xl text-center text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                      p.highlight
                        ? 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-md'
                        : 'bg-slate-900 hover:bg-slate-800 text-white'
                    }`}
                  >
                    {p.cta} <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
              )
            })}
          </div>

          {/* Subcontractor note */}
          <div className="mt-10 max-w-xl mx-auto rounded-xl p-4 bg-slate-50 border border-slate-200 text-xs text-slate-600">
            <p className="font-semibold text-slate-900">Are you a subcontractor?</p>
            <p className="mt-1">
              Subs never pay. When a general contractor requests your insurance, they send you a link or QR code — open it on your phone, attach your certificate, and you're done. No account required.
            </p>
          </div>

          {/* FAQ */}
          <section className="mt-20 max-w-2xl mx-auto text-left">
            <div className="text-center">
              <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">FAQ</div>
              <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2">Questions contractors ask us</h2>
            </div>
            <div className="mt-8 space-y-3">
              {FAQS.map((f, i) => (
                <div key={f.q} className="rounded-xl border border-slate-200 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                    className="w-full p-4 bg-white hover:bg-slate-50 flex items-center justify-between text-left font-semibold text-xs sm:text-sm text-slate-900 gap-3"
                  >
                    <span className="flex items-center gap-2">
                      <HelpCircle className="w-4 h-4 text-brand-600 shrink-0" />
                      {f.q}
                    </span>
                    <span className="text-slate-400 shrink-0 text-base">{openFaq === i ? '−' : '+'}</span>
                  </button>
                  {openFaq === i && (
                    <div className="p-4 pt-1 bg-white text-xs text-slate-600 leading-relaxed border-t border-slate-100">
                      {f.a}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Bottom CTA */}
          <section className="mt-20 rounded-2xl bg-gradient-to-r from-navy via-slate-900 to-navy text-white p-8 sm:p-12 text-center">
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Six months free. No credit card.
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-slate-300 max-w-md mx-auto">
              Upload your first subcontractor COI in under two minutes and see the AI verification in action.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                to="/login?mode=register"
                className="px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-bold shadow-md transition"
              >
                Create free account
              </Link>
              <Link
                to="/tools/insurance-clause-generator"
                className="px-6 py-3 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-bold border border-white/20 transition"
              >
                Try the free clause tool first
              </Link>
            </div>
          </section>
        </main>

        <MarketingFooter />
      </div>
    </>
  )
}
