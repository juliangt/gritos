import { useEffect, useRef, useState } from 'react'
import { latencyDot, type Peer, type Room, useAppStore } from '../../stores/useAppStore'
import { canonicalFingerprint } from '../../lib/crypto/dm'
import { disambiguatedNickname } from '../../lib/nickname'
import { useRoomManager } from '../../hooks/useRoomManager'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { ConfirmDialog } from '../common/ConfirmDialog'
import {
  MUTE_DM_DIALOG_BODY,
  MUTE_DM_DIALOG_CONFIRM_LABEL,
  MUTE_DM_DIALOG_TITLE,
  MUTE_PEER_ACTION,
  UNMUTE_PEER_ACTION,
} from '../settings/messages'

/**
 * *Pares* section (RF-06): peers of the active view with nickname and
 * latency dot (🟢 <150 ms, 🟡 150–400, 🔴 >400, ⚪ degraded/no data).
 * Duplicate nicknames get a short peerId suffix ('nick·a3f1'). Clicking a
 * peer opens the menu (§10.1): 'Mensaje directo' (M3, RF-04) opens the
 * E2EE DM view; 'Copiar fingerprint' uses the clipboard; issue #95 adds
 * 'Silenciar' (local mute keyed by the identity fingerprint, with a
 * confirm when the peer has an open DM channel — muting also ignores its
 * future DMs) or 'Dejar de silenciar' while muted. The menu closes
 * on Esc, outside clicks and after any action. Issue #22 (TOFU): peers
 * whose DM channel is flagged `keyChanged` show the pinned first-seen
 * fingerprint (tooltip and copy) plus a visible rotation warning.
 */
export function PeerList({ room }: { room: Room | null }) {
  const [menuPeerId, setMenuPeerId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Issue #95 — peer waiting for the mute confirmation (open DM channel).
  const [confirmMutePeer, setConfirmMutePeer] = useState<Peer | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const { openDm, muteFromUi, unmuteFromUi } = useRoomManager()
  const dms = useAppStore((state) => state.dms)
  const mutedFingerprints = useSettingsStore((state) => state.settings.mutedFingerprints)

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

  // Issue #22 — for a flagged peer the DM channel holds the pinned
  // first-seen fingerprint; it is what gets displayed and copied.
  const displayedFingerprint = (peer: Peer): string | null => {
    const channel = dms[peer.id]
    if (channel !== undefined && channel.keyChanged && channel.peerFingerprint !== null) {
      return channel.peerFingerprint
    }
    return peer.fingerprint
  }

  const copyFingerprint = (peer: Peer) => {
    setMenuPeerId(null)
    const fingerprint = displayedFingerprint(peer)
    if (fingerprint === null) return
    void navigator.clipboard
      ?.writeText(fingerprint)
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

  // Issue #95 — whether the peer's displayed fingerprint is on the mute
  // list (the list persists canonical form; the displayed value may carry
  // the spaced 8×4 groups).
  const isPeerMuted = (peer: Peer): boolean => {
    const fingerprint = displayedFingerprint(peer)
    return fingerprint !== null && mutedFingerprints.includes(canonicalFingerprint(fingerprint))
  }

  const applyMute = (peer: Peer) => {
    setMenuPeerId(null)
    setConfirmMutePeer(null)
    const fingerprint = displayedFingerprint(peer)
    if (fingerprint === null) return
    muteFromUi(fingerprint, peer.nickname)
  }

  // Muting a peer with an open DM channel also ignores its future DMs
  // (phase 2 enforcement): that loss is disclosed behind a confirm.
  const requestMute = (peer: Peer) => {
    const fingerprint = displayedFingerprint(peer)
    if (fingerprint === null) return
    if (dms[peer.id] !== undefined) {
      setMenuPeerId(null)
      setConfirmMutePeer(peer)
      return
    }
    applyMute(peer)
  }

  const unmutePeer = (peer: Peer) => {
    setMenuPeerId(null)
    const fingerprint = displayedFingerprint(peer)
    if (fingerprint === null) return
    unmuteFromUi(fingerprint)
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
          const fingerprint = displayedFingerprint(peer)
          const keyChanged = dms[peer.id]?.keyChanged === true
          return (
            <li key={peer.id} className="relative flex flex-col">
              <button
                type="button"
                onClick={() => setMenuPeerId((current) => (current === peer.id ? null : peer.id))}
                aria-expanded={menuPeerId === peer.id}
                className="flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-surface"
                title={fingerprint ?? undefined}
              >
                <span role="img" aria-label="latencia">
                  {latencyDot(peer.latencyMs, peer.degraded)}
                </span>
                <span className="truncate">{displayName}</span>
                {keyChanged && (
                  <span role="img" aria-label="fingerprint cambiado" className="text-accent">
                    ⚠
                  </span>
                )}
              </button>
              {menuPeerId === peer.id && (
                <div
                  role="menu"
                  aria-label={`Acciones para ${displayName}`}
                  className="absolute left-2 top-7 z-10 flex flex-col rounded-md border border-border bg-surface p-1 text-xs shadow-lg"
                >
                  {keyChanged && (
                    <p role="alert" className="px-2 py-1 text-accent">
                      ⚠ El fingerprint cambió desde tu última verificación
                    </p>
                  )}
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
                    disabled={fingerprint === null}
                    onClick={() => copyFingerprint(peer)}
                    className="rounded px-2 py-1 text-left hover:bg-bg disabled:text-muted"
                  >
                    Copiar fingerprint
                  </button>
                  {isPeerMuted(peer) ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={fingerprint === null}
                      onClick={() => unmutePeer(peer)}
                      className="rounded px-2 py-1 text-left hover:bg-bg disabled:text-muted"
                    >
                      {UNMUTE_PEER_ACTION}
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={fingerprint === null}
                      onClick={() => requestMute(peer)}
                      className="rounded px-2 py-1 text-left hover:bg-bg disabled:text-muted"
                    >
                      {MUTE_PEER_ACTION}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {copied && <p className="text-xs text-muted">Fingerprint copiado.</p>}

      {/* Issue #95 — muting a peer with an open DM channel discloses that its
          future DMs will be ignored too (phase 2 receive-path enforcement). */}
      <ConfirmDialog
        open={confirmMutePeer !== null}
        title={MUTE_DM_DIALOG_TITLE}
        body={MUTE_DM_DIALOG_BODY}
        confirmLabel={MUTE_DM_DIALOG_CONFIRM_LABEL}
        danger
        onConfirm={() => {
          if (confirmMutePeer !== null) applyMute(confirmMutePeer)
        }}
        onCancel={() => setConfirmMutePeer(null)}
      />
    </section>
  )
}
