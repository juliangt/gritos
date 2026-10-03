import { useEffect, useRef, useState } from 'react'
import { latencyDot, type Peer, type Room } from '../../stores/useAppStore'
import { disambiguatedNickname } from '../../lib/nickname'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * *Pares* section (RF-06): peers of the active view with nickname and
 * latency dot (🟢 <150 ms, 🟡 150–400, 🔴 >400, ⚪ degraded/no data).
 * Duplicate nicknames get a short peerId suffix ('nick·a3f1'). Clicking a
 * peer opens the menu (§10.1): 'Mensaje directo' (M3, RF-04) opens the
 * E2EE DM view; 'Copiar fingerprint' uses the clipboard. The menu closes
 * on Esc, outside clicks and after any action.
 */
export function PeerList({ room }: { room: Room | null }) {
  const [menuPeerId, setMenuPeerId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const sectionRef = useRef<HTMLElement>(null)
  const { openDm } = useRoomManager()

  // Menu closes on Esc and on any click outside the section (§10.1).
  useEffect(() => {
    if (menuPeerId === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuPeerId(null)
    }
    const onPointerDown = (event: MouseEvent) => {
      if (sectionRef.current !== null && !sectionRef.current.contains(event.target as Node)) {
        setMenuPeerId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [menuPeerId])

  if (room === null) return null

  const copyFingerprint = (peer: Peer) => {
    setMenuPeerId(null)
    if (peer.fingerprint === null) return
    void navigator.clipboard
      ?.writeText(peer.fingerprint)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_500)
      })
      .catch(() => {
        // Clipboard denied — the fingerprint remains visible in the DM view.
      })
  }

  const startDm = (peer: Peer) => {
    setMenuPeerId(null)
    openDm(peer.id)
  }

  return (
    <section ref={sectionRef} aria-label="Pares" className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Pares ({room.peers.length})
      </h2>
      {room.peers.length === 0 && (
        <p className="text-xs text-muted">
          Sin pares aún. Comparte el nombre de la sala para que otros se unan.
        </p>
      )}
      <ul className="flex flex-col">
        {room.peers.map((peer) => {
          const displayName = disambiguatedNickname(peer.nickname, peer.id, room.peers)
          return (
            <li key={peer.id} className="relative flex flex-col">
              <button
                type="button"
                onClick={() => setMenuPeerId((current) => (current === peer.id ? null : peer.id))}
                aria-expanded={menuPeerId === peer.id}
                className="flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-surface"
                title={peer.fingerprint ?? undefined}
              >
                <span role="img" aria-label="latencia">
                  {latencyDot(peer.latencyMs, peer.degraded)}
                </span>
                <span className="truncate">{displayName}</span>
              </button>
              {menuPeerId === peer.id && (
                <div
                  role="menu"
                  aria-label={`Acciones para ${displayName}`}
                  className="absolute left-2 top-7 z-10 flex flex-col rounded-md border border-border bg-surface p-1 text-xs shadow-lg"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => startDm(peer)}
                    className="rounded px-2 py-1 text-left hover:bg-bg"
                  >
                    Mensaje directo
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={peer.fingerprint === null}
                    onClick={() => copyFingerprint(peer)}
                    className="rounded px-2 py-1 text-left hover:bg-bg disabled:text-muted"
                  >
                    Copiar fingerprint
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {copied && <p className="text-xs text-muted">Fingerprint copiado.</p>}
    </section>
  )
}
