import { typingStatusText } from '../../lib/feed'
import type { Room } from '../../stores/useAppStore'

/**
 * Typing indicator line (RF-03): 'luna-cauta está escribiendo…' for a
 * single peer, 'N personas están escribiendo…' for several. Entries expire
 * after 4 s (roomManager sweeper); unknown peerIds fall back to a short id.
 */
export function TypingBar({ room }: { room: Room }) {
  const nicknames = Object.keys(room.typing).map(
    (peerId) =>
      room.peers.find((peer) => peer.id === peerId)?.nickname ?? `par-${peerId.slice(0, 6)}`,
  )
  const text = typingStatusText(nicknames)
  return (
    <div className="h-6 px-4 pt-1 text-xs text-muted" aria-live="polite">
      {text}
    </div>
  )
}
