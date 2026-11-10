import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldCheck, ArrowRight, Sparkles } from 'lucide-react'
import { apiLogin, apiRegister } from '../api'

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
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
        : await apiRegister({ email, password, name, company_name: company, role })
      onLogin()
      const r = data.user.role
      navigate(r === 'admin' ? '/staff' : r === 'sub' ? '/subcontractor' : '/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const fill = (em: string, pw: string) => {
    setEmail(em)
    setPassword(pw)
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
          {mode === 'login' ? 'Enter your credentials or try a demo below' : 'Choose your role and get started'}
        </p>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-card border border-slate-200 sm:rounded-3xl space-y-4">
          {/* Demo account buttons */}
          <div className="text-[11px] text-slate-500 space-y-1.5">
            <p className="font-semibold text-slate-600">Demo accounts (click to fill):</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => fill('gc@apexconstruction.demo', 'password123')}
                className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700"
              >
                GC · Apex Construction
              </button>
              <button
                type="button"
                onClick={() => fill('sub@horizonelectric.demo', 'password123')}
                className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700"
              >
                Sub · Horizon Electric
              </button>
              <button
                type="button"
                onClick={() => fill('sub2@blueridgeplumbing.demo', 'password123')}
                className="px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700"
              >
                Sub (no COI) · Blue Ridge
              </button>
              <button
                type="button"
                onClick={() => fill('kyuchang@gmail.com', 'password123')}
                className="px-2.5 py-1 rounded-lg border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-semibold"
              >
                Staff admin
              </button>
            </div>
          </div>

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
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800">free 30d</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600">Your name</label>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold text-slate-600">Company name</label>
                  <input
                    value={company}
                    onChange={(e) => setCompany(e.target.value)}
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
