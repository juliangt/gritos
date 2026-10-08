import { memo, useState } from 'react'
import { MarkdownRenderer } from '../../lib/markdown/render'
import { authorColor } from '../../lib/color'
import { disambiguatedNickname } from '../../lib/nickname'
import { formatTimeHHMM } from '../../lib/feed'
import { getSelfPeerId, muteFromUi, toggleReaction } from '../../lib/p2p/roomManager'
import { REACT_EMOJIS, type ReactEmoji } from '../../lib/p2p/protocol'
import {
  REACTION_ADD_LABEL,
  REACTION_BAR_LABEL,
  REACTIONS_ROW_LABEL,
  muteAuthorAction,
  reactionChipTooltip,
  reactQuickPickLabel,
} from '../settings/messages'
import type { Message, Peer } from '../../stores/useAppStore'

/** One aggregated chip: a whitelisted emoji and the peerIds reacting with it. */
interface ReactionChip {
  emo: ReactEmoji
  peerIds: readonly string[]
}

/**
 * Issue #98 — chips ordered by count (descending), ties broken by the fixed
 * whitelist order, so every peer derives the exact same row from the same
 * reactions map.
 */
function aggregateReactions(reactions: NonNullable<Message['reactions']>): ReactionChip[] {
  return (REACT_EMOJIS as readonly ReactEmoji[])
    .map((emo) => ({ emo, peerIds: reactions[emo] ?? [] }))
    .filter((chip) => chip.peerIds.length > 0)
    .sort((a, b) => b.peerIds.length - a.peerIds.length)
}

/**
 * Issue #98 — toggle routing derived from the message's own `roomId`, so the
 * memo contract stays untouched (no new props): room rows broadcast on their
 * swarm; `dm:<peerId>` rows (the identification every DM append stamps) send
 * the directed payload (`to`), mirroring how DM sends work — the manager
 * resolves the first shared room to ride. Trackerless manual channels
 * (`dm:manual:…`, issue #97) have no room swarm to carry the `react` action,
 * so they never offer the affordance at all.
 */
function reactToMessage(roomId: string, messageId: string, emo: string): void {
  if (roomId.startsWith('dm:')) {
    const peerId = roomId.slice('dm:'.length)
    if (peerId.startsWith('manual:')) return
    toggleReaction(roomId, messageId, emo, peerId)
    return
  }
  toggleReaction(roomId, messageId, emo)
}

/**
 * One flat feed bubble (spec §10.4): no per-message boxes; author in a
 * stable hash color, HH:MM from the author's ts, Markdown-subset body with
 * mention highlighting. Own messages align right and carry the dimmed
 * ✓/✓✓ receipt marker. System lines ('— nick se ha unido —', FIFO
 * separator) render centered and muted.
 *
 * Issue #95 — another peer's message row carries a discreet inline mute
 * affordance (accessible name 'Silenciar a @nick') whenever the author is a
 * peer with a known fingerprint: it keys the local mute list on the
 * identity fingerprint, never the spoofable nickname. It imports the
 * manager helper directly (the same seam ChatLayout uses for joinRoom) so
 * no callback prop destabilizes the memo contract below.
 *
 * Issue #98 — every user row also carries the reaction affordances:
 * - A small always-visible opener button (accessible name 'Reaccionar')
 *   that opens the 7-whitelist quick-pick bar on click AND on focus, so
 *   touch and keyboard users reach it without hover. Mobile affordance:
 *   pointer hover does not exist on touch screens and long-press is not
 *   implementable in a testable way here — the tap-first opener IS the
 *   touch path (tap → bar → pick), exactly like the desktop click.
 * - The bar itself shows while the pointer hovers the row (desktop) or the
 *   opener was activated (pinned); Escape, an outside blur or a pick
 *   dismiss it. Visibility is React state, not CSS classes, so closed
 *   buttons leave the accessibility tree entirely (no hidden tab stops).
 * - The aggregated chips row under the bubble: one toggle button per emoji
 *   ('👍 3', aria-pressed = own reaction), tooltip listing the reactor
 *   nicknames. Reactor peerIds resolve through the peers prop the row
 *   already receives (DM feeds pass the one-entry peer list) and the own
 *   peerId comes from the manager's `getSelfPeerId` seam; both clicks route
 *   through the manager's `toggleReaction` imported directly — again no
 *   callback props.
 *
 * Wrapped in React.memo (M6, RNF-03): every prop is stable while the
 * message is unchanged — `message` is immutable, `peers`/`mentionCandidates`
 * keep their identity across message appends and `ownNickname` rarely
 * changes — so appending to the feed re-renders only the new row, not the
 * whole history. The own-nickname slice is subscribed ONCE in MessageFeed
 * and passed down (no per-row store subscriptions in list rows).
 */
