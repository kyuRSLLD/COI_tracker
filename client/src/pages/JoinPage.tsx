import { Button } from '../components/Button'
import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ShieldCheck, CheckCircle2, ArrowRight, Sparkles, Building2, Lock, UserPlus, LogIn } from 'lucide-react'
import { apiSub, apiLogin, apiRegister, getToken } from '../api'
import type { JoinInfo, User } from '../types'
import { formatPhone, US_PHONE_PATTERN } from '../lib/formatPhone'

type Props = {
  user: User | null
  sessionToken: string | null
  sessionStatus: 'checking' | 'authenticated' | 'anonymous' | 'error'
  onSession: (session: { token: string; user: User }) => Promise<void>
  onSwitchAccount: () => void
}

export function JoinPage({ user: currentUser, sessionToken, sessionStatus, onSession, onSwitchAccount }: Props) {
  const { inviteCode = '' } = useParams<{ inviteCode: string }>()
  const [info, setInfo] = useState<JoinInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ message: string; token: string } | null>(null)
  const identityKey = `${sessionStatus}:${sessionToken ?? ''}`
  const identity = useRef({ key: identityKey, generation: 0 })
  if (identity.current.key !== identityKey) identity.current = { key: identityKey, generation: identity.current.generation + 1 }
  const generation = identity.current.generation
  const [workingFor, setWorkingFor] = useState<number | null>(null)
  const [consentFor, setConsentFor] = useState<number | null>(null)
  const working = workingFor === generation
  const [joinIntent, setJoinIntent] = useState<{ value: string; generation: number } | null>(null)
  const [intentRefresh, setIntentRefresh] = useState(0)
  const [reauthFor, setReauthFor] = useState<number | null>(null)
  const usableIntent = joinIntent?.generation === generation ? joinIntent.value : null
  const sharingConsent = consentFor === generation && !!usableIntent
  const active = useRef(true)
  useLayoutEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

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

  const hasSession = sessionStatus === 'authenticated' && !!currentUser

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setError(null)
        const res = await apiSub.joinInfo(inviteCode)
        if (!cancelled) setInfo(res)
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Invitation not found')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [inviteCode])

  // Obtain the version snapshot before allowing consent. Never reuse one from
  // another identity/session or an earlier failed request.
  useEffect(() => {
    if (!info?.valid || sessionStatus !== 'authenticated' || currentUser?.role !== 'sub' || !sessionToken) return
    let cancelled = false
    const token = sessionToken
    setJoinIntent(null)
    setConsentFor(null)
    apiSub.joinIntent(inviteCode, token).then(result => {
      if (!cancelled && active.current && getToken() === token && identity.current.generation === generation) {
        setJoinIntent({ value: result.intent, generation })
        setReauthFor(null)
      }
    }).catch((err: any) => {
      if (!cancelled && active.current && getToken() === token && identity.current.generation === generation) {
        setReauthFor(err.status === 401 && err.code === 'JOIN_SESSION_REAUTH_REQUIRED' ? generation : null)
        setError(err.message || 'Unable to prepare connection')
      }
    })
    return () => { cancelled = true }
  }, [inviteCode, info?.valid, sessionStatus, currentUser?.role, sessionToken, generation, intentRefresh])

  const gcName = info?.gc.company_name || 'the general contractor'

  const handleAuthenticatedJoin = async () => {
    if (!sharingConsent || !usableIntent || !sessionToken || !info?.valid) return
    setWorkingFor(generation)
    setError(null)
    const token = sessionToken
    try {
      const res = await apiSub.join(inviteCode, usableIntent, token)
      if (active.current && getToken() === token && identity.current.generation === generation) {
        setSuccess({ token, message: `You're now linked to ${res.gc_company_name || gcName}. They can access the certificates you own through this connection.` })
      }
    } catch (err: any) {
      if (active.current && identity.current.generation === generation && getToken() === token) {
        setConsentFor(null)
        setJoinIntent(null)
        setReauthFor(err.status === 401 && err.code === 'JOIN_SESSION_REAUTH_REQUIRED' ? generation : null)
        setError(err.message || 'Unable to connect your account. Please review and consent again.')
        if (!(err.status === 401 && err.code === 'JOIN_SESSION_REAUTH_REQUIRED')) setIntentRefresh(value => value + 1)
      }
    } finally {
      if (active.current) setWorkingFor((value) => value === generation ? null : value)
    }
  }

  const handleNewSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!info?.valid || sessionStatus !== 'anonymous' || getToken()) return
    setWorkingFor(generation)
    setError(null)
    try {
      const fullName = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ')
      const res = await apiRegister({
        email, password, name: fullName, company_name: company, trade, phone, role: 'sub',
      })
      // A different session may have appeared while registration was pending.
      // The account remains created; do not silently replace that session.
      if (!active.current) return
      if (getToken() || identity.current.generation !== generation) {
        setError('Your account was created, but your session changed. Sign out and sign in with the new account to connect.')
        return
      }
      await onSession(res)
      setPassword('')
      if (active.current) setError('Account created. Review the sharing terms and check the box to connect.')
    } catch (err: any) {
      if (active.current && identity.current.generation === generation && !getToken()) setError(err.message)
    } finally {
      if (active.current) setWorkingFor((value) => value === generation ? null : value)
    }
  }

  const handleExistingConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!info?.valid || sessionStatus !== 'anonymous' || getToken()) return
    setWorkingFor(generation)
    setError(null)
    try {
      const res = await apiLogin(existEmail, existPassword)
      if (!active.current || getToken() || identity.current.generation !== generation) return
      await onSession(res)
      setExistPassword('')
      if (active.current) setError('Signed in. Review the sharing terms and check the box to connect.')
    } catch (err: any) {
      if (active.current && identity.current.generation === generation && !getToken()) setError(err.message)
    } finally {
      if (active.current) setWorkingFor((value) => value === generation ? null : value)
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
            <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
          )}

          {success && sessionStatus === 'authenticated' && success.token === sessionToken ? (
            <div className="text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 mx-auto flex items-center justify-center">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <p className="text-xs text-slate-700">{success.message}</p>
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
          ) : info?.valid ? (
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

              {/* Free subcontractor account pill */}
              <div className="rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200 p-3 flex items-start gap-2.5 text-xs text-emerald-900">
                <Sparkles className="w-3.5 h-3.5 text-emerald-600 mt-0.5 shrink-0" />
                <p>
                  <span className="font-semibold">Free for subcontractors.</span> Upload your COI and keep it on file at no charge.
                </p>
              </div>

              <div id="sharing-disclosure" className="space-y-2 text-xs text-slate-700">
                <p>
                  Connecting gives {gcName} ongoing access to your profile and <strong>all current and future certificates of insurance (COIs) you own</strong>. {gcName} may also include anonymized insurance information in client reports they share.
                </p>
                <p>
                  When connection removal is available, you can disconnect this general contractor from your subcontractor dashboard to stop future access through the connection. Removal may be temporarily unavailable. Previously issued download links may work briefly, and files already downloaded cannot be recalled.
                </p>
              </div>

              {hasSession && currentUser?.role === 'sub' && <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <input
                  type="checkbox"
                  aria-describedby="sharing-disclosure"
                  checked={sharingConsent}
                  disabled={!usableIntent || working}
                  onChange={(e) => setConsentFor(e.target.checked ? generation : null)}
                  className="mt-0.5 shrink-0"
                />
                <span>I agree to give {gcName} ongoing access to my profile and all current and future COIs I own, including possible sharing of anonymized insurance information in client reports.</span>
              </label>}
              {hasSession && currentUser?.role === 'sub' && !usableIntent && reauthFor !== generation && <button type="button" onClick={() => setIntentRefresh(value => value + 1)} className="text-xs underline">Refresh connection request</button>}
              {sessionStatus === 'anonymous' && <p className="text-xs text-slate-600">First sign in or create an account. You will then review and consent to sharing before any connection is made.</p>}

              {/* Already authenticated branch */}
              {hasSession && (
                <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 text-xs text-indigo-900 space-y-2">
                  <p>
                    Signed in as <span className="font-semibold">{currentUser?.email}</span>
                  </p>
                  {currentUser?.role === 'sub' ? <Button
                    type="button"
                    variant="primary"
                    full
                    onClick={handleAuthenticatedJoin}
                    disabled={working || !sharingConsent}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {working ? 'Linking…' : `Connect my account to ${gcName}`}
                  </Button> : <p>Only subcontractor accounts can connect to this invitation.</p>}
                  {currentUser?.role === 'sub' && <p className="text-[11px] text-indigo-700/80">
                    Connecting again requires fresh consent.
                  </p>}
                  <Button type="button" variant="secondary" full disabled={working} onClick={() => { onSwitchAccount(); setError(null); setConsentFor(null); setReauthFor(null); setTab('existing') }}>{reauthFor === generation ? 'Sign out and sign in again' : 'Switch account'}</Button>
                </div>
              )}

              {/* Two tabs: new vs existing account */}
              {sessionStatus === 'checking' && <p className="text-xs text-slate-500">Checking your session…</p>}
              {sessionStatus === 'anonymous' && (
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
                      <UserPlus className="w-3.5 h-3.5" /> Create free account
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
                            minLength={8}
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
                          onChange={(e) => setPhone(formatPhone(e.target.value))}
                          placeholder="(312) 555-0199"
                          pattern={US_PHONE_PATTERN}
                          title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format"
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200"
                        />
                      </div>
                      <Button type="submit" variant="primary" full disabled={working}>
                        {working ? 'Creating account…' : 'Create account'}
                      </Button>
                    </form>
                  ) : (
                    <form onSubmit={handleExistingConnect} className="space-y-3 text-xs">
                      <p className="text-[11px] text-slate-500">
                        Sign in with your subcontractor account, then review and consent to connect.
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
                      <Button type="submit" variant="primary" full disabled={working}>
                        {working ? 'Connecting…' : 'Sign in'}
                      </Button>
                    </form>
                  )}
                </>
              )}

              <p className="text-[11px] text-slate-400 text-center">
                Scanning a printed QR code on a job site? This page was opened by that code — you're already in the right place.
              </p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
