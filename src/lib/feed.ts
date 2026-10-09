/**
 * Chat-feed presentation helpers (RF-03 / RF-06 / spec §10.4): system-line
 * texts, the FIFO separator, smart-scroll decision, HH:MM formatting and
 * the typing-indicator line. Pure functions, unit-testable without DOM.
 *
 * Issue #119 phase 2 — i18n: the user-facing strings live in
 * `src/i18n/en.ts` under `feed.*`, `dm.*` and `slash.*`. Every builder
 * resolves through `t()`/`tPlural()` on each call — locale-live, no
 * caching. Plain-string constants survive as LEGACY SHIMS for the test
 * suites that import them (`export const X = t('key')`, resolved ONCE at
 * module load — NOT locale-live); component consumers must use `t('key')`
 * instead, and a shim with no remaining test importer is deleted.
 */

import { t, tPlural } from '../i18n/index'

/** RF-03 — separator shown when the 500-message cap has trimmed history.
 * Legacy shim (module-load resolution; see the module docblock). */
export const FIFO_SEPARATOR_TEXT = t('feed.fifoSeparator')

/**
 * Issue #96 — local separator for TTL messages the expiry sweep has removed
 * from this feed. Mirrors the FIFO separator: one line above the history,
 * memory-only; the count accumulates for the feed's lifetime (same latched
 * semantics as the FIFO trim flag). Locale-live: resolves on every call.
 */
export function expiredSeparatorText(count: number): string {
  return tPlural('feed.expiredSeparator', count)
}

/**
 * Issue #102 — local separator above history recovered through opt-in
 * history gossip. Exact issue string, no count: it labels PROVENANCE (these
 * rows are a peer's replay, not live arrivals), not a quantity. Latched per
 * feed like the FIFO/expired lines (rendered while `recoveredCount > 0`),
 * memory-only, and never sent over the wire. FROZEN verbatim by
 * tests/historyGossipDocs.test.ts.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const RECOVERED_SEPARATOR_TEXT = t('feed.recoveredSeparator')

/** Empty room feed: invites sharing the room name (RF-02).
 * Legacy shims (module-load resolution; see the module docblock). */
export const EMPTY_ROOM_FEED_TEXT = t('feed.emptyRoom')

/** Empty DM feed (RF-04): the conversation exists but has no messages yet.
 * Legacy shims (module-load resolution; see the module docblock). */
export const EMPTY_DM_FEED_TEXT = t('feed.emptyDm')

/** Empty *Direct messages* section (RF-04): no open DM channels.
 * Legacy shims (module-load resolution; see the module docblock). */
export const EMPTY_DM_LIST_TEXT = t('feed.emptyDmList')

/** Empty *Recents* section (RF-02): nothing remembered yet.
 * Legacy shims (module-load resolution; see the module docblock). */
export const EMPTY_RECENTS_TEXT = t('feed.emptyRecents')

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

/** Local HH:MM for a message timestamp (RF-03: author's ts, local render).
 * Locale-neutral: clock digits, not copy. */
export function formatTimeHHMM(ts: number): string {
  const date = new Date(ts)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** RF-06 — system feed lines for peer joins/leaves. Locale-live. */
export function joinSystemLine(nickname: string): string {
  return t('feed.joinLine', { nickname })
}

export function leaveSystemLine(nickname: string): string {
  return t('feed.leaveLine', { nickname })
}

/**
 * Issue #95 — local-only feed lines for a UI mute/unmute of a peer (never
 * sent over the wire). The @-prefixed nickname identifies the affected
 * identity; it is display text, not a mention. Locale-live.
 */
export function muteSystemLine(nickname: string): string {
  return t('feed.muteLine', { nickname })
}

export function unmuteSystemLine(nickname: string): string {
  return t('feed.unmuteLine', { nickname })
}

// ---------------------------------------------------------------------------
// Issue #99 (issue #112 phase 1) — local feed lines for the slash commands
// (executor feedback and errors). These builders are slash-only (nothing
// else consumes them) and resolve through `slash.*` keys, locale-live. Like
// the mute lines above, they are never sent over the wire.
// ---------------------------------------------------------------------------

/** Inline hint for an unknown verb — never sent, points at /help.
 * Legacy shim (module-load resolution; see the module docblock). */
export const UNKNOWN_COMMAND_HINT = t('slash.unknownCommand')

/** Error line when a room-scoped command (/clear, /leave) has no target.
 * Legacy shim (module-load resolution; see the module docblock). */
export const NO_ACTIVE_ROOM_TEXT = t('slash.noActiveRoom')

/** Confirmation line after a successful /nick (the manager re-announced presence). Locale-live. */
export function nicknameChangedLine(nickname: string): string {
  return t('slash.nicknameChanged', { nickname })
}

/**
 * /rooms output: one line listing the active rooms in join order, each with
 * its unread badge when it has pending messages. The `#{name}` pieces stay
 * literal in every locale (a room name is a protocol token); the prefix and
 * the unread badge translate. Locale-live.
 */
export function activeRoomsLine(rooms: ReadonlyArray<{ name: string; unread: number }>): string {
  if (rooms.length === 0) return t('slash.noActiveRooms')
  const parts = rooms.map((room) =>
    room.unread > 0
      ? tPlural('slash.roomUnread', room.unread, { name: room.name })
      : `#${room.name}`,
  )
  return t('slash.activeRooms', { rooms: parts.join(', ') })
}

/** /dm error: no current peer carries that nickname (case-insensitive match). Locale-live. */
export function dmPeerNotFoundLine(nickname: string): string {
  return t('slash.dmPeerNotFound', { nickname })
}

/** /dm error: several peers share the nickname; the peer list disambiguates. Locale-live. */
export function dmAmbiguousLine(nickname: string): string {
  return t('slash.dmAmbiguous', { nickname })
}

/**
 * Typing indicator line (RF-03): one known nick → 'nick is typing…',
 * several → 'N people are typing…', none → null (bar hidden). Locale-live.
 */
export function typingStatusText(nicknames: readonly string[]): string | null {
  if (nicknames.length === 0) return null
  return tPlural('feed.typing', nicknames.length, { nickname: nicknames[0] as string })
}

/** Floating new-messages button label (RF-03: '↓ N new messages'). Locale-live. */
export function newMessagesButtonText(count: number): string {
  return tPlural('feed.newMessages', count)
}

// ---------------------------------------------------------------------------
// DM view texts (RF-04, exact spec wording)
// ---------------------------------------------------------------------------

/** RF-04 — header state when the peer shares no active room anymore. The
 * manual wizard's drop text (§12.2) resolves the same key — one wording.
 * Legacy shims (module-load resolution; see the module docblock). */
export const DM_DISCONNECTED_TEXT = t('dm.peerDisconnected')

/**
 * Issue #93 (spec §12.1) — composer hint when the connected peer runs a
 * legacy build (no session-ephemeral `ephkeys` announce): DMs are
 * impossible until it updates, and the honest state replaces the silent
 * message loss of the mixed-version degradation.
 * Legacy shim (module-load resolution; see the module docblock).
 */
export const DM_LEGACY_PEER_TEXT = t('dm.legacyPeer')

/**
 * Typing indicator note: the DM-header TOFU texts (`dm.verifyNotice`,
 * `dm.keyChangedWarning`, `dm.keyChangedHint`) moved to i18n with no shims —
 * their only consumer is the DmHeader component, which resolves the keys
 * through `useT()` at render time.
 */

/** Accessible label of the DM message feed. Locale-live. */
export function dmFeedLabel(peerNick: string): string {
  return t('dm.feedLabel', { peerNick })
}
