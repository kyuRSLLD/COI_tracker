import React from 'react'
import { createRoot } from 'react-dom/client'
import { V2Shell } from '../../src/v2/V2Shell'
import '../../src/index.css'

createRoot(document.getElementById('root')!).render(<V2Shell connectionOnly />)
