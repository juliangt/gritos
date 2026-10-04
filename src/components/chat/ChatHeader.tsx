import { useState } from 'react'
import type { Room } from '../../stores/useAppStore'
import { roomStatusText } from '../../lib/rooms'
import { buildRoomLink } from '../../lib/shareLinks'
import { StatusDot } from '../common/StatusDot'
import { SettingsModal } from '../settings/SettingsModal'

/** Issue #41 — how long the 'Enlace copiado' feedback stays visible. */
const COPIED_FEEDBACK_MS = 2_000

/**
 * Main-area header (spec §10.1/§10.3): '#name' with the 🔒 marker, the
 * exact connection status text (RF-05: a password room that exhausts the
 * heuristic without peers shows the single not-found message), peer count,
 * the sidebar toggle, the share affordance (issue #41: navigator.share with
 * a clipboard fallback; the link carries only the room name) and the
 * settings entry (RF-07 modal).
 */
export function ChatHeader(props: { room: Room | null; onToggleSidebar: () => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  // Issue #41 — share the current room: the Web Share sheet when available,
  // the clipboard otherwise, with brief feedback (same transient pattern as
  // the 'Fingerprint copiado' line). The URL never carries the password.
  const shareRoom = () => {
    const room = props.room
    if (room === null) return
    const url = buildRoomLink(room.name)
    if (typeof navigator.share === 'function') {
      void navigator.share({ title: `Sala #${room.name} en gritos`, url }).catch(() => {
        // Share sheet dismissed — nothing to report.
      })
      return
    }
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
      })
      .catch(() => {
        // Clipboard denied — the room name remains visible in the header.
      })
  }

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
            {roomStatusText(props.room)}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted">
            {props.room.peers.length} {props.room.peers.length === 1 ? 'par' : 'pares'}
          </span>
          <button
            type="button"
            onClick={shareRoom}
            aria-label="Compartir sala"
            title="Compartir sala"
            className="rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
          >
            ⤴
          </button>
        </>
      )}

      {copied && (
        <span aria-live="polite" className="shrink-0 text-xs text-muted">
          Enlace copiado
        </span>
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

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
