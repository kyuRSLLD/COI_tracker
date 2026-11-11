import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { V2Auth } from '../../src/v2-auth/V2Auth'
import { SubcontractorWorkflow } from '../../src/v2/SubcontractorWorkflow'
import { GcConnections } from '../../src/v2/GcConnections'
import { PrivateFiles } from '../../src/v2/PrivateFiles'
import '../../src/index.css'

// Test-only host: identity comes from the real /me endpoint, not the signup form.
function Harness() {
  const [session, setSession] = useState<{ token: string; role: 'sub' | 'gc' }>()
  const [error, setError] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  if (session?.role === 'sub') return <><button type="button" onClick={() => setShowFiles(v => !v)}>{showFiles ? 'Return to connections' : 'Open private files'}</button><div hidden={showFiles}><SubcontractorWorkflow token={session.token} /></div>{showFiles && <PrivateFiles token={session.token} maxFileBytes={1024 * 1024} />}</>
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
