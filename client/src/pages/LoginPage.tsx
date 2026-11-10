import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldCheck, ArrowRight } from 'lucide-react'
import { apiLogin, apiRegister } from '../api'
import { formatPhone } from '../lib/formatPhone'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
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
      onLogin()
      const r = data.user.role
      navigate(r === 'admin' ? '/staff' : r === 'sub' ? '/subcontractor' : '/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link to="/" className="inline-flex items-center gap-2.5">
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

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-card border border-slate-200 sm:rounded-3xl space-y-4">
          <form onSubmit={handleSubmit} className="space-y-3">
            {error && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>
            )}

            {mode === 'register' && (
              <>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600">I am a</label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setRole('gc')}
                      className={`py-2 rounded-xl border font-semibold ${
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
                      className={`py-2 rounded-xl border font-semibold flex items-center justify-center gap-1 ${
                        role === 'sub'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      Subcontractor
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-slate-600">First name</label>
                    <input
                      required
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="Jane"
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-slate-600">Last name</label>
                    <input
                      required
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder="Doe"
                      className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600">Phone number</label>
                  <input
                    required
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(formatPhone(e.target.value))}
                    placeholder="(312) 555-0199"
                    pattern="\\(\d{3}\\) \d{3}-\d{4}"
                    title="Please enter a 10-digit phone number in (xxx) xxx-xxxx format"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
                  />
                  <p className="text-[10px] text-slate-400">Your email remains your sign-in identifier. You can add more phone numbers anytime in your profile.</p>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600">Company name</label>
                  <input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
                    placeholder="Acme Construction"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
                  />
                </div>
              </>
            )}

            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-600">Email</label>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-600">Password</label>
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 disabled:opacity-50 transition shadow-sm"
            >
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="pt-2 text-center text-xs text-slate-400">
            {mode === 'login' ? (
              <button onClick={() => setMode('register')} className="hover:underline">Need an account? Register</button>
            ) : (
              <button onClick={() => setMode('login')} className="hover:underline">Have an account? Sign in</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
