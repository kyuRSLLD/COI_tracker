import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { V2Auth } from '../../src/v2-auth/V2Auth'
import '../../src/index.css'

function Harness() {
  const [received, setReceived] = useState(false)
  return <><V2Auth onAuthenticated={session => setReceived(session.token === 'header.payload.signature' && session.token_type === 'Bearer' && session.expires_in === 900)} />{received && <p data-testid="callback-result">Callback received expected synthetic session</p>}</>
}
createRoot(document.getElementById('root')!).render(<Harness />)
