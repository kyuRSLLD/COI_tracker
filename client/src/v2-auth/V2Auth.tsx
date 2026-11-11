import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ShieldCheck } from 'lucide-react'

type Role = 'gc' | 'sub'
type Screen = 'login' | 'request' | 'confirm' | 'registration-result' | 'signed-in'
type LoginResult = { token: string; token_type: 'Bearer'; expires_in: number; expiresAt: number }

/** The host must keep this bearer credential in memory only and handle expiry/logout. */
export type V2AuthProps = { onAuthenticated?: (session: LoginResult) => void }

const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2'
const input = `block w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 placeholder:text-slate-400 ${focus}`
const label = 'block text-sm font-semibold text-slate-700'
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/
const phonePattern = /^(?:\+1[ .-]?|1[ .-]?)?(?:\([2-9][0-9]{2}\)|[2-9][0-9]{2})[ .-]?[2-9][0-9]{2}[ .-]?[0-9]{4}$/
const codePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const validText = (value: string, max: number) => value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const validEmail = (email: string) => email.length <= 254 && emailPattern.test(email)
const validPassword = (password: string) => [...password].length >= 12 && new TextEncoder().encode(password).length <= 256

async function post(path: string, body: object): Promise<Response> {
  return fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error',
    mode: 'same-origin', referrerPolicy: 'no-referrer',
  })
}

