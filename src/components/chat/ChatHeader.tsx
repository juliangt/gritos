import { useEffect, useState } from 'react'
import { connectionStatusText, type Room } from '../../stores/useAppStore'
import { StatusDot } from '../common/StatusDot'

/**
 * Main-area header (spec §10.1/§10.3): '#name' with the 🔒 marker, the
 * exact connection status text, peer count, the sidebar toggle and the
 * settings entry — an M2 stub modal; the full modal (RF-07) lands in M5.
 */
export function ChatHeader(props: { room: Room | null; onToggleSidebar: () => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button
        type="button"
        onClick={props.onToggleSidebar}
        aria-label="Mostrar u ocultar la barra lateral"
        title="Mostrar u ocultar la barra lateral (Ctrl/Cmd+B)"
        className="rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
      >
        ☰
      </button>

      {props.room === null ? (
        <h1 className="text-sm font-semibold">gritos</h1>
      ) : (
        <>
          <h1 className="truncate text-sm font-semibold">
            #{props.room.name}
            {props.room.hasPassword && (
              <span role="img" aria-label="sala cifrada" title="Sala con contraseña">
                {' '}
                🔒
              </span>
            )}
          </h1>
          <StatusDot status={props.room.status} />
          <span className="min-w-0 truncate text-xs text-muted">
            {connectionStatusText(props.room.status, props.room.peers.length)}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted">
            {props.room.peers.length} {props.room.peers.length === 1 ? 'par' : 'pares'}
          </span>
        </>
      )}

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Ajustes"
        title="Ajustes"
        className="rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
      >
        ⚙
      </button>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ajustes"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-border bg-surface p-4"
          >
            <h2 className="text-base font-semibold">Ajustes</h2>
            <p className="mt-2 text-sm text-muted">
              El panel de ajustes (red, privacidad y apariencia) llega en la entrega M5.
            </p>
            <button
              type="button"
              onClick={() => setSettingsOpen(false)}
              autoFocus
              className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
