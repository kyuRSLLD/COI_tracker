import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldCheck, ArrowRight } from 'lucide-react'
import { apiLogin, apiRegister, getToken } from '../api'
import { formatPhone, US_PHONE_PATTERN } from '../lib/formatPhone'
import type { User } from '../types'

const inputClassName = 'w-full min-w-0 px-3 py-2 rounded-xl border border-slate-200 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-700 focus-visible:ring-offset-2'
const focusClassName = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-700 focus-visible:ring-offset-2'

export function LoginPage({ onLogin, getSessionVersion }: { onLogin: (session: { token: string; user: User }, version: number) => Promise<void>; getSessionVersion: () => number }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState<'gc' | 'sub'>('gc')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const startingToken = getToken()
    const startingVersion = getSessionVersion()
    try {
      const data = mode === 'login'
        ? await apiLogin(email, password)
        : await apiRegister({
            email,
            password,
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            name: [firstName.trim(), lastName.trim()].filter(Boolean).join(' '),
            phone: phone.trim(),
            company_name: company.trim() || undefined,
            role,
          })
      if (getToken() !== startingToken) throw new Error('Your session changed. Please try signing in again.')
      await onLogin(data, startingVersion)
      const r = data.user.role
      navigate(r === 'admin' ? '/staff' : r === 'sub' ? '/subcontractor' : '/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="mx-auto w-full max-w-md text-center">
        <Link to="/" className={`inline-flex items-center gap-2.5 rounded-xl ${focusClassName}`}>
          <div className="w-10 h-10 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-sm">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <span className="font-extrabold text-2xl text-slate-900 tracking-tight">COI Shield</span>
        </Link>
        <h2 className="mt-4 text-xl font-extrabold text-slate-900">
          {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          {mode === 'login' ? 'Enter your email and password to continue' : 'Choose your role and get started'}
        </p>
      </div>

      <div className="mt-6 mx-auto w-full max-w-md">
        <div className="bg-white px-4 py-6 shadow-card border border-slate-200 rounded-3xl space-y-4 sm:px-6 sm:py-8">
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && (
              <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800 break-words">{error}</div>
            )}

            {mode === 'register' && (
              <>
                <fieldset className="space-y-1">
                  <legend className="text-[11px] font-semibold text-slate-600">I am a</legend>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setRole('gc')}
                      aria-pressed={role === 'gc'}
                      className={`min-w-0 min-h-11 px-2 py-2 rounded-xl border font-semibold ${focusClassName} ${
                        role === 'gc'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      General Contractor
                    </button>
                    <button
                      type="button"
                      onClick={() => setRole('sub')}
                      aria-pressed={role === 'sub'}
                      className={`min-w-0 min-h-11 px-2 py-2 rounded-xl border font-semibold ${focusClassName} ${
                        role === 'sub'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Subcontractor
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500">Existing platform administrators should use the normal sign-in form.</p>
                </fieldset>

                <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-2">
                  <div className="min-w-0 space-y-1">
                    <label htmlFor="register-first-name" className="text-[11px] font-semibold text-slate-600">First name</label>
                    <input
                      id="register-first-name"
                      required
                      autoComplete="given-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="Jane"
                      className={inputClassName}
                    />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <label htmlFor="register-last-name" className="text-[11px] font-semibold text-slate-600">Last name</label>
                    <input
                      id="register-last-name"
                      required
                      autoComplete="family-name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Doe"
                      className={inputClassName}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label htmlFor="register-phone" className="text-[11px] font-semibold text-slate-600">Phone number</label>
                  <input
                    id="register-phone"
                    required
                    type="tel"
                    autoComplete="tel-national"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    placeholder="(312) 555-0199"
                    pattern={US_PHONE_PATTERN}
                    title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format"
                    className={inputClassName}
                  />
                  <p className="text-[10px] text-slate-400">Your email remains your sign-in identifier. You can add more phone numbers anytime in your profile.</p>
                </div>
                <div className="space-y-1">
                  <label htmlFor="register-company" className="text-[11px] font-semibold text-slate-600">Company name</label>
                  <input
                    id="register-company"
                    autoComplete="organization"
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Acme Construction"
                    className={inputClassName}
                  />
                </div>
              </>
            )}

            <div className="space-y-1">
              <label htmlFor="auth-email" className="text-[11px] font-semibold text-slate-600">Email</label>
              <input
                id="auth-email"
                required
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="auth-password" className="text-[11px] font-semibold text-slate-600">Password</label>
              <input
                id="auth-password"
                required
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClassName}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={`w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 disabled:opacity-50 transition shadow-sm ${focusClassName}`}
            >
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="pt-2 text-center text-xs text-slate-400">
            {mode === 'login' ? (
              <button type="button" onClick={() => setMode('register')} className={`rounded hover:underline ${focusClassName}`}>Need an account? Register</button>
            ) : (
              <button type="button" onClick={() => setMode('login')} className={`rounded hover:underline ${focusClassName}`}>Have an account? Sign in</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
