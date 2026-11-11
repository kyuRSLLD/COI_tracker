import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/index.css'
import { V2Shell } from '../../src/v2/V2Shell'

createRoot(document.getElementById('root')!).render(<V2Shell />)
