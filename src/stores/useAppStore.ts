import { create } from 'zustand'
import { t, tPlural, type LanguageSetting } from '../i18n/index'
import { REACT_EMOJIS, type ReactEmoji } from '../lib/p2p/protocol'

/**
 * Base state types — spec.md §8.1.
 *
 * Everything here lives in memory only. The sole persistence surface of v1
 * is the `gritos:*` keys in `localStorage` (spec §8.2); messages, presence,
 * typing and passwords are never persisted. M1 adds the actions that the
 * RoomManager (lib/p2p) uses to wire P2P events into this state.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'

export interface Settings {
  /** Join #lobby automatically on start. Default: true */
  autoJoinLobby: boolean
  /** Empty list = Trystero defaults; a non-empty list replaces them (RF-07). */
  trackers: string[]
  /** Empty list = Trystero defaults; supports stun: and turn: with credentials. */
  iceServers: RTCIceServer[]
  /** Simultaneous active rooms, 1..6. Default: 4 (RF-02). */
  maxActiveRooms: number
  /** Default: 'system', synced live with prefers-color-scheme (RF-10). */
  theme: ThemeChoice
  /** Desktop notifications; additionally requires browser permission. Default: false. */
  notifications: boolean
  /** Remember recent room names (names only, never content). Default: true. */
  rememberRooms: boolean
  /**
   * Keep TURN credentials in this browser's storage (issue #30). When false
   * they stay in memory for the session only: the persisted `gritos:settings`
   * JSON drops them, so a reload requires re-entering them. Default: true.
   */
  rememberTurnCredentials: boolean
  /**
   * Issue #95 — fingerprints of muted peers, each in the canonical form
   * (`canonicalFingerprint`: whitespace-free uppercase, the 8×4 display
   * groups concatenated to 32 hex chars). Rides inside `gritos:settings`
   * (spec §8.2: no sixth localStorage key), capped at MAX_MUTED_FINGERPRINTS
   * entries; the cap refuses, it never evicts. Default: [].
   */
  mutedFingerprints: string[]
  /**
   * Issue #102 — opt-in history gossip: when true, an explicit peer
   * `hist-req` may be answered with at most the last 50 chat messages of
   * that room's in-memory feed (never DMs, never system lines). Gossip
   * itself is memory-only — it can only share what a live tab holds — but
   * the consent flag rides inside `gritos:settings` (spec §8.2: no sixth
   * localStorage key) and is wiped by the panic button like everything else.
   * Default: false — the default is silence.
   */
  shareHistory: boolean
  /**
   * Issue #105 (spec §12.5) — opt-in global DM signaling channel: when true
   * the app joins the well-known signal swarm (presence = nick + fingerprint
   * only) and can be knocked BY FINGERPRINT; an accepted knock opens an E2EE
   * DM backed by that swarm. Joining is a visible privacy decision (it
   * exposes IP, fingerprint and nickname to every opt-in peer), so the
   * default is OFF — join/leave rides this flag and leaving tears down every
   * piece of signal-swarm state. Rides inside `gritos:settings` (spec §8.2:
   * no sixth localStorage key) and is wiped by the panic button like the
   * rest of the record.
   */
  globalDm: boolean
  /**
   * Issue #119 — UI language. 'auto' follows the browser: Spanish when
   * `navigator.language` starts with "es", English for everything else
   * (including undefined/empty); 'en'/'es' pin the locale outright. The
   * raw choice persists here while the RESOLVED locale lives in the i18n
   * runtime (src/i18n/index, which re-derives it on boot and on change).
   * Rides inside `gritos:settings` (spec §8.2) and is wiped by the panic
   * button like the rest of the record. Default: 'auto'.
   */
  language: LanguageSetting
}

export interface Identity {
  nickname: string
  /** SHA-256 of the raw public key → hex, 4 groups of 4 (spec §9.1). */
  fingerprint: string
  createdAt: number
}

export interface Peer {
  /** Trystero peerId (stable per session). */
  id: string
  nickname: string
  /**
   * Set once their `keys` action has been received. Issue #22 (TOFU): when
   * the peer's live key diverges from the pinned first-seen fingerprint
   * (`gritos:tofu`), this holds the pinned value — the authoritative
   * displayed identity.
   */
  fingerprint: string | null
  /** Last known RTT in ms. */
  latencyMs: number | null
  /** 3 consecutive pings without response (RF-06). */
  degraded: boolean
}

export type MessageStatus = 'sent' | 'delivered'

/**
 * M2 additive extension (spec §8.1 field names preserved): 'system' marks
 * the discrete join/leave and FIFO-cap separator lines (RF-03/RF-06).
 * Absent kind is treated as 'user'.
 */
export type MessageKind = 'user' | 'system'

