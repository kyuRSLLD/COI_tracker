import React from 'react'
import { createRoot } from 'react-dom/client'
import { installConnectionFetch } from './network'
import { V2Shell } from '../src/v2/V2Shell'
import '../src/index.css'

installConnectionFetch()
const root = document.getElementById('root')
if (!root) throw new Error('Missing application root')
createRoot(root).render(<React.StrictMode><V2Shell connectionOnly /></React.StrictMode>)
