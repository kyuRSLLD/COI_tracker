import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { V2Auth } from '../../src/v2-auth/V2Auth'
import { SubcontractorWorkflow } from '../../src/v2/SubcontractorWorkflow'
import { GcConnections } from '../../src/v2/GcConnections'
import '../../src/index.css'

// Test-only host: identity comes from the real /me endpoint, not the signup form.
function Harness() {
  const [session, setSession] = useState<{ token: string; role: 'sub' | 'gc' }>()
  const [error, setError] = useState(false)
  if (session?.role === 'sub') return <SubcontractorWorkflow token={session.token} />
  if (session?.role === 'gc') return <GcConnections authorizationToken={session.token} />
  return <><V2Auth onAuthenticated={async ({ token }) => {
    try {
      const response = await fetch('/api/v2/auth/me', { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' })
      const me = await response.json()
      if (!response.ok || !['gc', 'sub'].includes(me.role)) throw new Error('invalid identity')
      setSession({ token, role: me.role })
    } catch { setError(true) }
  }} />{error && <p role="alert">Test host could not establish identity.</p>}</>
}
createRoot(document.getElementById('root')!).render(<Harness />)
