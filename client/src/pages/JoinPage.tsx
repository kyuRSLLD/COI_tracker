import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ShieldCheck, CheckCircle2, ArrowRight, Sparkles, Building2, Lock, UserPlus, LogIn } from 'lucide-react'
import { apiSub, apiRegister, apiLogin, setStoredUser, setToken, getStoredUser, getToken } from '../api'
import type { JoinInfo, User } from '../types'

export function JoinPage() {
  const { inviteCode = '' } = useParams<{ inviteCode: string }>()
  const [info, setInfo] = useState<JoinInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  // tabs
  const [tab, setTab] = useState<'new' | 'existing'>('new')

  // new account fields
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [company, setCompany] = useState('')
  const [trade, setTrade] = useState('')
  const [phone, setPhone] = useState('')

  // existing account fields
  const [existEmail, setExistEmail] = useState('')
  const [existPassword, setExistPassword] = useState('')

  const currentUser = getStoredUser()
  const hasSession = Boolean(getToken() && currentUser)

  useEffect(() => {
    (async () => {
      try {
        setError(null)
        const res = await apiSub.joinInfo(inviteCode)
        setInfo(res)
      } catch (err: any) {
        setError(err.message || 'Invitation not found')
      } finally {
        setLoading(false)
      }
    })()
  }, [inviteCode])

  const gcName = info?.gc.company_name || 'the general contractor'

  const handleAuthenticatedJoin = async () => {
    setWorking(true)
    setError(null)
    try {
      const res = await apiSub.join(inviteCode)
      setSuccess(`You're now linked to ${res.gc_company_name || gcName}. Any certificate on file is visible to them automatically.`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setWorking(false)
    }
  }

  const handleNewSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorking(true)
    setError(null)
    try {
      const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ')
      const res = await apiSub.join(inviteCode, {
        email,
        password,
        name: fullName,
        company_name: company,
        trade,
        phone,
      })
      if (res.token && res.user) {
        setToken(res.token)
        setStoredUser(res.user)
      }
      setSuccess(`Welcome, ${fullName}! Your account is created and linked to ${res.gc_company_name || gcName}. Upload your insurance paper whenever you're ready.`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setWorking(false)
    }
  }

  const handleExistingConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setWorking(true)
    setError(null)
    try {
      const res = await apiSub.join(inviteCode, {
        email: existEmail,
        password: existPassword,
      })
      if (res.token && res.user) {
        setToken(res.token)
        setStoredUser(res.user)
      }
      setSuccess(`Connected! Your account is now linked to ${res.gc_company_name || gcName}.`)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setWorking(false)
    }
  }

  if (loading) {
    return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">Loading invite…</div>
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link to="/" className="inline-flex items-center gap-2">
          <div className="w-9 h-9 rounded-2xl bg-slate-900 text-white flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <span className="font-semibold text-slate-900">COI Shield</span>
        </Link>
        <p className="mt-2 text-xs text-slate-500">Subcontractor insurance compliance made simple</p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 sm:px-10 rounded-2xl border border-slate-200 shadow-sm space-y-6">
          {error && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
          )}

          {success ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <p className="text-xs text-slate-700">{success}</p>
              <div className="flex flex-col gap-2 pt-2">
                <Link
                  to="/subcontractor"
                  className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 text-center inline-flex items-center justify-center gap-1.5"
                >
                  Go to your subcontractor portal <ArrowRight className="w-3.5 h-3.5" />
                </Link>
                <Link to="/" className="text-xs text-slate-400 hover:text-slate-600 text-center">
                  Back to home
                </Link>
              </div>
            </div>
          ) : (
            <>
              {/* GC invite card */}
              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50 text-xs">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-400">Invited by</p>
                    <p className="font-semibold text-slate-900">{gcName}</p>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-slate-200 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                  {info?.gc.email && <span>{info.gc.email}</span>}
                  {info?.gc.phone && <span>{info.gc.phone}</span>}
                </div>
              </div>

              {/* Free first month pill */}
              <div className="rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-3 flex items-start gap-2.5 text-xs text-emerald-900">
                <Sparkles className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                <p>
                  <span className="font-semibold">Free for your first month.</span> Upload or connect your COI in under two minutes — after 30 days it's just a $2 one-time fee to keep your certificate hosted.
                </p>
              </div>

              {/* Already authenticated branch */}
              {hasSession && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 text-xs text-indigo-900 space-y-2">
                  <p>
                    Signed in as <span className="font-semibold">{currentUser?.email}</span>
                  </p>
                  <button
                    type="button"
                    onClick={handleAuthenticatedJoin}
                    disabled={working}
                    className="w-full text-xs font-semibold py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition flex items-center justify-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {working ? 'Linking…' : `Connect my account to ${gcName}`}
                  </button>
                  <p className="text-[11px] text-indigo-700/80">
                    Already linked? No problem — scanning again is safe and idempotent.
                  </p>
                </div>
              )}

              {/* Two tabs: new vs existing account */}
              {!hasSession && (
                <>
                  <div className="flex border-b border-slate-200 text-xs">
                    <button
                      type="button"
                      onClick={() => setTab('new')}
                      className={`pb-2.5 px-3 font-semibold border-b-2 -mb-px flex items-center gap-1.5 ${
                        tab === 'new'
                          ? 'border-slate-900 text-slate-900'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      <UserPlus className="w-3.5 h-3.5" /> Create free account &amp; link
                    </button>
                    <button
                      type="button"
                      onClick={() => setTab('existing')}
                      className={`pb-2.5 px-3 font-semibold border-b-2 -mb-px flex items-center gap-1.5 ${
                        tab === 'existing'
                          ? 'border-slate-900 text-slate-900'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      <LogIn className="w-3.5 h-3.5" /> Existing account
                    </button>
                  </div>

                  {tab === 'new' ? (
                    <form onSubmit={handleNewSignUp} className="space-y-3 text-xs">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">First name</label>
                          <input
                            required
                            value={firstName}
                            onChange={(e) => setFirstName(e.target.value)}
                            placeholder="Elena"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">Last name</label>
                          <input
                            required
                            value={lastName}
                            onChange={(e) => setLastName(e.target.value)}
                            placeholder="Rossi"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">Email <span className="text-[10px] text-slate-400">(your sign-in identifier)</span></label>
                          <input
                            required
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@company.com"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">Password</label>
                          <input
                            required
                            type="password"
                            minLength={6}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">Company name</label>
                          <input
                            value={company}
                            onChange={(e) => setCompany(e.target.value)}
                            placeholder="Crestline Electrical"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-slate-500 mb-1">Trade</label>
                          <input
                            value={trade}
                            onChange={(e) => setTrade(e.target.value)}
                            placeholder="Electrical, HVAC…"
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Phone (optional)</label>
                        <input
                          type="tel"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="(312) 555-0199"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={working}
                        className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 transition"
                      >
                        {working ? 'Creating account…' : 'Start free & link to ' + gcName}
                      </button>
                    </form>
                  ) : (
                    <form onSubmit={handleExistingConnect} className="space-y-3 text-xs">
                      <p className="text-[11px] text-slate-500">
                        Sign in with the subcontractor account you already use — we'll link it to {gcName} in one step.
                      </p>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Email <span className="text-[10px] text-slate-400">(your sign-in identifier)</span></label>
                        <input
                          required
                          type="email"
                          value={existEmail}
                          onChange={(e) => setExistEmail(e.target.value)}
                          placeholder="you@company.com"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-500 mb-1">Password</label>
                        <input
                          required
                          type="password"
                          value={existPassword}
                          onChange={(e) => setExistPassword(e.target.value)}
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={working}
                        className="w-full text-xs font-semibold py-2 rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 transition"
                      >
                        {working ? 'Connecting…' : 'Sign in & link to ' + gcName}
                      </button>
                    </form>
                  )}
                </>
              )}

              <p className="text-[11px] text-slate-400 text-center">
                Scanning a printed QR code on a job site? This page was opened by that code — you're already in the right place.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