function Field({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return <div className="space-y-1.5"><label className={label} htmlFor={id}>{title}</label>{children}{hint && <p id={`${id}-hint`} className="text-xs leading-5 text-slate-500">{hint}</p>}</div>
}

/** Standalone UI. No routing, storage, global session state, or backend wiring is installed. */
export function V2Auth({ onAuthenticated }: V2AuthProps) {
  const [screen, setScreen] = useState<Screen>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [company, setCompany] = useState('')
  const [trade, setTrade] = useState('')
  const [role, setRole] = useState<Role>('gc')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousScreen = useRef<Screen>(screen)

  useEffect(() => {
    if (previousScreen.current !== screen) headingRef.current?.focus()
    previousScreen.current = screen
  }, [screen])

  function go(next: Screen) {
    setError('')
    setPassword('')
    setToken('')
    setScreen(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    const normalizedEmail = email.trim().toLowerCase()
    if ((screen === 'login' || screen === 'request') && !validEmail(normalizedEmail)) {
      setError('Enter a valid email address.'); return
    }
    if (screen === 'login' && (!password || new TextEncoder().encode(password).length > 256)) {
      setError('Enter your password (up to 256 UTF-8 bytes).'); return
    }
    if (screen === 'confirm') {
      if (!codePattern.test(token)) { setError('Enter the complete 43-character verification code from your email.'); return }
      if (!validText(firstName, 100) || !validText(lastName, 100)) { setError('Enter your first and last name (up to 100 characters each).'); return }
      if (phone.length > 32 || !phonePattern.test(phone.trim())) { setError('Enter a complete US phone number without an extension.'); return }
      if (!validPassword(password)) { setError('Use at least 12 characters and no more than 256 UTF-8 bytes for your password.'); return }
      if (role === 'sub' && (!validText(company, 200) || !validText(trade, 200))) { setError('Enter your company name and trade (up to 200 characters each).'); return }
    }
    setBusy(true)
    let session: LoginResult | undefined
    try {
      if (screen === 'login') {
        const loginStartedAt = Date.now()
        const res = await post('/api/v2/auth/login', { email: normalizedEmail, password })
        if (res.status === 401) { setError('Email or password could not be verified.'); return }
        if (res.status === 400) { setError('Check your email and password and try again.'); return }
        if (res.status !== 200) { setError('Sign-in is unavailable right now. Please try again later.'); return }
        const data: unknown = await res.json()
        if (!data || typeof data !== 'object' || !('token' in data) || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token) || data.token.length > 8192 || !('token_type' in data) || data.token_type !== 'Bearer' || !('expires_in' in data) || typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0) {
          setError('Sign-in is unavailable right now. Please try again later.'); return
        }
        // The server issues the JWT during the request and uses whole-second
        // timestamps. Do not add transit/processing time to its lifetime.
        const expiresAt = loginStartedAt + (Math.min(data.expires_in, 900) - 1) * 1000
        if (Date.now() >= expiresAt) { setError('Sign-in expired before it could be used. Please try again.'); return }
        session = { token: data.token, token_type: 'Bearer', expires_in: data.expires_in, expiresAt }
        setPassword('')
        setScreen('signed-in')
      } else if (screen === 'request') {
        const res = await post('/api/v2/auth/register/request', { email: normalizedEmail })
        if (res.status === 400) { setError('Check your email address and try again.'); return }
        if (res.status !== 202) { setError('Registration is unavailable right now. An email may or may not have been sent; please try again later.'); return }
        setEmail(normalizedEmail)
        setScreen('confirm')
      } else if (screen === 'confirm') {
        const body = { token, role, password, first_name: firstName.trim(), last_name: lastName.trim(), phone: phone.trim(), ...(role === 'sub' ? { company_name: company.trim(), trade: trade.trim() } : {}) }
        const res = await post('/api/v2/auth/register/confirm', body)
        if (res.status === 400 || res.status === 413) { setError('Check the code and your details, including your US phone number, then try again.'); return }
        if (res.status !== 200) { setError('Registration is unavailable. We could not confirm the outcome; try signing in before trying again.'); return }
        setToken('')
        setPassword('')
        setScreen('registration-result')
      }
    } catch {
      setError(screen === 'confirm' ? 'Could not reach the service. We could not confirm the outcome; try signing in before trying again.' : screen === 'request' ? 'Could not reach the service. An email may or may not have been sent; try again later.' : 'Could not reach the sign-in service. Please try again later.')
    } finally {
      setBusy(false)
    }
    // Invoke outside the network try/catch so host failures are not reported as API failures.
    if (session && onAuthenticated) onAuthenticated(session)
  }

  const heading = screen === 'login' ? 'Sign in to your account' : screen === 'request' ? 'Create an account' : screen === 'confirm' ? 'Complete your registration' : screen === 'registration-result' ? 'Try signing in' : 'Signed in'
  return <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900 sm:px-6 sm:py-14">
    <div className="mx-auto w-full max-w-[480px]">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white" aria-hidden="true"><ShieldCheck className="h-6 w-6" /></span>
        <span className="text-xl font-extrabold tracking-tight">COI Shield</span>
      </div>
      <section aria-labelledby="v2-auth-heading" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-card sm:p-8">
        <div className="mb-6">
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-brand-700">{screen === 'login' || screen === 'signed-in' ? 'Account access' : 'Account registration'}</p>
          <h1 id="v2-auth-heading" ref={headingRef} tabIndex={-1} className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">{heading}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {screen === 'login' && 'Enter your email and password to continue.'}
            {screen === 'request' && 'Start with your email. If eligible, you’ll receive a verification code.'}
            {screen === 'confirm' && 'If eligible, check your email for a code. Enter it along with your account details below.'}
            {screen === 'registration-result' && 'If eligible, registration is complete. Account creation is not confirmed by this response; try signing in to check.'}
            {screen === 'signed-in' && (onAuthenticated ? 'Your sign-in was successful.' : 'Your sign-in was successful. This standalone preview has no destination connected.')}
          </p>
        </div>
        {error && <div role="alert" className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-5 text-rose-800">{error}</div>}
        {(screen === 'login' || screen === 'request' || screen === 'confirm') && <form onSubmit={submit} className="space-y-5">
          <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
            {(screen === 'login' || screen === 'request') && <Field id="v2-email" title="Email address"><input id="v2-email" className={input} type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></Field>}
            {screen === 'confirm' && <>
              <Field id="v2-code" title="Verification code" hint="Paste the 43-character code from your email. It expires after 10 minutes."><input id="v2-code" className={input} autoComplete="off" autoCapitalize="none" spellCheck={false} required aria-describedby="v2-code-hint" value={token} onChange={e => setToken(e.target.value)} /></Field>
              <fieldset><legend className={label}>I am a</legend><div className="mt-2 grid grid-cols-2 gap-2">{([['gc', 'General contractor'], ['sub', 'Subcontractor']] as const).map(([value, text]) => <label key={value} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold ${role === value ? 'border-slate-900 bg-slate-50 text-slate-900' : 'border-slate-200 text-slate-600'}`}><input type="radio" name="v2-role" value={value} checked={role === value} onChange={() => setRole(value)} className="h-4 w-4 accent-slate-900" />{text}</label>)}</div></fieldset>
              <div className="grid gap-5 sm:grid-cols-2"><Field id="v2-first" title="First name"><input id="v2-first" className={input} autoComplete="given-name" required maxLength={100} value={firstName} onChange={e => setFirstName(e.target.value)} /></Field><Field id="v2-last" title="Last name"><input id="v2-last" className={input} autoComplete="family-name" required maxLength={100} value={lastName} onChange={e => setLastName(e.target.value)} /></Field></div>
              <Field id="v2-phone" title="US phone number" hint="Enter a complete US number, without an extension."><input id="v2-phone" className={input} type="tel" autoComplete="tel" required placeholder="(312) 555-0199" aria-describedby="v2-phone-hint" value={phone} onChange={e => setPhone(e.target.value)} /></Field>
              {role === 'sub' && <><Field id="v2-company" title="Company name"><input id="v2-company" className={input} autoComplete="organization" required maxLength={200} value={company} onChange={e => setCompany(e.target.value)} /></Field><Field id="v2-trade" title="Trade"><input id="v2-trade" className={input} required maxLength={200} value={trade} onChange={e => setTrade(e.target.value)} /></Field></>}
            </>}
            {(screen === 'login' || screen === 'confirm') && <Field id="v2-password" title="Password" hint={screen === 'confirm' ? 'At least 12 characters; maximum 256 UTF-8 bytes.' : undefined}><input id="v2-password" className={input} type="password" autoComplete={screen === 'confirm' ? 'new-password' : 'current-password'} required aria-describedby={screen === 'confirm' ? 'v2-password-hint' : undefined} value={password} onChange={e => setPassword(e.target.value)} /></Field>}
            <button type="submit" className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 disabled:cursor-wait ${focus}`}>{busy ? 'Please wait…' : screen === 'login' ? 'Sign in' : screen === 'request' ? 'Send verification code' : 'Submit registration'}<ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
          </fieldset>
        </form>}
        <div className="mt-6 border-t border-slate-100 pt-5 text-sm text-slate-600">
          {screen === 'login' ? <>Need an account? <button type="button" disabled={busy} onClick={() => go('request')} className={`rounded font-bold text-brand-700 hover:underline ${focus}`}>Create account</button></> : screen === 'request' ? <>Already have an account? <button type="button" disabled={busy} onClick={() => go('login')} className={`rounded font-bold text-brand-700 hover:underline ${focus}`}>Sign in</button></> : screen === 'confirm' ? <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" disabled={busy} onClick={() => go('request')} className={`inline-flex items-center gap-1 rounded font-semibold text-brand-700 hover:underline ${focus}`}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Change email or request again</button><button type="button" disabled={busy} onClick={() => go('login')} className={`rounded font-semibold text-brand-700 hover:underline ${focus}`}>Sign in</button></div> : screen === 'registration-result' ? <button type="button" onClick={() => go('login')} className={`rounded font-bold text-brand-700 hover:underline ${focus}`}>Go to sign in</button> : null}
        </div>
      </section>
      <p className="mt-5 text-xs leading-5 text-slate-500">COI Shield · Account access</p>
    </div>
  </main>
}
