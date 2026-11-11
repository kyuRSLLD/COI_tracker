import React from 'react'
import { createRoot } from 'react-dom/client'
import { SubcontractorWorkflow } from '../../src/v2/SubcontractorWorkflow'

// The browser test intercepts every API call; never use this fixture as credentials.
createRoot(document.getElementById('root')!).render(<SubcontractorWorkflow token="synthetic-access-token" />)
