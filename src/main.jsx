import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/open-sans/400.css'
import '@fontsource/open-sans/500.css'
import '@fontsource/open-sans/600.css'
import '@fontsource/open-sans/700.css'
import './index.css'
import App from './App.jsx'
import { installDataGuard } from './utils/dataGuard'

installDataGuard()

// A tab opened before a deploy still asks for the old build's code files (the
// inner pages), which the deploy has replaced. Reload once to pick up the new
// build; the flag stops a loop if the file is truly missing.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('epm-reloaded')) return
    sessionStorage.setItem('epm-reloaded', '1')
  } catch { return }
  e.preventDefault()
  location.reload()
})
window.addEventListener('load', () => {
  setTimeout(() => { try { sessionStorage.removeItem('epm-reloaded') } catch { /* private mode */ } }, 10000)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
