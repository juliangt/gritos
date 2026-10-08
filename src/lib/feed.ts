/**
 * Chat-feed presentation helpers (RF-03 / RF-06 / spec §10.4): system-line
 * texts, the FIFO separator, smart-scroll decision, HH:MM formatting and
 * the typing-indicator line. Pure functions, unit-testable without DOM.
 */

/** RF-03 — separator shown when the 500-message cap has trimmed history. */
export const FIFO_SEPARATOR_TEXT = '— mensajes anteriores descartados —'

/**
 * Issue #96 — local separator for TTL messages the expiry sweep has removed
 * from this feed. Mirrors the FIFO separator: one line above the history,
 * memory-only; the count accumulates for the feed's lifetime (same latched
 * semantics as the FIFO trim flag).
 */
export function expiredSeparatorText(count: number): string {
  const noun = count === 1 ? 'mensaje expirado' : 'mensajes expirados'
  return `— ${count} ${noun} —`
}

/**
 * Issue #102 — local separator above history recovered through opt-in
 * history gossip. Exact issue string, no count: it labels PROVENANCE (these
 * rows are a peer's replay, not live arrivals), not a quantity. Latched per
 * feed like the FIFO/expired lines (rendered while `recoveredCount > 0`),
 * memory-only, and never sent over the wire.
 */
export const RECOVERED_SEPARATOR_TEXT = '— mensajes recuperados de pares —'

// ---------------------------------------------------------------------------
// Empty states (M6, spec §10.4 — discrete; English UI copy per issue #112)
// ---------------------------------------------------------------------------

/** Empty room feed: invites sharing the room name (RF-02). */
export const EMPTY_ROOM_FEED_TEXT = 'Share the room name so others can join.'

/** Empty DM feed (RF-04): the conversation exists but has no messages yet. */
export const EMPTY_DM_FEED_TEXT = 'No messages yet. Write the first one.'

/** Empty *Direct messages* section (RF-04): no open DM channels. */
export const EMPTY_DM_LIST_TEXT =
  'No direct messages yet. Open a peer’s menu to start an encrypted conversation.'

/** Empty *Recents* section (RF-02): nothing remembered yet. */
export const EMPTY_RECENTS_TEXT = 'No recent rooms yet.'

/** RF-03 — auto-scroll only when the user is at most this far from the bottom. */
export const SMART_SCROLL_THRESHOLD_PX = 150

/** ChatInput — typing signals are sent at most once per second (RF-03). */
export const TYPING_SIGNAL_THROTTLE_MS = 1_000

/** ChatInput — typing stops after this much idle time (RF-03). */
export const TYPING_IDLE_STOP_MS = 2_000

/** ChatInput — the character counter becomes visible from this length. */
export const CHAR_COUNTER_FROM = 3_800

/** True when the feed may auto-scroll (user is ≤ threshold px from bottom). */
export function shouldAutoScroll(distanceFromBottomPx: number): boolean {
  return distanceFromBottomPx <= SMART_SCROLL_THRESHOLD_PX
}

/** Local HH:MM for a message timestamp (RF-03: author's ts, local render). */
export function formatTimeHHMM(ts: number): string {
  const date = new Date(ts)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** RF-06 — system feed lines for peer joins/leaves. */
export function joinSystemLine(nickname: string): string {
  return `— ${nickname} se ha unido —`
}

export function leaveSystemLine(nickname: string): string {
  return `— ${nickname} ha salido —`
}

/**
 * Issue #95 — local-only feed lines for a UI mute/unmute of a peer (never
 * sent over the wire). The @-prefixed nickname identifies the affected
 * identity; it is display text, not a mention.
 */
export function muteSystemLine(nickname: string): string {
  return `@${nickname} fue silenciado`
}

export function unmuteSystemLine(nickname: string): string {
  return `@${nickname} ya no está silenciado`
}

// ---------------------------------------------------------------------------
// Issue #99 (issue #112 phase 1) — local feed lines for the slash commands
// (executor feedback and errors). English per the issue-#112 rename: these
// builders are slash-only (nothing else consumes them). Like the mute lines
// above, they are never sent over the wire.
// ---------------------------------------------------------------------------

/** Inline hint for an unknown verb — never sent, points at /help. */
export const UNKNOWN_COMMAND_HINT = 'Unknown command — /help'

/** Error line when a room-scoped command (/clear, /leave) has no target. */
export const NO_ACTIVE_ROOM_TEXT = 'No active room.'

/** Confirmation line after a successful /nick (the manager re-announced presence). */
export function nicknameChangedLine(nickname: string): string {
  return `Nickname changed to "${nickname}"`
}

/**
 * /rooms output: one line listing the active rooms in join order, each with
 * its unread badge when it has pending messages.
 */
export function activeRoomsLine(rooms: ReadonlyArray<{ name: string; unread: number }>): string {
  if (rooms.length === 0) return 'No active rooms.'
  const parts = rooms.map((room) =>
    room.unread > 0 ? `#${room.name} (${room.unread} unread)` : `#${room.name}`,
  )
  return `Active rooms: ${parts.join(', ')}`
}

/** /dm error: no current peer carries that nickname (case-insensitive match). */
export function dmPeerNotFoundLine(nickname: string): string {
  return `Nobody among your peers is named "${nickname}".`
}

/** /dm error: several peers share the nickname; the peer list disambiguates. */
export function dmAmbiguousLine(nickname: string): string {
  return `Several peers are named "${nickname}": open the conversation from the peer list.`
}

/**
 * Typing indicator line (RF-03): one known nick → 'nick is typing…',
 * several → 'N people are typing…', none → null (bar hidden).
 */
export function typingStatusText(nicknames: readonly string[]): string | null {
  if (nicknames.length === 0) return null
  if (nicknames.length === 1) return `${nicknames[0] as string} is typing…`
  return `${nicknames.length} people are typing…`
}

/** Floating new-messages button label (RF-03: '↓ N new messages'). */
export function newMessagesButtonText(count: number): string {
  const noun = count === 1 ? 'new message' : 'new messages'
  return `↓ ${count} ${noun}`
}

// ---------------------------------------------------------------------------
// DM view texts (RF-04, exact spec wording)
// ---------------------------------------------------------------------------

/** RF-04 — header state when the peer shares no active room anymore. */
export const DM_DISCONNECTED_TEXT = 'The peer has disconnected'

/**
 * Issue #93 (spec §12.1) — composer hint when the connected peer runs a
 * legacy build (no session-ephemeral `ephkeys` announce): DMs are
 * impossible until it updates, and the honest state replaces the silent
 * message loss of the mixed-version degradation.
 */
export const DM_LEGACY_PEER_TEXT =
  'This peer runs an older version without per-session encrypted DMs'

/** RF-04 — TOFU verification notice shown under the peer's fingerprint. */
export const DM_VERIFY_NOTICE = 'Compare it with your contact to verify their identity'

/**
 * Issue #22 — TOFU divergence warning: the peer's live fingerprint differs
 * from the pinned first-seen one. Advisory only (messages keep flowing).
 */
export const DM_KEY_CHANGED_WARNING = '⚠ The fingerprint changed since your last verification'

/** Issue #22 — explanation shown with the TOFU divergence warning. */
export const DM_KEY_CHANGED_HINT =
  'The peer may have reinstalled the app or could be an impersonation: verify their identity through another channel before trusting them.'

/** Accessible label of the DM message feed. */
export function dmFeedLabel(peerNick: string): string {
  return `Direct messages with ${peerNick}`
}
