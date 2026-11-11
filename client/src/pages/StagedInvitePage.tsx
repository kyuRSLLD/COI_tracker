import { useEffect, useState } from 'react'
import { apiLogin, apiLogout, apiStagedInvites, getStoredUser, getToken } from '../api'
import type { User } from '../types'
import { isInviteToken, pendingInviteKey, previewNotice } from '../lib/stagedInvites'

export function StagedInvitePage({ initialToken, onSignedIn, onConsumed }: { initialToken: string | null; onSignedIn: (user: User | null) => void; onConsumed: () => void }) {
  const [token, setToken] = useState<string | null>(() => initialToken || sessionStorage.getItem(pendingInviteKey))
  const [user, setUser] = useState<User | null>(() => getToken() ? getStoredUser() : null)
  const [inviter, setInviter] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!isInviteToken(token)) { setError('This invitation is invalid or missing. Ask for a new test invitation.'); return }
    if (!user || user.role !== 'sub') sessionStorage.setItem(pendingInviteKey, token)
    let active = true
    setLoading(true)
    apiStagedInvites.info(token).then(info => {
      const name = info.gc_company_name ?? info.inviter_company_name ?? info.inviter?.company_name ?? info.gc?.company_name ?? info.inviter_name ?? info.inviter?.name ?? info.gc_name ?? info.company_name
      if (typeof name !== 'string' || !name.trim()) throw new Error('Missing inviter')
      if (active) setInviter(name)
    }).catch(() => { if (active) setError('This invitation could not be loaded. It may be invalid or expired.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [token])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    if (!isInviteToken(token) || busy) return
    // Preserve only in sessionStorage if authentication is needed, never in the return URL.
    sessionStorage.setItem(pendingInviteKey, token)
    setBusy(true); setError('')
    try {
      const result = await apiLogin(email, password)
      setPassword('')
      setUser(result.user); onSignedIn(result.user)
      if (result.user.role !== 'sub') setError('Please sign in with a subcontractor account to continue.')
    } catch { setError('Unable to sign in. Check your credentials and try again.') }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!isInviteToken(token) || user?.role !== 'sub' || busy) return
    setBusy(true); setError('')
    try {
      const result = await apiStagedInvites.accept(token)
      if (result?.status !== 'staged') throw new Error('Unexpected status')
      sessionStorage.removeItem(pendingInviteKey)
      onConsumed()
      setToken(null)
      setDone(true)
    } catch { setError('Unable to record this test relationship. The invitation may be invalid or expired.') }
    finally { setBusy(false) }
  }
  return <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50">
    <section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
      <p className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-900">{previewNotice}</p>
      <h1 className="text-xl font-bold text-slate-900">Test subcontractor invitation</h1>
      {done ? <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">Test relationship recorded. No live subcontractor link or COI sharing was created.</p> : <>
        {loading && <p role="status" className="text-sm text-slate-600">Loading invitation…</p>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {inviter && <p className="text-sm text-slate-700"><strong>{inviter}</strong> invited you to try a test relationship.</p>}
        {inviter && user?.role === 'sub' && <div className="space-y-3">
          <p className="text-sm text-slate-600">Signed in as {user.email}. Confirm to record a test relationship only.</p>
          <button type="button" onClick={confirm} disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Recording…' : 'Confirm test relationship'}</button>
        </div>}
        {inviter && user && user.role !== 'sub' && <button type="button" onClick={() => { apiLogout(); setUser(null); onSignedIn(null); setError('') }} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Sign out and use a subcontractor account</button>}
        {inviter && !user && <form onSubmit={signIn} className="space-y-3">
          <h2 className="font-semibold text-sm">Sign in as a subcontractor</h2>
          <label className="block text-sm">Email<input required type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2" /></label>
          <label className="block text-sm">Password<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2" /></label>
          <button type="submit" disabled={busy} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>}
      </>}
    </section>
  </div>
}