export interface Message {
  id: string
  /** Room id, or `dm:<peerId>` for direct messages. */
  roomId: string
  /** Author peerId, 'self' for our own messages, 'system' for feed lines. */
  authorId: string
  authorNick: string
  text: string
  ts: number
  /** Received encrypted with the room password (RF-05). */
  encrypted: boolean
  /** Only meaningful for our own messages (RF-03 receipts). */
  status: MessageStatus
  kind?: MessageKind
  /**
   * Issue #96 — absolute receiver-clock expiry instant (append-time
   * Date.now() + ttl*1000); undefined = session-lived (only the FIFO cap
   * evicts it). Never derived from the author `ts`: that is only
   * skew-tolerated ±90 s and must not be trusted for expiry.
   */
  expiresAt?: number
  /**
   * Issue #98 — aggregated emoji reactions, peerIds per whitelisted emoji.
   * Cosmetic class (spec §9.5): memory-only, never persisted, never
   * notified — the map dies with its message row (FIFO cap or TTL sweep).
   * Capped by `applyReactionsToMessages`: at most REACT_EMOJIS.length keys
   * (the whole whitelist — the wire cannot produce more, the cap only
   * fences non-whitelisted seeds) and at most MAX_REACTIONS_PER_EMOJI
   * peerIds per emoji (refused, never evicted). Applies to room and DM
   * messages alike.
   */
  reactions?: Partial<Record<ReactEmoji, string[]>>
  /**
   * Issue #99 — local rendering convention for a message sent through /me:
   * MessageItem renders the row as the italic "*nick action*" line. LOCAL
   * ONLY by design (no protocol change): the wire envelope carries no marker
   * and parseEnvelope rebuilds received messages without it, so a peer's
   * copy of the same message renders as plain text. Set exclusively by
   * sendChat's local echo when the composer forwards a /me directive.
   */
  isAction?: boolean
  /**
   * Issue #102 — provenance marker: the row was recovered through opt-in
   * history gossip, not received live. Rendered slightly dimmed under the
   * "messages recovered from peers" separator (MessageItem/MessageFeed). Purely
   * presentational: recovered rows never badge, never notify and never
   * receipt (the recovered append path guarantees it), and the marker is
   * memory-only like every feed field.
   */
  recovered?: boolean
}

export type RoomStatus = 'searching' | 'connected' | 'error'

export interface Room {
  /** Derived hash — spec §9.4. */
  id: string
  /** Normalized name, without '#'. */
  name: string
  hasPassword: boolean
  status: RoomStatus
  /** Peers of THIS room only. */
  peers: Peer[]
  /** Hard cap of 500 messages, FIFO discard (RF-03). */
  messages: Message[]
  /** peerId → timestamp of the last typing signal (expires after 4 s). */
  typing: Record<string, number>
  unread: number
  /** True once the FIFO cap has trimmed this room's history (RF-03). */
  fifoTrimmed: boolean
  /**
   * Issue #96 — how many TTL messages the expiry sweep has removed from this
   * feed (drives the local "N expired messages" separator). Same
   * semantics as `fifoTrimmed`: per-feed, latched for the feed's lifetime
   * (a leave/rejoin starts a fresh room at 0), memory-only.
   */
  expiredCount: number
  /**
   * Issue #102 — how many chat rows this feed accepted through the opt-in
   * history-gossip recovery path (drives the local
   * "— messages recovered from peers —" separator). Same latched semantics
   * as `expiredCount`: per-feed, never decrements (FIFO or TTL may later
   * remove rows — the separator records what already happened), and a
   * leave/rejoin starts a fresh room at 0.
   */
  recoveredCount: number
  /**
   * Issue #102 — per-join dismissal of the inline history-request card
   * (memory-only, like every Room field): set by either card button. The
   * row is recreated on every join, so the offer naturally returns on the
   * next join of the same room — the per-room ask budget in the manager
   * rate-limits the actual sends.
   */
  historyAskDismissed: boolean
  /**
   * Issue #125 — latched hint that the §10.3 error heuristic expired while
   * the trackers were REACHABLE and the room had no peers (a genuinely empty
   * room stays `searching` instead of erroring): ChatHeader shows the
   * "may be empty" line and ChatLayout offers the prefilled password join.
   * Same semantics family as `fifoTrimmed`/`expiredCount`: per-feed, latched
   * for the feed's lifetime, memory-only (never persisted, never notified).
   * Cleared when peers arrive, when the heuristic fires the real error or
   * when the last peer leaves (it may re-latch at the next peerless expiry);
   * a leave/rejoin starts a fresh room without it. Optional so Room literals
   * written before the hint existed stay valid.
   */
  peerlessHint?: boolean
}

export interface DmChannel {
  peerId: string
  peerNick: string
  /**
   * M3 additive field (spec §8.1 field names preserved): fingerprint derived
   * from the peer's `keys` action — the crypto-trusted value shown in the
   * DM header for TOFU verification.
   */
  peerFingerprint: string | null
  /** Hard cap of 500 messages, FIFO discard (RF-04). */
  messages: Message[]
  unread: number
  /**
   * Issue #96 — TTL messages removed from this channel by the expiry sweep;
   * feeds the DM separator like the room's `expiredCount` (RF-03 analog).
   */
  expiredCount: number
  /** false once no active room is shared with the peer anymore. */
  available: boolean
  /**
   * M3 additive field: peerId → timestamp of the last DM typing signal
   * (RF-04: DMs inherit typing); expires after 4 s like room typing.
   */
  typing: Record<string, number>
  /**
   * Issue #22 (TOFU): true while the peer's live fingerprint differs from
   * the pinned first-seen one (`gritos:tofu`). Advisory only — messages
   * keep flowing; the header warns and `peerFingerprint` stays pinned.
   */
  keyChanged: boolean
  /**
   * Issue #93 (spec §12.1): true while the peer is connected but has never
   * announced a session-ephemeral key (`ephkeys`) — a legacy build that can
   * neither open our v2 dms nor send one. The composer blocks with an
   * explicit hint instead of letting messages vanish silently.
   */
  legacyPeer: boolean
  /**
   * Issue #97 (spec §12.2) — additive marker, true ONLY on trackerless
   * manual channels (keyed `manual:<fingerprint>` in `manualDms`): DmList
   * shows the "(no room)" marker for them. Room-backed channels never set
   * it; the room-DM shapes and behavior are untouched.
   */
  manual?: boolean
  /**
   * Issue #105 (spec §12.5) — additive marker, true ONLY on signal-swarm
   * channels (keyed by the canonical identity fingerprint in `dms`): DmList
   * shows the «(global)» marker for them, the sibling of the "(no room)"
   * manual marker. Room-backed channels never set it (their keys are
   * Trystero peerIds, a disjoint namespace from 32-hex fingerprints).
   */
  global?: boolean
}

