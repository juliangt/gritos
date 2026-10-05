import { useState, type FormEvent } from 'react'
import {
  connectionStatusText,
  latencyDot,
  useAppStore,
} from '../../stores/useAppStore'
import { getSelfPeerId, sendTestChat } from '../../lib/p2p/roomManager'
import { NICKNAME_ERROR_TEXT } from '../../lib/nickname'
import { useRoomManager } from '../../hooks/useRoomManager'
import { useLatency } from '../../hooks/useLatency'

/**
 * Temporary M1 debug view (plan §4, M1 — removed or gated behind ?debug in
 * M6). Intentionally ugly-but-functional: it lists every joined room with
 * its spec §10.3 status and peers, offers a join form (name + optional
 * password), a leave button, a test-chat broadcast and a nickname field
 * that re-announces presence. M2 replaces it with the real UI.
 *
 * Dev-only (issue #32): App.tsx gates the whole module behind
 * `import.meta.env.DEV`, so it never ships to production. It calls the
 * manager's `sendTestChat` directly — the hook does not thread it, keeping
 * the debug-only path out of the shipped `useRoomManager` API.
 */
export function DebugPanel() {
  const identity = useAppStore((state) => state.identity)
  const rooms = useAppStore((state) => state.rooms)
  const { joinRoom, leaveRoom, changeNickname } = useRoomManager()

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  // null = the field follows the store identity (which arrives asynchronously).
  const [nickDraft, setNickDraft] = useState<string | null>(null)
  const nickValue = nickDraft ?? identity?.nickname ?? ''

  const onJoin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (name.trim() === '') return
    void joinRoom(name, password === '' ? undefined : password).then((joinError) =>
      setError(joinError),
    )
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6 text-sm">
      <header>
        <h1 className="text-2xl font-bold">gritos</h1>
        <p className="text-muted">
          Panel de depuración M1 — P2P sin UI. Se sustituye en M2.
        </p>
      </header>

      <section aria-label="identidad" className="flex flex-col gap-2">
        <h2 className="font-semibold">Identidad</h2>
        {identity === null ? (
          <p className="text-muted">Generando identidad efímera…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <label>
              Apodo:{' '}
              <input
                aria-label="apodo"
                value={nickValue}
                onChange={(event) => setNickDraft(event.target.value)}
                onBlur={() => {
                  if (nickValue.trim() !== '' && nickValue !== identity.nickname) {
                    // Issue #28 — the manager validates with the RF-01 rules;
                    // invalid input is surfaced instead of crashing the panel.
                    try {
                      changeNickname(nickValue)
                    } catch {
                      setError(NICKNAME_ERROR_TEXT)
                    }
                  }
                  setNickDraft(null)
                }}
                className="rounded border border-border bg-surface px-2 py-1"
              />
            </label>
            <span className="font-mono text-xs">{identity.fingerprint}</span>
            <span className="font-mono text-xs text-muted">
              self: {getSelfPeerId().slice(0, 8)}
            </span>
          </div>
        )}
      </section>

      <form
        aria-label="unirse a sala"
        onSubmit={onJoin}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          aria-label="nombre de sala"
          placeholder="nombre de sala"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1"
        />
        <input
          aria-label="contraseña de sala"
          placeholder="contraseña (opcional)"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1"
        />
        <button
          type="submit"
          className="rounded bg-accent px-3 py-1 text-accent-text"
        >
          Unirse
        </button>
        {error !== null && (
          <span role="alert" className="text-accent">
            {error}
          </span>
        )}
      </form>

      <section aria-label="salas activas" className="flex flex-col gap-4">
        <h2 className="font-semibold">
          Salas activas ({Object.keys(rooms).length})
        </h2>
        {Object.keys(rooms).length === 0 && (
          <p className="text-muted">
            Ninguna sala. Únete a una para buscar pares en la red.
          </p>
        )}
        {Object.values(rooms).map((room) => (
          <DebugRoom
            key={room.id}
            roomId={room.id}
            onLeave={() => leaveRoom(room.id)}
            onSendTestChat={(text) => sendTestChat(room.id, text)}
          />
        ))}
      </section>
    </main>
  )
}

function DebugRoom(props: {
  roomId: string
  onLeave: () => void
  onSendTestChat: (text: string) => void
}) {
  const room = useAppStore((state) => state.rooms[props.roomId])
  const [draft, setDraft] = useState('prueba')
  useLatency(room !== undefined ? room.id : null)

  if (room === undefined) return null

  return (
    <article className="flex flex-col gap-2 rounded border border-border p-3">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">
          #{room.name}
          {room.hasPassword ? ' 🔒' : ''}
        </h3>
        <span className="text-muted">
          {connectionStatusText(room.status, room.peers.length)}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            type="button"
            aria-label={`enviar chat de prueba en ${room.name}`}
            onClick={() => props.onSendTestChat(draft)}
            className="rounded border border-border px-2 py-1"
          >
            Enviar chat de prueba
          </button>
          <button
            type="button"
            aria-label={`abandonar ${room.name}`}
            onClick={props.onLeave}
            className="rounded border border-border px-2 py-1"
          >
            Abandonar
          </button>
        </span>
      </header>

      <div>
        <input
          aria-label={`texto de prueba ${room.name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full rounded border border-border bg-surface px-2 py-1"
        />
      </div>

      <section aria-label={`pares de ${room.name}`} className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Pares ({room.peers.length})
        </h4>
        {room.peers.length === 0 && (
          <p className="text-xs text-muted">Sin pares todavía.</p>
        )}
        <ul>
          {room.peers.map((peer) => (
            <li key={peer.id} className="font-mono text-xs">
              {latencyDot(peer.latencyMs, peer.degraded)} {peer.nickname}
              <span className="text-muted"> · {peer.fingerprint ?? 'sin fp'}</span>
              <span className="text-muted">
                {' '}
                · {peer.latencyMs === null ? '—' : `${peer.latencyMs} ms`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={`mensajes de ${room.name}`} className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Mensajes ({room.messages.length})
        </h4>
        <ul className="max-h-48 overflow-auto">
          {room.messages.map((message) => (
            <li key={message.id} className="font-mono text-xs">
              [{new Date(message.ts).toLocaleTimeString()}]{' '}
              {message.authorId === 'self' ? 'yo' : message.authorNick}:{' '}
              {message.text}
              {message.status === 'delivered' ? ' ✓✓' : ' ✓'}
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}
