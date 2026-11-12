import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ShieldCheck, ArrowRight, CheckCircle2, Clock, Share2, FileCheck, Users, Lock, ChevronRight, Building, Check,
} from 'lucide-react'

interface Props {
  onLogin: () => void
}

export function LandingPage({ onLogin }: Props) {
  const navigate = useNavigate()
  const [calcTotal, setCalcTotal] = useState(12)
  const [calcCompliant, setCalcCompliant] = useState(10)
  const score = calcTotal > 0 ? Math.round((calcCompliant / calcTotal) * 100) : 100

  const features = [
    {
      num: '01',
      title: 'Request a COI in seconds',
      body: 'Generate a personalized, secure upload link for each subcontractor. They open the link, enter their policy details, and attach the certificate — no app download or account creation needed.',
      icon: Clock,
      tint: 'bg-brand-100 text-brand-700',
    },
    {
      num: '02',
      title: 'Live expiration countdown',
      body: 'See expiration countdowns and color-coded statuses for certificates on file. Reminder emails are currently simulated and are not delivered.',
      icon: AlertBadge,
      tint: 'bg-amber-100 text-amber-800',
    },
    {
      num: '03',
      title: 'Share with clients — safely',
      body: 'Share a project report with owners showing anonymized subcontractor records, available coverage details, and status badges. The report is not verification of insurance.',
      icon: Lock,
      tint: 'bg-emerald-100 text-emerald-700',
      highlight: true,
    },
    {
      num: '04',
      title: 'Shareable project reports',
      body: 'Share a project report with inspectors, lenders, or owners and print it for your records. Reminder emails are simulated and are not delivered.',
      icon: FileCheck,
      tint: 'bg-sky-100 text-sky-700',
    },
  ]

  const faqs = [
    {
      q: 'How does client-safe sharing protect contractor relationships?',
      a: 'The client report uses anonymous subcontractor labels and may show coverage details, dates, and statuses. It omits subcontractor names, trade, contact details, policy numbers, and carrier information. The report is not verification of insurance.',
    },
    {
      q: 'Do subcontractors need to create an account?',
      a: 'A subcontractor can submit through a unique upload link without creating an account. They open the link, enter policy details, and can attach their ACORD certificate PDF or photo. Connecting through an onboarding invitation requires an account and consent.',
    },
    {
      q: 'Can I track different projects for different clients?',
      a: 'Yes. You create projects (e.g. "Riverside Commerce Center"), assign subcontractors to them, and generate dedicated share links per project — with optional expiration dates.',
    },
    {
      q: 'Where are my certificates stored?',
      a: 'Files are stored in Amazon S3 for durable, encrypted storage, with a zero-config local storage fallback during development. The app is ready to deploy on Railway with a PostgreSQL database.',
    },
    {
      q: 'How do expiration reminders work?',
      a: 'The dashboard highlights policies expiring in the next 30 days. Reminder emails are currently simulated and are not delivered, so contact subcontractors separately about renewals.',
    },
    {
      q: 'How does pricing work?',
      a: 'COI Shield is free for subcontractors, with no fee to upload or keep their certificates on file. General Contractors pay $10 per month to see every subcontractor COI connected to them and optionally share compliance reports with clients. Growing teams can choose the Pro GC plan at $29 per month for unlimited projects, subcontractors, and exports. No contracts — cancel anytime.',
    },
    {
      q: 'How do I onboard subcontractors?',
      a: 'Go to Profile → Subcontractor onboarding QR code. Share the QR code or invite link. Subcontractors can create a free account or sign in, then review and consent to sharing before connecting.',
    },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-brand-950 via-slate-900 to-slate-950 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-brand-600/20 via-transparent to-transparent pointer-events-none" />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-24 relative">
          <div className="flex justify-center">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/10 text-slate-200 backdrop-blur border border-white/10">
              <ShieldCheck className="w-3.5 h-3.5 text-slate-300" /> All your compliance in one place
            </span>
          </div>

          <div className="text-center max-w-4xl mx-auto mt-6">
            <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.08]">
              Let's protect your business.{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-300 via-sky-300 to-emerald-300">
                Organize subcontractor COIs. Stay ahead of coverage gaps.
              </span>
            </h1>
            <p className="mt-5 text-base sm:text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
              One platform where General Contractors request Certificates of Insurance, subcontractors upload them, and clients can view anonymized project reports. Reports do not verify insurance coverage.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-bold text-slate-950 bg-gradient-to-r from-emerald-300 to-emerald-400 hover:from-emerald-400 hover:to-emerald-500 transition shadow-lg shadow-emerald-500/30"
            >
              Sign in <ArrowRight className="w-4 h-4" />
            </Link>
            <a
              href="#pricing"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-bold text-white bg-white/10 hover:bg-white/15 backdrop-blur transition border border-white/15"
            >
              View pricing
            </a>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-bold text-slate-300 hover:text-white transition"
            >
              Sign in →
            </Link>
          </div>
          <p className="mt-4 text-center text-xs text-slate-300">
            Subcontractor?{' '}
            <Link to="/login" className="text-emerald-300 font-semibold hover:underline">
              Upload or connect your insurance certificate
            </Link>{' '}
            — free for subcontractors.
          </p>

          {/* Product mockup frame */}
          <div className="mt-14 max-w-5xl mx-auto rounded-3xl bg-slate-900/80 p-3 sm:p-5 ring-1 ring-white/15 shadow-2xl">
            <div className="rounded-2xl bg-white text-slate-900 p-5 sm:p-8 shadow-card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-5 border-b border-slate-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-brand-600 text-white flex items-center justify-center shadow-sm">
                    <ShieldCheck className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="font-extrabold text-slate-900 text-base">Riverside Commerce Center</div>
                    <div className="text-xs text-slate-400">Client: Meridian Property Partners · 7 subcontractors on site</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-3xl font-extrabold text-emerald-600 font-['JetBrains_Mono']">86%</div>
                    <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">compliant</div>
                  </div>
                </div>
              </div>

              {/* Sample sub rows */}
              <div className="mt-5 space-y-2.5 text-xs">
                {[
                  { name: 'Horizon Electrical Services', trade: 'Electrical', badge: 'Compliant · 180d left', color: 'bg-emerald-50 text-emerald-800 border-emerald-200', carrier: 'Liberty Mutual · GL $1M/$2M · Auto $1M · WC · Umbrella $5M' },
                  { name: 'Midwest Mechanical Systems', trade: 'HVAC', badge: 'Expires in 14 days', color: 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse', carrier: 'Travelers · GL $1M/$2M · Umbrella $10M' },
                  { name: 'Benchmark Concrete & Foundation', trade: 'Concrete', badge: 'Expired 18d ago', color: 'bg-rose-50 text-rose-800 border-rose-300 font-semibold', carrier: 'Zurich · renewal required before site access' },
                  { name: 'Titan Steel Erectors', trade: 'Framing & Structural', badge: 'Compliant · 220d left', color: 'bg-emerald-50 text-emerald-800 border-emerald-200', carrier: 'The Hartford · certificate on file' },
                ].map((r) => (
                  <div
                    key={r.name}
                    className="p-3.5 rounded-xl border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:border-slate-300 transition"
                  >
                    <div>
                      <span className="font-bold text-slate-900">{r.name}</span>
                      <span className="text-slate-400"> · {r.trade}</span>
                      <div className="text-[11px] text-slate-500 mt-0.5">{r.carrier}</div>
                    </div>
                    <span className={`self-start sm:self-center shrink-0 px-2.5 py-1 rounded-full border text-xs font-semibold ${r.color}`}>
                      {r.badge}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-5 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Green = compliant · Amber = expiring ≤30 days · Red = expired
                </span>
                <span className="font-['JetBrains_Mono'] text-slate-400">share: /share/rcc-meridian-2026</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* By the numbers */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 -mt-8 relative z-10">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { num: '01', val: '100%', label: 'Visibility into subcontractor insurance across every job' },
            { num: '02', val: '2 min', label: 'Average time for a subcontractor to upload their COI' },
            { num: '03', val: '0', label: 'Subcontractor contact details exposed to clients' },
            { num: '04', val: '$0', label: 'Spreadsheets touched this month' },
          ].map((c) => (
            <div key={c.num} className="bg-white rounded-2xl p-5 border border-slate-200 shadow-card">
              <div className="text-xs text-slate-400 font-['JetBrains_Mono']">{c.num}</div>
              <div className="text-3xl sm:text-4xl font-extrabold text-slate-900 mt-2 font-['JetBrains_Mono']">{c.val}</div>
              <div className="text-xs text-slate-600 mt-1 leading-snug">{c.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — three sides, one platform */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-20">
        <div className="text-center max-w-2xl mx-auto">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">How it works</div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 mt-2">All three sides of compliance, one place</h2>
          <p className="text-sm text-slate-600 mt-2">
            Just like supervision tracking connects supervisors and supervisees, insurance tracking connects GC, sub, and client — with clear roles and strong privacy walls.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card flex flex-col justify-between">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-brand-100 text-brand-700 flex items-center justify-center font-bold text-xl">
                GC
              </div>
              <h3 className="text-xl font-bold text-slate-900 mt-4">General Contractor</h3>
              <p className="text-xs text-slate-500 mt-1">Collect · View · Monitor · Share</p>
              <div className="mt-3"><span className="inline-block px-2.5 py-1 rounded-full text-xs font-bold font-['JetBrains_Mono'] bg-emerald-50 text-emerald-800 border border-emerald-200">$10/month</span></div>
              <ul className="mt-5 space-y-2 text-xs text-slate-700">
                <li className="flex gap-2"><span>✓</span><span>Request COIs with personalized magic links</span></li>
                <li className="flex gap-2"><span>✓</span><span>View submitted coverage details</span></li>
                <li className="flex gap-2"><span>✓</span><span>Expiration countdowns; reminder emails are simulated</span></li>
                <li className="flex gap-2"><span>✓</span><span>Generate client-safe project portals in one click</span></li>
              </ul>
            </div>
          </div>

          <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card flex flex-col justify-between">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-sky-100 text-sky-700 flex items-center justify-center font-bold text-xl">
                SUB
              </div>
              <h3 className="text-xl font-bold text-slate-900 mt-4">Subcontractor</h3>
              <p className="text-xs text-slate-500 mt-1">Upload · Confirm · Stay active</p>
              <div className="mt-3"><span className="inline-block px-2.5 py-1 rounded-full text-xs font-bold font-['JetBrains_Mono'] bg-sky-50 text-sky-800 border border-sky-200">Free for subcontractors</span></div>
              <ul className="mt-5 space-y-2 text-xs text-slate-700">
                <li className="flex gap-2"><span>✓</span><span>Open the link — no app, no password</span></li>
                <li className="flex gap-2"><span>✓</span><span>Enter policy #, carrier, limits in a 4-step wizard</span></li>
                <li className="flex gap-2"><span>✓</span><span>Attach ACORD PDF or photo right from the phone</span></li>
                <li className="flex gap-2"><span>✓</span><span>View expiration dates for certificates on file</span></li>
              </ul>
            </div>
          </div>

          <div className="bg-white rounded-3xl p-7 border border-slate-200 shadow-card flex flex-col justify-between">
            <div>
              <div className="w-12 h-12 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xl">
                CLI
              </div>
              <h3 className="text-xl font-bold text-slate-900 mt-4">Client / Owner</h3>
              <p className="text-xs text-slate-500 mt-1">View · Share · Print</p>
              <div className="mt-3"><span className="inline-block px-2.5 py-1 rounded-full text-xs font-bold font-['JetBrains_Mono'] bg-slate-100 text-slate-700 border border-slate-200">Free · shared by your GC</span></div>
              <ul className="mt-5 space-y-2 text-xs text-slate-700">
                <li className="flex gap-2"><span>✓</span><span>Live project scorecard (e.g. 86% compliant)</span></li>
                <li className="flex gap-2"><span>✓</span><span>Available coverage details at a glance, not insurance verification</span></li>
                <li className="flex gap-2"><span>✓</span><span>Print-ready compliance report for the file</span></li>
                <li className="flex gap-2"><span>✓</span><span className="font-semibold text-emerald-800">Never see subcontractor contact info — GC stays the contact</span></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Numbered feature cards */}
      <section className="bg-white py-20 border-y border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">Features</div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 mt-2">Everything you need to stop losing certificates</h2>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map((f) => (
              <div
                key={f.num}
                className={`rounded-3xl p-7 border shadow-card transition ${
                  f.highlight ? 'bg-gradient-to-br from-emerald-50/70 via-white to-white border-emerald-300 ring-2 ring-emerald-200' : 'bg-white border-slate-200 hover:shadow-card-hover'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-['JetBrains_Mono'] text-slate-400 font-bold">{f.num}</span>
                  <span className={`w-9 h-9 rounded-xl flex items-center justify-center ${f.tint}`}>
                    <f.icon className="w-5 h-5" />
                  </span>
                </div>
                <h3 className="text-xl font-bold text-slate-900 mt-4">{f.title}</h3>
                <p className="text-xs text-slate-600 mt-2 leading-relaxed">{f.body}</p>
                {f.highlight && (
                  <div className="mt-4 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 bg-emerald-100 px-3 py-1 rounded-full">
                    Enforced at both UI and API levels
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Interactive compliance calculator */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-20">
        <div className="bg-slate-900 text-white rounded-3xl p-8 sm:p-12 shadow-2xl">
          <div className="max-w-2xl">
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 font-['JetBrains_Mono']">See it work</div>
            <h2 className="text-3xl font-extrabold mt-2">What's your job site's compliance score?</h2>
            <p className="text-xs text-slate-300 mt-2">
              Slide the counters to simulate a roster. Actual scores reflect records and their statuses, not insurance verification.
            </p>
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8 items-center">
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Total subcontractors on site</span>
                  <span className="font-['JetBrains_Mono'] font-bold text-white text-base">{calcTotal}</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="40"
                  value={calcTotal}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setCalcTotal(v)
                    if (calcCompliant > v) setCalcCompliant(v)
                  }}
                  className="w-full mt-2 accent-emerald-400"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-slate-300">
                  <span>Marked compliant in this example</span>
                  <span className="font-['JetBrains_Mono'] font-bold text-white text-base">{calcCompliant}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max={calcTotal}
                  value={calcCompliant}
                  onChange={(e) => setCalcCompliant(Number(e.target.value))}
                  className="w-full mt-2 accent-emerald-400"
                />
              </div>

              <div className="text-xs text-slate-400">
                {calcTotal - calcCompliant} subcontractor{calcTotal - calcCompliant === 1 ? '' : 's'} with expiring, expired, or missing policies — each a potential stop-work order.
              </div>
            </div>

            <div className="flex flex-col items-center justify-center text-center p-8 rounded-2xl bg-white/5 border border-white/10">
              <div className="text-6xl sm:text-7xl font-extrabold font-['JetBrains_Mono'] text-transparent bg-clip-text bg-gradient-to-r from-emerald-300 via-sky-300 to-brand-300">
                {score}%
              </div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mt-2">compliance score</div>
              <div className="mt-3 text-xs text-slate-300">
                {score >= 90 ? 'Healthy — audit-ready' : score >= 70 ? 'Action needed — send renewals' : 'High risk — stop-work exposure'}
              </div>
              <Link
                to="/login"
                className="mt-6 inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-xs font-bold text-slate-950 bg-emerald-300 hover:bg-emerald-400 transition"
              >
                Sign in to see it live <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-6xl mx-auto px-4 sm:px-6 py-20 border-t border-slate-200">
        <div className="text-center max-w-2xl mx-auto">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">PRICING</div>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 mt-2">
            Simple, honest pricing for every side of the job site.
          </h2>
          <p className="mt-3 text-sm text-slate-500 leading-relaxed">
            Subcontractors use COI Shield for free. General Contractor plans have no contracts and can be canceled anytime.
          </p>
        </div>

        <div className="mt-12 grid md:grid-cols-3 gap-6 items-stretch">
          {/* Subcontractor */}
          <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-card flex flex-col justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">FOR SUBCONTRACTORS</div>
              <h3 className="text-xl font-extrabold text-slate-900 mt-1">Subcontractor</h3>
              <p className="text-xs text-slate-500 mt-2 min-h-[40px]">
                Submit your insurance certificate once and keep it ready for any contractor who asks.
              </p>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold text-slate-900 font-['JetBrains_Mono']">$0</span>
                <span className="text-xs text-slate-400 font-medium">for subcontractors</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-['JetBrains_Mono']">No subcontractor fees</div>
              <ul className="mt-7 space-y-3 text-xs text-slate-600">
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> <strong>Free for subcontractors</strong> — no fee to upload or keep certificates on file</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Upload your COI and share it with connected contractors</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> View expiration dates for certificates on file</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Self-service upload link for submitting your COI</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Certificate stored securely, share-ready anytime</li>
              </ul>
            </div>
            <Link
              to="/login"
              className="mt-8 w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-xs font-bold text-slate-900 bg-slate-100 hover:bg-slate-200 transition"
            >
              Get started
            </Link>
          </div>

          {/* General Contractor — MOST POPULAR */}
          <div className="rounded-2xl border-2 border-brand-600 bg-white p-7 shadow-xl shadow-brand-500/10 flex flex-col justify-between relative ring-1 ring-brand-500/30">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2">
              <span className="px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider bg-brand-600 text-white font-['JetBrains_Mono'] shadow-sm">
                Most popular
              </span>
            </div>
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">FOR GENERAL CONTRACTORS</div>
              <h3 className="text-xl font-extrabold text-slate-900 mt-1">General Contractor</h3>
              <p className="text-xs text-slate-500 mt-2 min-h-[40px]">
                See every subcontractor COI connected to you in one dashboard, and share compliance with clients whenever you want.
              </p>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold text-slate-900 font-['JetBrains_Mono']">$10</span>
                <span className="text-xs text-slate-400 font-medium">/ month</span>
              </div>
              <ul className="mt-7 space-y-3 text-xs text-slate-600">
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> <strong>See all subcontractor COIs</strong> connected to you, with status and countdowns</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> <strong>Optionally share compliance with clients</strong> through privacy-safe links</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Subcontractor contact info is strictly hidden from clients</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Reminder emails are simulated and are not delivered</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Printable project reports and compliance scorecards</li>
              </ul>
            </div>
            <Link
              to="/login"
              className="mt-8 w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition shadow-sm"
            >
              Start tracking
            </Link>
          </div>

          {/* Pro GC */}
          <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-card flex flex-col justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 font-['JetBrains_Mono']">FOR GROWING CONTRACTORS</div>
              <h3 className="text-xl font-extrabold text-slate-900 mt-1">Pro GC</h3>
              <p className="text-xs text-slate-500 mt-2 min-h-[40px]">
                For contractors running multiple active jobs, crews, and client stakeholders at once.
              </p>
              <div className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-extrabold text-slate-900 font-['JetBrains_Mono']">$29</span>
                <span className="text-xs text-slate-400 font-medium">/ month</span>
              </div>
              <ul className="mt-7 space-y-3 text-xs text-slate-600">
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Everything in the General Contractor plan</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Unlimited projects and unlimited subcontractors</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> View expiration information in the dashboard</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> CSV/spreadsheet exports for audits</li>
                <li className="flex items-start gap-2"><Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> Priority support</li>
              </ul>
            </div>
            <Link
              to="/login"
              className="mt-8 w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-xs font-bold text-slate-900 bg-slate-100 hover:bg-slate-200 transition"
            >
              Go Pro
            </Link>
          </div>
        </div>

        <p className="text-center text-xs text-slate-400 mt-8">
          Client reports are designed to omit subcontractor contact details. Email reminders are simulated and are not delivered.
        </p>
      </section>

      {/* FAQ */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-20">
        <div className="text-center">
          <div className="text-xs font-bold uppercase tracking-wider text-brand-600 font-['JetBrains_Mono']">FAQ</div>
          <h2 className="text-3xl font-extrabold text-slate-900 mt-2">Questions we hear from contractors</h2>
        </div>

        <div className="mt-10 space-y-4">
          {faqs.map((f, i) => (
            <details key={i} className="group bg-white rounded-2xl border border-slate-200 p-5 shadow-card open:ring-2 open:ring-brand-500/30">
              <summary className="font-bold text-sm text-slate-900 cursor-pointer list-none flex items-center justify-between">
                <span>{f.q}</span>
                <span className="text-slate-400 group-open:rotate-90 transition font-['JetBrains_Mono']">›</span>
              </summary>
              <p className="mt-3 text-xs text-slate-600 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA Footer */}
      <section className="bg-brand-950 text-white py-16">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <h2 className="text-3xl sm:text-4xl font-extrabold">Ready to never lose a COI again?</h2>
          <p className="text-xs text-slate-300 mt-2">
            Explore the GC dashboard, try the sub upload wizard, and preview the client portal in two minutes.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-bold text-slate-950 bg-gradient-to-r from-emerald-300 to-emerald-400 hover:from-emerald-400 hover:to-emerald-500 transition shadow-lg shadow-emerald-500/30"
            >
              Sign in to get started <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/share/rcc-meridian-2026"
              className="inline-flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-bold text-white bg-white/10 hover:bg-white/15 backdrop-blur transition border border-white/15"
            >
              View sample client portal
            </Link>
          </div>
          <p className="text-[11px] text-slate-500 mt-6">
            Railway deployment-ready · PostgreSQL + AWS S3 · client-safe privacy by design
          </p>
        </div>
      </section>
    </div>
  )
}

function AlertBadge(props: any) {
  return <Clock {...props} />
}
