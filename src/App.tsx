import { DebugPanel } from './components/debug/DebugPanel'
import { useTheme } from './hooks/useTheme'

/**
 * App shell — M1 stage: the temporary debug panel over the P2P core
 * (plan §4). View routing (onboarding | app) and the real layout arrive in
 * M2; the debug view is removed (or gated) in M6.
 */
export default function App() {
  useTheme()

  return (
    <div className="min-h-screen bg-bg text-text">
      <DebugPanel />
    </div>
  )
}
