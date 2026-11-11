import React from 'react'
import { createRoot } from 'react-dom/client'
import { V2Auth } from '../src/v2-auth/V2Auth'
import '../src/index.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><V2Auth /></React.StrictMode>)
