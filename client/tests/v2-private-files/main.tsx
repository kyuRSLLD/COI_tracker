import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PrivateFiles } from '../../src/v2/PrivateFiles'

// Synthetic tokens only. All API calls are intercepted by the browser test.
function TestHost() {
  const [token, setToken] = useState('synthetic-a')
  const [show, setShow] = useState(true)
  return <><button type="button" onClick={() => setToken('synthetic-b')}>Switch synthetic session</button><button type="button" onClick={() => setShow(!show)}>Toggle test component</button>{show && <PrivateFiles token={token} maxFileBytes={1024} />}</>
}
createRoot(document.getElementById('root')!).render(<TestHost />)
