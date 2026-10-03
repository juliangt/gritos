import { useTheme } from './hooks/useTheme'

/**
 * App shell — M0 placeholder screen. View routing (onboarding | app) and
 * the real layout arrive in M2 (plan §4).
 */
export default function App() {
  useTheme()

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-text">
      <main className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
        <h1 className="text-5xl font-bold tracking-tight">gritos</h1>
        <p className="text-muted">
          Chat P2P sin servidor: sin cuentas, tus mensajes viajan directos
          entre navegadores y desaparecen al recargar.
        </p>
        <p className="text-sm text-muted">El onboarding llega con el hito M2.</p>
      </main>
    </div>
  )
}
