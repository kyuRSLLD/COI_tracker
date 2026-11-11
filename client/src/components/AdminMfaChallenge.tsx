import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { User } from '../types'

type Session = { token: string; user: User }
type Enrollment = { secret?: string; manual_secret?: string; otp_uri?: string; otpauth_uri?: string; otpauth_url?: string; uri?: string }

async function postChallenge<T>(path: string, challengeToken: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${challengeToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    let message = `Request failed (${response.status}). Please try again or return to sign in.`
    try {
      const data = await response.json()
      if (typeof data.error === 'string') message = data.error
      else if (typeof data.message === 'string') message = data.message
    } catch { /* Keep the fallback message. */ }
    throw new Error(message)
  }
  return response.json()
}

export function AdminMfaChallenge({ challengeToken, enrolled, onVerified, onBack }: {
  challengeToken: string
  enrolled: boolean
  onVerified: (session: Session) => void
  onBack: () => void
}) {
  const [enrollment, setEnrollment] = useState<{ secret?: string; uri?: string } | null>(null)
  const [enrolling, setEnrolling] = useState(!enrolled)
  const [verifying, setVerifying] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const introRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => { introRef.current?.focus() }, [])

  async function enroll() {
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setEnrolling(true)
    setError(null)
    try {
      const data = await postChallenge<Enrollment>('/api/auth/admin-mfa/enroll', challengeToken, undefined, controller.signal)
      const secret = data.secret || data.manual_secret
      const uri = data.otp_uri || data.otpauth_uri || data.otpauth_url || data.uri
      if (!secret && !uri) throw new Error('Authenticator setup information was not provided. Please retry or return to sign in.')
      if (!controller.signal.aborted) setEnrollment({ secret, uri })
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not start authenticator setup.')
    } finally {
      if (!controller.signal.aborted) setEnrolling(false)
    }
  }

  useEffect(() => {
    // Deferring the request lets StrictMode cancel its initial development-only effect
    // before it can issue a second enrollment request.
    const timer = !enrolled ? window.setTimeout(() => { void enroll() }, 0) : undefined
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      requestRef.current?.abort()
    }
  }, [challengeToken, enrolled])

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    if (!/^[0-9]{6}$/.test(code)) {
      setError('Enter the six-digit code from your authenticator app.')
      return
    }
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    setVerifying(true)
    setError(null)
    try {
      const data = await postChallenge<Session>('/api/auth/admin-mfa/verify', challengeToken, { code }, controller.signal)
      if (typeof data.token !== 'string' || !data.token || !data.user || data.user.role !== 'admin') {
        throw new Error('The server did not return a valid administrator session. Please return to sign in.')
      }
      if (!controller.signal.aborted) onVerified(data)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Verification failed. Please try again.')
    } finally {
      if (!controller.signal.aborted) setVerifying(false)
    }
  }

  function back() {
    requestRef.current?.abort()
    onBack()
  }

  return (
    <div className="space-y-4">
      <p ref={introRef} tabIndex={-1} className="text-sm text-slate-600">Your password was accepted. Complete administrator verification to sign in.</p>
      {!enrolled && (
        <section className="space-y-3" aria-labelledby="authenticator-setup-title">
          <h3 id="authenticator-setup-title" className="text-sm font-bold text-slate-900">Set up an authenticator app</h3>
          {enrolling && <p role="status" className="text-xs text-slate-600">Preparing authenticator setup…</p>}
          {enrollment && (
            <>
              <p className="text-xs text-slate-600">Add this account to your authenticator app, then enter the six-digit code it generates. Setup is complete only after verification.</p>
              {enrollment.uri && <div className="flex justify-center"><QRCodeSVG value={enrollment.uri} size={180} role="img" aria-label="Authenticator setup QR code" /></div>}
              {enrollment.secret && <div className="space-y-1"><p className="text-xs font-semibold text-slate-700">Manual setup key</p><code className="block break-all rounded-xl bg-slate-100 p-3 text-xs text-slate-900 select-all">{enrollment.secret}</code></div>}
              {enrollment.uri && <details className="text-xs text-slate-600"><summary className="cursor-pointer font-semibold">Show setup URI</summary><code className="mt-2 block break-all select-all">{enrollment.uri}</code></details>}
              <p className="text-xs text-slate-500">Keep the setup key and URI private.</p>
            </>
          )}
          {!enrolling && !enrollment && <button type="button" onClick={() => void enroll()} className="text-xs font-semibold text-slate-800 underline">Retry setup</button>}
        </section>
      )}
      {error && <div role="alert" className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800">{error}</div>}
      {(enrolled || enrollment) && (
        <form onSubmit={verify} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="admin-mfa-code" className="text-xs font-semibold text-slate-600">Authenticator code</label>
            <input id="admin-mfa-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} aria-describedby="admin-mfa-help" className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" />
            <p id="admin-mfa-help" className="text-xs text-slate-500">Enter the current six-digit code from your authenticator app.</p>
          </div>
          <button type="submit" disabled={verifying || enrolling} className="w-full py-3 rounded-2xl bg-slate-900 text-white font-bold text-xs hover:bg-slate-800 disabled:opacity-50 transition">{verifying ? 'Verifying…' : 'Verify and sign in'}</button>
        </form>
      )}
      <button type="button" onClick={back} className="text-xs font-semibold text-slate-600 hover:underline">Return to sign in</button>
    </div>
  )
}