export type ActiveView = { kind: 'room'; id: string } | { kind: 'dm'; peerId: string }

export interface AppState {
  identity: Identity | null
  /** Key: Room.id. */
  rooms: Record<string, Room>
  activeView: ActiveView | null
  /** Key: peerId. */
  dms: Record<string, DmChannel>
  /**
   * Issue #97 (spec §12.2) — trackerless manual DM channels, keyed
   * `manual:<canonical-fingerprint>` (the fingerprint-keyed TOFU convention;
   * manual peers have no Trystero peerId). Same DmChannel shape as `dms`, so
   * MessageFeed/DmHeader/ChatInput work unchanged. Session-only like every
   * channel here: nothing is persisted beyond the `gritos:tofu` pins.
   */
  manualDms: Record<string, DmChannel>
  /** Room names only, never content. */
  recentRooms: string[]
}

export const INITIAL_APP_STATE: AppState = {
  identity: null,
  rooms: {},
  activeView: null,
  dms: {},
  manualDms: {},
  recentRooms: [],
}

/** RF-03 — memory cap: at most the last 500 messages per room. */
export const MESSAGE_CAP = 500

/**
 * spec §7.3 — order: messages are shown in arrival order, but inside a 2 s
 * window they are ordered by `ts`. A received message only walks back over
 * recent USER messages; own echoes and local system lines stay at the tail
 * (the user typed them there) and act as barriers.
 */
export const ARRIVAL_ORDER_WINDOW_MS = 2_000

/**
 * Pure FIFO-cap append used by the store action (testable in isolation).
 * Implements the §7.3 order rule: plain append for own/system messages,
 * ts-ordered insertion inside ARRIVAL_ORDER_WINDOW_MS for received ones.
 */
export function appendMessageCapped(
  messages: Message[],
  message: Message,
  cap: number = MESSAGE_CAP,
): Message[] {
  let index = messages.length
  if (message.authorId !== 'self' && message.kind !== 'system') {
    while (index > 0) {
      const previous = messages[index - 1] as Message
      if (
        previous.kind !== 'user' ||
        previous.authorId === 'self' ||
        !(message.ts < previous.ts && previous.ts - message.ts <= ARRIVAL_ORDER_WINDOW_MS)
      ) {
        break
      }
      index -= 1
    }
  }
  const next = [...messages.slice(0, index), message, ...messages.slice(index)]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Issue #102 — pure recovered-history append (testable in isolation, like
 * `appendMessageCapped`): strict batch-order TAIL append under the FIFO cap.
 * The §7.3 arrival-order rule (the 2 s ts-window walk-back) deliberately
 * does NOT apply to replayed messages — a gossip batch replays feed history
 * whose author timestamps are long past any arrival window, so reordering
 * by ts would shuffle the block; arrival (batch) order is kept instead.
 */
export function appendRecoveredCapped(
  messages: Message[],
  message: Message,
  cap: number = MESSAGE_CAP,
): Message[] {
  const next = [...messages, message]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Issue #96 — pure expiry partition of one feed (testable in isolation,
 * like `appendMessageCapped`): messages whose `expiresAt` is due at `now`
 * (inclusive) are expired; session-lived ones (no `expiresAt`) are never
 * swept. Order of the kept prefix is preserved.
 */
export function partitionExpired(
  messages: readonly Message[],
  now: number,
): { kept: Message[]; expired: Message[] } {
  const kept: Message[] = []
  const expired: Message[] = []
  for (const message of messages) {
    if (message.expiresAt !== undefined && message.expiresAt <= now) expired.push(message)
    else kept.push(message)
  }
  return { kept, expired }
}

/**
 * Issue #98 — state cap on one emoji's reactor list: the 51st peerId is
 * refused (never evicted), the same refuse-not-evict discipline as the mute
 * list and the receipt batch cap. Aggregation stays honest: every peer
 * derives counts from the same payloads, so a cap overflow degrades to a
 * missing reaction, never a wrong count.
 */
export const MAX_REACTIONS_PER_EMOJI = 50

/**
 * Issue #98 — one reaction toggle over one message (pure, testable like
 * `appendMessageCapped`): `on: true` appends `reactorId` to `reactions[emoji]`
 * (idempotent), `on: false` removes it (absent = no-op) and drops the key
 * when its list empties (an empty map normalizes back to undefined, so no
 * ghost state survives an unreact). Caps refuse without touching state:
 * a NEW emoji key beyond REACT_EMOJIS.length (the whole whitelist — honest
 * wire traffic can never reach this, the cap only fences hand-made or
 * legacy seeds) and a 51st peerId on one list. Returns the SAME message
 * object when nothing changed, so callers can keep their guarded write.
 */
