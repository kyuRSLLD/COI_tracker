import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { apiLogin, apiRegister } from '../api'

interface Props {
  onLogin: () => void
}

export function LoginPage({ onLogin }: Props) {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const data = mode === 'login'
        ? await apiLogin(email, password)
        : await apiRegister({ email, password, name, company_name: company })
      onLogin()
      navigate(data.user.role === 'admin' ? '/staff' : '/dashboard')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const fillDemo = () => {
    setEmail('gc@apexconstruction.demo')
    setPassword('password123')
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
          {mode === 'login' ? 'Enter your credentials or try the demo' : 'Register your company profile'}
        </p>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-6 shadow-card border border-slate-200 sm:rounded-3xl space-y-4">
          <button
            type="button"
            onClick={fillDemo}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 hover:bg-emerald-100 transition"
          >
            Fill demo account — Apex Construction Group
          </button>

          {error && <div className="p-3 rounded-xl bg-rose-50 text-rose-700 text-xs border border-rose-200">{error}</div>}

          <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            {mode === 'register' && (
              <>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Your name</label>
                  <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" placeholder="Michael Vance" />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Company name</label>
                  <input value={company} onChange={(e) => setCompany(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white" placeholder="Apex Construction Group" />
                </div>
              </>
            )}

            <div>
              <label className="block font-semibold text-slate-700 mb-1">Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" placeholder="gc@apexconstruction.demo" />
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">Password</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white font-['JetBrains_Mono']" placeholder="password123" />
            </div>

            <button type="submit" disabled={loading} className="w-full mt-2 inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-2xl text-xs font-bold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 transition shadow-sm">
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
