import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/common/ErrorBoundary.tsx'
import { registerServiceWorker } from './lib/pwa/registerSw.ts'

// Issue #105 (spec §12.5) — the signal-channel manager's module-load wiring
// (the Settings.globalDm subscription that joins/leaves the swarm) must be
// installed at boot, exactly like the room manager's seam→store wiring
// living on its module load. With the default (off) this is inert; the
// toggle works without any component importing the module.
import './lib/p2p/signalChannel.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

// Offline app shell (issue #104, phase 2): production + secure contexts
// only, failures swallowed — see registerSw.ts. Fire-and-forget after the
// first paint: the app must boot with or without the worker. The update
// toast (phase 4) subscribes separately via onUpdateReady() from the
// mounted App, so this call needs no callback wiring here.
registerServiceWorker()