export function toggleMessageReaction(
  message: Message,
  emo: string,
  reactorId: string,
  on: boolean,
): Message {
  // The whitelist is the single emoji gate (phase-1 parseReact upstream for
  // wire traffic; the UI picker for local toggles): anything else is a no-op.
  if (!(REACT_EMOJIS as readonly string[]).includes(emo)) return message
  const emoji = emo as ReactEmoji
  const current = message.reactions?.[emoji] ?? []
  const has = current.includes(reactorId)
  if (on === has) return message
  if (on) {
    if (current.length >= MAX_REACTIONS_PER_EMOJI) return message
    const existing = message.reactions
    const isNewKey = existing === undefined || !(emoji in existing)
    if (
      isNewKey &&
      (existing === undefined
        ? 0
        : Object.values(existing).filter((list) => list.length > 0).length) >= REACT_EMOJIS.length
    ) {
      return message
    }
    return { ...message, reactions: { ...existing, [emoji]: [...current, reactorId] } }
  }
  const remaining = current.filter((id) => id !== reactorId)
  const next: Partial<Record<ReactEmoji, string[]>> = { ...message.reactions, [emoji]: remaining }
  if (remaining.length === 0) delete next[emoji]
  return { ...message, reactions: Object.keys(next).length === 0 ? undefined : next }
}

/**
 * Issue #98 — reaction batch over one feed (pure, testable like
 * `partitionExpired`): applies the toggle to every message of `ids`, dropping
 * unknown ids silently — a reaction to an unknown or FIFO/TTL-evicted message
 * is cosmetic-class noise with no state to attach to. Returns null when NO
 * message changed (all ids unknown, toggles idempotent or cap-refused), so
 * callers keep their guarded write and the store reference stays untouched.
 * Deliberately NO unread, receipt or notification side effects: reactions
 * are cosmetic (spec §9.5).
 */
export function applyReactionsToMessages(
  messages: Message[],
  ids: readonly string[],
  emo: string,
  reactorId: string,
  on: boolean,
): Message[] | null {
  const idSet = new Set(ids)
  if (idSet.size === 0) return null
  let changed = false
  const next = messages.map((message) => {
    if (!idSet.has(message.id)) return message
    const toggled = toggleMessageReaction(message, emo, reactorId, on)
    if (toggled === message) return message
    changed = true
    return toggled
  })
  return changed ? next : null
}

/**
 * spec §10.3 — exact connection status header texts, including the
 * best-effort transition state (searching with peers already discovered but
 * no DataChannel yet): "Conectando (N pares encontrados)…".
 *
 * Issue #119 phase 2 — i18n: the three templates live in `chat.*`; the two
 * count-based ones are `…One`/`…Other` pairs selected by `tPlural` (English
 * singular grammar at count 1 — '1 peer'/'1 peer found' — matching the
 * seeded `common.peerCount` convention). Locale-live: resolves on every
 * call, so non-React callers (roomStatusText, the debug panel) see the
 * current locale.
 */
export function connectionStatusText(status: RoomStatus, peerCount: number): string {
  switch (status) {
    case 'searching':
      return peerCount > 0
        ? tPlural('chat.connectingStatus', peerCount)
        : t('chat.searchingStatus')
    case 'connected':
      return tPlural('chat.connectedStatus', peerCount)
    case 'error':
      return t('chat.networkErrorBanner')
  }
}

/** RF-06 — latency dot: 🟢 <150 ms, 🟡 150–400 ms, 🔴 >400 ms, ⚪ sin datos/degradado. */
export function latencyDot(latencyMs: number | null, degraded: boolean): string {
  if (degraded || latencyMs === null) return '⚪'
  if (latencyMs < 150) return '🟢'
  if (latencyMs <= 400) return '🟡'
  return '🔴'
}

/**
 * Actions used by the RoomManager to feed P2P events into the state.
 * All updates are immutable; actions targeting an unknown room no-op so
 * a leave/join race can never corrupt the state.
 */
