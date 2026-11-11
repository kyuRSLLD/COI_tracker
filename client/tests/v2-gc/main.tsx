import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GcConnections } from '../../src/v2/GcConnections'

function Harness() {
  const [token, setToken] = useState('synthetic-gc-one')
  return <><button type="button" onClick={() => setToken('synthetic-gc-two')}>Switch synthetic account</button><GcConnections authorizationToken={token} /></>
}
createRoot(document.getElementById('root')!).render(<Harness />)
