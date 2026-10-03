import { useState, type FormEvent } from 'react'
import { INVALID_ROOM_NAME_TEXT } from '../../lib/rooms'
import { normalizeRoomName } from '../../lib/p2p/roomManager'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * '[+ Unirse]' popover (RF-02): free-name join with live normalization
 * preview and inline validation (no error modal); the optional encrypted-
 * room password is a disabled placeholder until M4 (RF-05). Room-cap
 * rejections surface the exact manager message
 * "Límite de salas activas alcanzado (N)".
 */
export function JoinRoomPopover(props: {
  onJoined: (roomId: string) => void
  onDismiss?: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { joinRoomFocused } = useRoomManager()

  // Live normalization preview: '#mi-sala' while typing, '—' when invalid.
  const normalized = normalizeRoomName(name)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (normalized === null) {
      setError(INVALID_ROOM_NAME_TEXT)
      return
    }
    setBusy(true)
    const { roomId, error: joinError } = await joinRoomFocused(normalized)
    setBusy(false)
    if (joinError !== null) {
      setError(joinError)
      return
    }
    if (roomId !== null) props.onJoined(roomId)
  }

  return (
    <form
      aria-label="Unirse por nombre"
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-2"
    >
      <input
        aria-label="Nombre de la sala"
        autoFocus
        placeholder="nombre-de-sala"
        spellCheck={false}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
      />
      {name.trim() !== '' && (
        <p className="text-xs text-muted">
          Se unirá a <span className="font-mono text-text">#{normalized ?? '—'}</span>
        </p>
      )}
      <input
        aria-label="Contraseña de la sala"
        type="password"
        disabled
        placeholder="Contraseña (opcional)"
        title="Salas con contraseña: disponibles en M4"
        className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm text-muted opacity-60"
      />
      {error !== null && (
        <p role="alert" className="text-xs text-accent">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text disabled:opacity-50"
        >
          Unirse
        </button>
        {props.onDismiss !== undefined && (
          <button
            type="button"
            onClick={props.onDismiss}
            className="rounded border border-border px-3 py-1.5 text-xs"
          >
            Cancelar
          </button>
        )}
      </div>
    </form>
  )
}
