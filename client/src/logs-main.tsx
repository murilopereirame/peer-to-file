import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LogsApp } from './pages/LogsApp'
import './style.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

createRoot(container).render(
  <StrictMode>
    <LogsApp />
  </StrictMode>
)