export const MessageItem = memo(function MessageItem(props: {
  message: Message
  peers: readonly Peer[]
  mentionCandidates: readonly string[]
  ownNickname: string
}) {
  // Issue #98 — bar visibility lives in two orthogonal flags: `hovered`
  // follows the pointer, `pinned` is the click/focus-open state. Hooks run
  // before the system-line early return (they are unconditional per row;
  // a row's kind never changes for its key).
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)

  if (props.message.kind === 'system') {
    return <p className="my-1 text-center text-xs text-muted">{props.message.text}</p>
  }

  const own = props.message.authorId === 'self'
  const displayName = own
    ? props.ownNickname
    : disambiguatedNickname(props.message.authorNick, props.message.authorId, props.peers as Peer[])
  // Issue #95 — the author affordance needs the author's entry (its live
  // fingerprint): unknown or fingerprint-less authors offer nothing to key
  // the mute on, so no affordance renders.
  const authorFingerprint = own
    ? null
    : (props.peers.find((peer) => peer.id === props.message.authorId)?.fingerprint ?? null)
  const muteAuthor =
    authorFingerprint === null
      ? null
      : () => muteFromUi(authorFingerprint, props.message.authorNick)

  // Issue #98 — reaction affordances. Manual channels (no room swarm) get
  // none: `reactToMessage` would silently drop the toggle.
  const reactionsOffered = !props.message.roomId.startsWith('dm:manual:')
  const chips =
    reactionsOffered && props.message.reactions !== undefined
      ? aggregateReactions(props.message.reactions)
      : []
  const selfId = getSelfPeerId()
  // Reactor peerIds → nicknames for the chip tooltip: the peers list the row
  // already receives (one entry on DM feeds), falling back to the raw peerId
  // for unknown peers; the own peerId resolves to the own nickname.
  const reactorNicknames = (peerIds: readonly string[]): string[] =>
    peerIds.map(
      (id) =>
        props.peers.find((peer) => peer.id === id)?.nickname ??
        (id === selfId ? props.ownNickname : id),
    )
  const react = (emo: string) => {
    if (reactionsOffered) reactToMessage(props.message.roomId, props.message.id, emo)
    setPinned(false) // a pick dismisses the bar
  }
  const barVisible = reactionsOffered && (hovered || pinned)
  const dismissPinned = () => setPinned(false)

  return (
    <div
      className={`group flex flex-col ${own ? 'items-end' : 'items-start'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && pinned) {
          event.stopPropagation()
          dismissPinned()
        }
      }}
      onBlur={(event) => {
        // Focus-open stays open while the focus moves INSIDE the row
        // (opener → bar buttons); leaving the row dismisses it.
        if (pinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          dismissPinned()
        }
      }}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold" style={{ color: authorColor(props.message.authorId) }}>
          {displayName}
        </span>
        <time dateTime={new Date(props.message.ts).toISOString()} className="text-muted">
          {formatTimeHHMM(props.message.ts)}
        </time>
        {reactionsOffered && (
          <button
            type="button"
            aria-label={REACTION_ADD_LABEL}
            title={REACTION_ADD_LABEL}
            // Click AND focus both open (never toggle: focus fires before
            // click on mouse activation, so a toggle would close instantly).
            onClick={() => setPinned(true)}
            onFocus={() => setPinned(true)}
            className="rounded px-0.5 text-muted hover:text-text"
          >
            🙂
          </button>
        )}
        {muteAuthor !== null && (
          <button
            type="button"
            aria-label={muteAuthorAction(props.message.authorNick)}
            title={muteAuthorAction(props.message.authorNick)}
            onClick={muteAuthor}
            className="rounded px-0.5 text-muted hover:text-text"
          >
            🔇
          </button>
        )}
      </div>
      <div className="max-w-[85%] break-words text-sm leading-relaxed">
        {props.message.isAction === true ? (
          // Issue #99 — /me rendering convention: the italic «*nick acción*»
          // line, no Markdown parsing (a literal '*' inside the action prose
          // must not flip emphasis). LOCAL ONLY: the wire envelope carries no
          // marker (parseEnvelope drops unknown fields), so a peer's copy of
          // the same message renders as a plain row — the documented
          // asymmetry of the no-protocol-change convention.
          <em>{`*${displayName} ${props.message.text}*`}</em>
        ) : (
          <MarkdownRenderer text={props.message.text} mentions={props.mentionCandidates} />
        )}
      </div>
      {barVisible && (
        <div role="group" aria-label={REACTION_BAR_LABEL} className="mt-0.5 flex gap-0.5">
          {(REACT_EMOJIS as readonly ReactEmoji[]).map((emo) => (
            <button
              key={emo}
              type="button"
              aria-label={reactQuickPickLabel(emo)}
              title={reactQuickPickLabel(emo)}
              onClick={() => react(emo)}
              className="rounded border border-border bg-surface px-1 text-sm hover:bg-bg"
            >
              {emo}
            </button>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div role="group" aria-label={REACTIONS_ROW_LABEL} className="mt-0.5 flex flex-wrap gap-1">
          {chips.map(({ emo, peerIds }) => {
            const mine = peerIds.includes(selfId)
            return (
              <button
                key={emo}
                type="button"
                aria-pressed={mine}
                title={reactionChipTooltip(reactorNicknames(peerIds))}
                onClick={() => react(emo)}
                className={`rounded-full border px-1.5 text-xs ${
                  mine
                    ? 'border-accent bg-surface text-text'
                    : 'border-border text-muted hover:text-text'
                }`}
              >
                {emo} {peerIds.length}
              </button>
            )
          })}
        </div>
      )}
      {own && (
        <span
          className="text-xs text-muted"
          aria-label={
            props.message.status === 'delivered' ? 'entregado' : 'enviado, pendiente de recepción'
          }
        >
          {props.message.status === 'delivered' ? '✓✓' : '✓'}
        </span>
      )}
    </div>
  )
})