export interface AppActions {
  setIdentity: (identity: Identity) => void
  upsertRoom: (room: Room) => void
  removeRoom: (roomId: string) => void
  setRoomStatus: (roomId: string, status: RoomStatus) => void
  /**
   * Issue #125 — flips the room's latched `peerlessHint` (true: the §10.3
   * heuristic expired over reachable trackers with zero peers; false: peers
   * arrived, the heuristic fired the real error or the last peer left).
   * Memory-only Room state like the field itself. Unknown roomId no-ops.
   */
  setRoomPeerlessHint: (roomId: string, hint: boolean) => void
  addPeer: (roomId: string, peer: Peer) => void
  updatePeer: (roomId: string, peerId: string, patch: Partial<Peer>) => void
  removePeer: (roomId: string, peerId: string) => void
  appendMessage: (roomId: string, message: Message) => void
  /**
   * Issue #102 — appends one RECOVERED chat row (opt-in history gossip) to
   * the room feed: strict batch-order tail append (`appendRecoveredCapped`,
   * the §7.3 2 s window does not apply to replayed messages), latches
   * `fifoTrimmed` like any cap-trimming append and bumps the latched
   * `recoveredCount` separator counter. Deliberately ZERO arrival side
   * effects — no unread badge (recovery is not an arrival: the rows are at
   * most the room's recent past), no receipts (✓✓ means LIVE delivery), no
   * mention emission (gating lives in the manager's wiring). Unknown roomId
   * no-ops.
   */
  appendRecoveredMessage: (roomId: string, message: Message) => void
  /**
   * Issue #102 — per-join dismissal of the inline history-request card
   * (either card button). Memory-only Room state: the flag dies with the
   * feed on leave, so a fresh join may offer the ask again. Unknown roomId
   * no-ops.
   */
  dismissHistoryAsk: (roomId: string) => void
  /**
   * Issue #99 — wipes one room's local feed (the /clear command, behind
   * its confirmation): messages: [] and unread: 0, while the room keeps its
   * CONNECTION and its identity in the store — this is a view clear, never a
   * leave. The latched separator facts (`fifoTrimmed`, `expiredCount`) stay
   * as-is: they record what ALREADY happened to the session's history, so
   * the "earlier messages discarded" / expired separators keep
   * rendering above the emptied feed. Unknown roomId no-ops.
   */
  clearRoomFeed: (roomId: string) => void
  markMessagesDelivered: (roomId: string, ids: string[]) => void
  /**
   * Issue #96 — removes every message whose `expiresAt` is due at `now` from
   * ALL room and DM feeds in one pass, accumulating each feed's
   * `expiredCount` (the local separator). Delivered receipts are never
   * revoked: removal is a feed-state change only. Returns the removed
   * message ids (the caller records them so a replayed envelope cannot
   * resurrect an expired message) — empty and state-untouched when nothing
   * expired.
   */
  sweepExpiredMessages: (now: number) => string[]
  /** ts = null clears the peer's typing entry. */
  setTyping: (roomId: string, peerId: string, ts: number | null) => void
  /**
   * M2 — switches the focused view without touching any room connection
   * (RF-02); opening a room or a DM clears its unread badge (RF-04).
   */
  setActiveView: (view: ActiveView | null) => void
  /** M2 — recent room names, most-recent-first (RF-02, §8.2). */
  setRecentRooms: (recent: string[]) => void
  /**
   * M3 — creates the DM channel for `peerId` when missing (RF-04); an
   * existing channel only gets its fingerprint refreshed when a non-null
   * one is provided (nickname history is kept).
   */
  ensureDmChannel: (peerId: string, peerNick: string, peerFingerprint: string | null) => void
  /** M3 — appends to `dms[peerId]` with the 500-message cap (RF-04). */
  appendDmMessage: (peerId: string, message: Message) => void
  /** M3 — flips own DM messages to 'delivered' on the peer's receipt. */
  markDmMessagesDelivered: (peerId: string, ids: string[]) => void
  /**
   * Issue #98 — applies an inbound reaction batch to `rooms[roomId]`'s
   * messages (unknown ids dropped silently, caps enforced by
   * `applyReactionsToMessages`). Cosmetic class: never touches unread,
   * receipts or notifications.
   */
  applyMessageReactions: (
    roomId: string,
    ids: string[],
    emo: string,
    reactorId: string,
    on: boolean,
  ) => void
  /** Issue #98 — the DM-channel mirror over `dms[peerId]`. */
  applyDmMessageReactions: (
    peerId: string,
    ids: string[],
    emo: string,
    reactorId: string,
    on: boolean,
  ) => void
  /** M3 — recomputes `available` after peer/room changes (RF-04). */
  setDmAvailable: (peerId: string, available: boolean) => void
  /** M3 — DM typing signal (ts = null clears); expires after 4 s. */
  setDmTyping: (peerId: string, ts: number | null) => void
  /**
   * Issue #22 — flips the channel's TOFU divergence flag. While true, the
   * pinned fingerprint is authoritative for display: `ensureDmChannel`
   * never overwrites it with the live one.
   */
  setDmKeyChanged: (peerId: string, keyChanged: boolean) => void
  /**
   * Issue #93 (spec §12.1) — flips the channel's legacy-peer flag (a
   * connected peer without a session-ephemeral announce). Recomputed by the
   * room manager on every peer/room/`ephkeys` change.
   */
  setDmLegacyPeer: (peerId: string, legacyPeer: boolean) => void
  /**
   * Issue #97 (spec §12.2) — the manual-channel mirrors of the `dms` slice
   * above, over `manualDms` (key `manual:<canonical-fingerprint>`). Same
   * guarded-write discipline; fed by the manualPeer engine callbacks.
   */
  ensureManualDmChannel: (key: string, peerNick: string, peerFingerprint: string | null) => void
  appendManualDmMessage: (key: string, message: Message) => void
  markManualDmMessagesDelivered: (key: string, ids: string[]) => void
  setManualDmAvailable: (key: string, available: boolean) => void
  /** ts = null clears the peer's typing entry. */
  setManualDmTyping: (key: string, ts: number | null) => void
  setManualDmKeyChanged: (key: string, keyChanged: boolean) => void
  /**
   * Issue #105 (spec §12.5) — creates the signal-backed DM channel for
   * `key` (the canonical identity fingerprint) when missing, marked
   * `global: true`; an existing channel only gets its fingerprint refreshed
   * under the same TOFU discipline as `ensureDmChannel`. The other channel
   * mutations reuse the `dms` actions above: the store stays unaware of the
   * backing swarm.
   */
  ensureGlobalDmChannel: (key: string, peerNick: string, peerFingerprint: string | null) => void
}

