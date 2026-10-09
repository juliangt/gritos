import { typingStatusText } from '../../lib/feed'
import { useT } from '../../i18n/index'
import type { Peer } from '../../stores/useAppStore'

/**
 * Typing indicator line (RF-03, reused by rooms and DMs per RF-04):
 * 'luna-cauta is typing…' for a single peer, 'N people are typing…' for
 * several. Entries expire after 4 s (roomManager sweeper); unknown peerIds
 * fall back to a short id. The line resolves locale-live through the
 * builder (issue #119); the bar re-renders on a locale switch via useT.
 */
export function TypingBar(props: { typing: Record<string, number>; peers: readonly Peer[] }) {
  useT()
  const nicknames = Object.keys(props.typing).map(
    (peerId) =>
      props.peers.find((peer) => peer.id === peerId)?.nickname ?? `peer-${peerId.slice(0, 6)}`,
  )
  const text = typingStatusText(nicknames)
  return (
    <div className="h-6 px-4 pt-1 text-xs text-muted" aria-live="polite">
      {text}
    </div>
  )
}
