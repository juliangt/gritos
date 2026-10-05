import { useMemo } from 'react'
import { DebugPanel } from './components/debug/DebugPanel'
import { OnboardingScreen } from './components/onboarding/OnboardingScreen'
import { ChatLayout } from './components/chat/ChatLayout'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useTheme } from './hooks/useTheme'
import { useAppStore } from './stores/useAppStore'

/**
 * View routing (plan §3): no local identity → OnboardingScreen (RF-01);
 * otherwise the chat shell. The M1 debug panel is dev-only (issue #32):
 * `import.meta.env.DEV` is `false` in production builds, so the whole
 * branch — and the DebugPanel module itself — is dead-code-eliminated from
 * the bundle; `?debug` keeps working under `vite dev` (plan §4).
 */
export default function App() {
  useTheme()
  useAppBootstrap()
  const identity = useAppStore((state) => state.identity)
  const showDebug = useMemo(() => new URLSearchParams(window.location.search).has('debug'), [])

  return (
    <div className="min-h-screen bg-bg text-text">
      {identity === null ? <OnboardingScreen /> : <ChatLayout />}
      {import.meta.env.DEV && showDebug && <DebugPanel />}
    </div>
  )
}
