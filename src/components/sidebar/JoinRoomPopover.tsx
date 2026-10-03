import { useState, type FormEvent } from 'react'
import {
  EMPTY_ROOM_PASSWORD_TEXT,
  ENCRYPTED_ROOM_HINT,
  INVALID_ROOM_NAME_TEXT,
} from '../../lib/rooms'
import { normalizeRoomName } from '../../lib/p2p/roomManager'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * '[+ Unirse]' popover (RF-02/RF-05): free-name join with live normalization
 * preview and inline validation (no error modal). The optional encrypted-
 * room password hides behind the 'sala cifrada' toggle with the one-line
 * explanation; when the toggle is on a non-empty password is required —
 * the room key and the §9.4 roomId both derive from it. Room-cap rejections
 * surface the exact manager message "Límite de salas activas alcanzado (N)".
 * A wrong password is NOT a join error: the room simply never finds peers,
 * and the not-found message appears in the room view once the error
 * heuristic exhausts (lib/rooms roomStatusText).
 */
export function JoinRoomPopover(props: {
  onJoined: (roomId: string) => void
  onDismiss?: () => void
}) {
  const [name, setName] = useState('')
  const [encrypted, setEncrypted] = useState(false)
  const [password, setPassword] = useState('')
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
    if (encrypted && password === '') {
      setError(EMPTY_ROOM_PASSWORD_TEXT)
      return
    }
    setBusy(true)
    const { roomId, error: joinError } = await joinRoomFocused(
      normalized,
      encrypted ? password : undefined,
    )
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
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          aria-label="sala cifrada"
          checked={encrypted}
          onChange={(event) => {
            setEncrypted(event.target.checked)
            setError(null)
          }}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span>🔒 sala cifrada</span>
      </label>
      {encrypted && (
        <>
          <input
            aria-label="Contraseña de la sala"
            type="password"
            placeholder="Contraseña de la sala"
            spellCheck={false}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setError(null)
            }}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
          <p className="text-xs text-muted">{ENCRYPTED_ROOM_HINT}</p>
        </>
      )}
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
