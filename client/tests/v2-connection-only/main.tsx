import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { V2Shell } from '../../src/v2/V2Shell'
import { GcConnections } from '../../src/v2/GcConnections'
import { SubcontractorWorkflow } from '../../src/v2/SubcontractorWorkflow'
import '../../src/index.css'

function TestHost() {
  const [connectionOnly, setConnectionOnly] = useState(true)
  const component = new URL(location.href).searchParams.get('component')
  return <><button type="button" onClick={() => setConnectionOnly(value => !value)}>Toggle test mode</button>
    {component === 'gc' ? <GcConnections authorizationToken="synthetic-gc" connectionOnly={connectionOnly} /> : component === 'sub' ? <SubcontractorWorkflow token="synthetic-sub" connectionOnly={connectionOnly} /> : <V2Shell connectionOnly={connectionOnly} />}
  </>
}
createRoot(document.getElementById('root')!).render(<TestHost />)