export const useAppStore = create<AppState & AppActions>()((set) => ({
  ...INITIAL_APP_STATE,

  setIdentity: (identity) => set({ identity }),

  upsertRoom: (room) => set((state) => ({ rooms: { ...state.rooms, [room.id]: room } })),

  removeRoom: (roomId) =>
    set((state) => {
      if (!(roomId in state.rooms)) return state
      const rooms = { ...state.rooms }
      delete rooms[roomId]
      return { rooms }
    }),

  setRoomStatus: (roomId, status) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room || room.status === status) return state
      return {
        rooms: { ...state.rooms, [roomId]: { ...room, status } },
      }
    }),

  setRoomPeerlessHint: (roomId, hint) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room || room.peerlessHint === hint) return state
      return {
        rooms: { ...state.rooms, [roomId]: { ...room, peerlessHint: hint } },
      }
    }),

  addPeer: (roomId, peer) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const peers = [...room.peers.filter((p) => p.id !== peer.id), peer]
      return { rooms: { ...state.rooms, [roomId]: { ...room, peers } } }
    }),

  updatePeer: (roomId, peerId, patch) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      let changed = false
      const peers = room.peers.map((peer) => {
        if (peer.id !== peerId) return peer
        changed = true
        return { ...peer, ...patch }
      })
      return changed ? { rooms: { ...state.rooms, [roomId]: { ...room, peers } } } : state
    }),

  removePeer: (roomId, peerId) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const peers = room.peers.filter((peer) => peer.id !== peerId)
      if (peers.length === room.peers.length) return state
      return { rooms: { ...state.rooms, [roomId]: { ...room, peers } } }
    }),

  appendMessage: (roomId, message) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const messages = appendMessageCapped(room.messages, message)
      const fifoTrimmed = room.fifoTrimmed || messages.length < room.messages.length + 1
      // RF-02 — messages arriving in non-focused rooms increment the unread
      // badge; own messages and system lines never do.
      const isActiveView = state.activeView?.kind === 'room' && state.activeView.id === roomId
      const countsAsUnread =
        message.authorId !== 'self' && message.kind !== 'system' && !isActiveView
      return {
        rooms: {
          ...state.rooms,
          [roomId]: {
            ...room,
            messages,
            fifoTrimmed,
            unread: countsAsUnread ? room.unread + 1 : room.unread,
          },
        },
      }
    }),

  markMessagesDelivered: (roomId, ids) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const idSet = new Set(ids)
      let changed = false
      const messages = room.messages.map((message) => {
        if (message.authorId !== 'self' || !idSet.has(message.id)) return message
        if (message.status === 'delivered') return message
        changed = true
        return { ...message, status: 'delivered' as const }
      })
      return changed ? { rooms: { ...state.rooms, [roomId]: { ...room, messages } } } : state
    }),

  // Issue #102 — the recovered append: same FIFO-cap discipline as the live
  // path, but arrival-silent (no unread) and latching the recovered
  // separator counter instead. `fifoTrimmed` latches when the append had to
  // trim (same formula as appendMessage).
  appendRecoveredMessage: (roomId, message) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      const messages = appendRecoveredCapped(room.messages, message)
      const fifoTrimmed = room.fifoTrimmed || messages.length < room.messages.length + 1
      return {
        rooms: {
          ...state.rooms,
          [roomId]: {
            ...room,
            messages,
            fifoTrimmed,
            recoveredCount: room.recoveredCount + 1,
          },
        },
      }
    }),

  dismissHistoryAsk: (roomId) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room || room.historyAskDismissed) return state
      return { rooms: { ...state.rooms, [roomId]: { ...room, historyAskDismissed: true } } }
    }),

  clearRoomFeed: (roomId) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (room === undefined) return state
      if (room.messages.length === 0 && room.unread === 0) return state
      return {
        rooms: { ...state.rooms, [roomId]: { ...room, messages: [], unread: 0 } },
      }
    }),

  // Issue #96 — one guarded pass over every room and DM feed per tick. The
  // removed ids ride back to the caller (the room manager's no-resurrection
  // guard); receipts are deliberately untouched (✓✓ stays).
  sweepExpiredMessages: (now) => {
    const removed: string[] = []
    set((state) => {
      let rooms: Record<string, Room> | null = null
      for (const [roomId, room] of Object.entries(state.rooms)) {
        const { kept, expired } = partitionExpired(room.messages, now)
        if (expired.length === 0) continue
        for (const message of expired) removed.push(message.id)
        rooms = {
          ...(rooms ?? state.rooms),
          [roomId]: { ...room, messages: kept, expiredCount: room.expiredCount + expired.length },
        }
      }
      let dms: Record<string, DmChannel> | null = null
      for (const [peerId, channel] of Object.entries(state.dms)) {
        const { kept, expired } = partitionExpired(channel.messages, now)
        if (expired.length === 0) continue
        for (const message of expired) removed.push(message.id)
        dms = {
          ...(dms ?? state.dms),
          [peerId]: {
            ...channel,
            messages: kept,
            expiredCount: channel.expiredCount + expired.length,
          },
        }
      }
      // Issue #97 — the manual channels ride the same sweep: their ttl
      // messages expire on the receiver clock exactly like room DMs.
      let manualDms: Record<string, DmChannel> | null = null
      for (const [key, channel] of Object.entries(state.manualDms)) {
        const { kept, expired } = partitionExpired(channel.messages, now)
        if (expired.length === 0) continue
        for (const message of expired) removed.push(message.id)
        manualDms = {
          ...(manualDms ?? state.manualDms),
          [key]: {
            ...channel,
            messages: kept,
            expiredCount: channel.expiredCount + expired.length,
          },
        }
      }
      if (rooms === null && dms === null && manualDms === null) return state
      const patch: Partial<AppState> = {}
      if (rooms !== null) patch.rooms = rooms
      if (dms !== null) patch.dms = dms
      if (manualDms !== null) patch.manualDms = manualDms
      return patch
    })
    return removed
  },

  setTyping: (roomId, peerId, ts) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (!room) return state
      if (ts === null && !(peerId in room.typing)) return state
      const typing = { ...room.typing }
      if (ts === null) delete typing[peerId]
      else typing[peerId] = ts
      return { rooms: { ...state.rooms, [roomId]: { ...room, typing } } }
    }),

  setActiveView: (view) =>
    set((state) => {
      if (view === null) return { activeView: null }
      // Opening a room clears its unread badge (RF-02); opening a DM does
      // the same for its channel (RF-04).
      if (view.kind === 'room') {
        const room = state.rooms[view.id]
        if (room !== undefined && room.unread > 0) {
          return {
            activeView: view,
            rooms: {
              ...state.rooms,
              [view.id]: { ...room, unread: 0 },
            },
          }
        }
      }
      if (view.kind === 'dm') {
        const channel = state.dms[view.peerId]
        if (channel !== undefined && channel.unread > 0) {
          return {
            activeView: view,
            dms: {
              ...state.dms,
              [view.peerId]: { ...channel, unread: 0 },
            },
          }
        }
        // Issue #97 — a manual channel clears its badge the same way (the
        // key namespaces keep `dms` and `manualDms` disjoint).
        const manual = state.manualDms[view.peerId]
        if (manual !== undefined && manual.unread > 0) {
          return {
            activeView: view,
            manualDms: {
              ...state.manualDms,
              [view.peerId]: { ...manual, unread: 0 },
            },
          }
        }
      }
      return { activeView: view }
    }),

  setRecentRooms: (recent) => set({ recentRooms: recent }),

  ensureDmChannel: (peerId, peerNick, peerFingerprint) =>
    set((state) => {
      const existing = state.dms[peerId]
      if (existing === undefined) {
        return {
          dms: {
            ...state.dms,
            [peerId]: {
              peerId,
              peerNick,
              peerFingerprint,
              messages: [],
              unread: 0,
              expiredCount: 0,
              available: false,
              typing: {},
              keyChanged: false,
              legacyPeer: false,
            },
          },
        }
      }
      // Issue #22 (TOFU): a flagged channel keeps its pinned fingerprint —
      // a rotated live value never silently overwrites the verified one.
      if (existing.keyChanged) return state
      if (peerFingerprint !== null && existing.peerFingerprint !== peerFingerprint) {
        return {
          dms: { ...state.dms, [peerId]: { ...existing, peerFingerprint } },
        }
      }
      return state
    }),

  appendDmMessage: (peerId, message) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      const messages = appendMessageCapped(channel.messages, message)
      // RF-04 — peer messages in non-focused DMs increment the unread badge;
      // own messages never do.
      const isActiveView = state.activeView?.kind === 'dm' && state.activeView.peerId === peerId
      const countsAsUnread =
        message.authorId !== 'self' && message.kind !== 'system' && !isActiveView
      return {
        dms: {
          ...state.dms,
          [peerId]: {
            ...channel,
            messages,
            unread: countsAsUnread ? channel.unread + 1 : channel.unread,
          },
        },
      }
    }),

  markDmMessagesDelivered: (peerId, ids) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      const idSet = new Set(ids)
      let changed = false
      const messages = channel.messages.map((message) => {
        if (message.authorId !== 'self' || !idSet.has(message.id)) return message
        if (message.status === 'delivered') return message
        changed = true
        return { ...message, status: 'delivered' as const }
      })
      return changed ? { dms: { ...state.dms, [peerId]: { ...channel, messages } } } : state
    }),

  // Issue #98 — guarded reaction writes over the room and DM slices: the
  // caps/toggle/unknown-id policy lives in the pure helper, the actions only
  // pick the slice. No unread change (cosmetic class, spec §9.5).
  applyMessageReactions: (roomId, ids, emo, reactorId, on) =>
    set((state) => {
      const room = state.rooms[roomId]
      if (room === undefined) return state
      const messages = applyReactionsToMessages(room.messages, ids, emo, reactorId, on)
      return messages === null
        ? state
        : { rooms: { ...state.rooms, [roomId]: { ...room, messages } } }
    }),

  applyDmMessageReactions: (peerId, ids, emo, reactorId, on) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      const messages = applyReactionsToMessages(channel.messages, ids, emo, reactorId, on)
      return messages === null
        ? state
        : { dms: { ...state.dms, [peerId]: { ...channel, messages } } }
    }),

  setDmAvailable: (peerId, available) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined || channel.available === available) return state
      // true→false keeps the history in memory (RF-04) — only the flag flips.
      return { dms: { ...state.dms, [peerId]: { ...channel, available } } }
    }),

  setDmTyping: (peerId, ts) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined) return state
      if (ts === null && !(peerId in channel.typing)) return state
      const typing = { ...channel.typing }
      if (ts === null) delete typing[peerId]
      else typing[peerId] = ts
      return { dms: { ...state.dms, [peerId]: { ...channel, typing } } }
    }),

  setDmKeyChanged: (peerId, keyChanged) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined || channel.keyChanged === keyChanged) return state
      return { dms: { ...state.dms, [peerId]: { ...channel, keyChanged } } }
    }),

  // Issue #93 (spec §12.1) — same guarded write discipline as
  // `setDmAvailable`: the store is only touched when the value changes.
  setDmLegacyPeer: (peerId, legacyPeer) =>
    set((state) => {
      const channel = state.dms[peerId]
      if (channel === undefined || channel.legacyPeer === legacyPeer) return state
      return { dms: { ...state.dms, [peerId]: { ...channel, legacyPeer } } }
    }),

  // ---------------------------------------------------------------------------
  // Issue #97 (spec §12.2) — manual channel slice: line-for-line mirrors of
  // the `dms` actions above over `manualDms`, plus the `manual: true` marker.
  // ---------------------------------------------------------------------------

  ensureManualDmChannel: (key, peerNick, peerFingerprint) =>
    set((state) => {
      const existing = state.manualDms[key]
      if (existing === undefined) {
        return {
          manualDms: {
            ...state.manualDms,
            [key]: {
              peerId: key,
              peerNick,
              peerFingerprint,
              messages: [],
              unread: 0,
              expiredCount: 0,
              available: false,
              typing: {},
              keyChanged: false,
              legacyPeer: false,
              manual: true,
            },
          },
        }
      }
      // Same TOFU discipline as `ensureDmChannel`: a flagged channel keeps
      // its pinned fingerprint — a rotated live value never overwrites it.
      if (existing.keyChanged) return state
      if (peerFingerprint !== null && existing.peerFingerprint !== peerFingerprint) {
        return {
          manualDms: { ...state.manualDms, [key]: { ...existing, peerFingerprint } },
        }
      }
      return state
    }),

  appendManualDmMessage: (key, message) =>
    set((state) => {
      const channel = state.manualDms[key]
      if (channel === undefined) return state
      const messages = appendMessageCapped(channel.messages, message)
      const isActiveView = state.activeView?.kind === 'dm' && state.activeView.peerId === key
      const countsAsUnread =
        message.authorId !== 'self' && message.kind !== 'system' && !isActiveView
      return {
        manualDms: {
          ...state.manualDms,
          [key]: {
            ...channel,
            messages,
            unread: countsAsUnread ? channel.unread + 1 : channel.unread,
          },
        },
      }
    }),

  markManualDmMessagesDelivered: (key, ids) =>
    set((state) => {
      const channel = state.manualDms[key]
      if (channel === undefined) return state
      const idSet = new Set(ids)
      let changed = false
      const messages = channel.messages.map((message) => {
        if (message.authorId !== 'self' || !idSet.has(message.id)) return message
        if (message.status === 'delivered') return message
        changed = true
        return { ...message, status: 'delivered' as const }
      })
      return changed
        ? { manualDms: { ...state.manualDms, [key]: { ...channel, messages } } }
        : state
    }),

  setManualDmAvailable: (key, available) =>
    set((state) => {
      const channel = state.manualDms[key]
      if (channel === undefined || channel.available === available) return state
      // true→false keeps the history in memory (RF-04 analog) — flag only.
      return { manualDms: { ...state.manualDms, [key]: { ...channel, available } } }
    }),

  setManualDmTyping: (key, ts) =>
    set((state) => {
      const channel = state.manualDms[key]
      if (channel === undefined) return state
      if (ts === null && !(key in channel.typing)) return state
      const typing = { ...channel.typing }
      if (ts === null) delete typing[key]
      else typing[key] = ts
      return { manualDms: { ...state.manualDms, [key]: { ...channel, typing } } }
    }),

  setManualDmKeyChanged: (key, keyChanged) =>
    set((state) => {
      const channel = state.manualDms[key]
      if (channel === undefined || channel.keyChanged === keyChanged) return state
      return { manualDms: { ...state.manualDms, [key]: { ...channel, keyChanged } } }
    }),

  // ---------------------------------------------------------------------------
  // Issue #105 (spec §12.5) — signal-backed channels live in the SAME `dms`
  // slice as room DMs (keyed by the canonical identity fingerprint, a
  // namespace disjoint from Trystero peerIds); only the CREATOR differs: it
  // stamps the additive `global: true` marker, the «(global)» sibling of the
  // manual "(no room)" marker. Every other mutation rides the `dms` actions.
  // ---------------------------------------------------------------------------

  ensureGlobalDmChannel: (key, peerNick, peerFingerprint) =>
    set((state) => {
      const existing = state.dms[key]
      if (existing === undefined) {
        return {
          dms: {
            ...state.dms,
            [key]: {
              peerId: key,
              peerNick,
              peerFingerprint,
              messages: [],
              unread: 0,
              expiredCount: 0,
              available: false,
              typing: {},
              keyChanged: false,
              legacyPeer: false,
              global: true,
            },
          },
        }
      }
      // Same TOFU discipline as `ensureDmChannel`: a flagged channel keeps
      // its pinned fingerprint — a rotated live value never overwrites it.
      if (existing.keyChanged) return state
      if (peerFingerprint !== null && existing.peerFingerprint !== peerFingerprint) {
        return {
          dms: { ...state.dms, [key]: { ...existing, peerFingerprint } },
        }
      }
      return state
    }),
}))
