import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GcGrantedFiles } from '../../src/v2/GcGrantedFiles'

function TestHost() {
  const [token, setToken] = useState('synthetic-a')
  const [show, setShow] = useState(true)
  return <><button onClick={() => setToken('synthetic-b')}>Switch synthetic session</button><button onClick={() => setToken('synthetic-a')}>Switch to first session</button><button onClick={() => setToken('')}>Sign out</button><button onClick={() => setShow(!show)}>Toggle component</button>{show && <GcGrantedFiles authorizationToken={token} maxFileBytes={1024} />}</>
}
createRoot(document.getElementById('root')!).render(<TestHost />)
