import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ThemeProvider } from './context/ThemeContext'
import { loadWebTorrent } from './lib/loadWebTorrent'
import './style.css'

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

await loadWebTorrent()

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
)
