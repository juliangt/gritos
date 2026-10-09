import {
  getRelaySockets,
  joinRoom as trysteroJoinRoom,
  selfId as trysteroSelfId,
  type JoinRoomConfig,
  type MessageAction,
  type Room as TrysteroRoom,
} from '@trystero-p2p/torrent'
import { resolveTrysteroAppId } from './appId'
import { deriveRoomId } from '../crypto/hashes'
import type { DmTransport } from './dmTransport'
import { deriveDmSessionKey } from './dmTransport'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type Message,
  type Peer,
  type RoomStatus,
  type Settings,
} from '../../stores/useAppStore'
import { DEFAULT_SETTINGS, getMutedNickname, useSettingsStore } from '../../stores/useSettingsStore'
import { createEnvelope, DM_PROTOCOL_VERSION, PROTOCOL_VERSION } from './protocol'
import {
  BoundedSeenIds,
  MAX_HISTORY_REQUEST,
  MAX_PLAINTEXT_LENGTH,
  MAX_REACT_BATCH,
  REACT_EMOJIS,
  chunkHistBatches,
  filterDmForSelf,
  isOversized,
  isWithinFutureSkew,
  markSeen,
  parseEnvelope,
  parseHistBatch,
  parseHistReq,
  parseReact,
  reactSeenKey,
  shouldProcess,
  validateReceipt,
  MAX_RECEIPT_BATCH,
  type Envelope,
  type HistPayload,
  type HistReqPayload,
  type PingPayload,
  type PongPayload,
  type PresencePayload,
  type ReactEmoji,
  type ReactPayload,
  type ReceiptPayload,
  type TypingPayload,
} from './protocol'
import {
  computeFingerprint,
  createSessionIdentity,
  loadIdentity,
  persistIdentity,
  regenerateIdentity,
  restoreSessionIdentity,
  type PersistedIdentity,
  type SessionIdentity,
} from '../crypto/identity'
import {
  ensureEphemeralSession,
  setEphemeralSession,
  type EphemeralSession,
} from '../crypto/sessionEphemeral'
import { isValidNickname, sanitizeRemoteNick } from '../nickname'
import {
  canonicalFingerprint,
  clearDmKeyCache,
  decryptDm,
  encryptDm,
  getCachedDmKeyV2,
} from '../crypto/dm'
import { mentionsNickname } from '../markdown/parse'
import { decryptRoomMessage, deriveRoomKey, encryptRoomMessage } from '../crypto/roomKey'
import { ENCRYPTED_MESSAGE_PLACEHOLDER } from '../rooms'
import { dropRecentRoom, pushRecentRoom, removeRecentRoom, saveRecentRooms } from '../recentRooms'
import { getTofuFingerprint, pinMatchesFingerprint, pinTofuFingerprint } from '../tofu'
import { joinSystemLine, leaveSystemLine, muteSystemLine, unmuteSystemLine } from '../feed'
import {
  abortActiveTransfersWithPeer,
  abortAllOnIdentityRegeneration,
  handleFileAbort,
  handleFileAck,
  handleFileChunk,
  handleFileEnd,
  handleFileMeta,
  onPeerGone,
  registerFileHost,
  resetFileTransfersForTests,
  roomTornDown,
  sendFileTransfer,
  type FileAbortPayload,
  type FileAckPayload,
  type FileEndPayload,
  type FileMeta,
  type FileTransferHost,
  type SendFileOutcome,
} from './fileTransfer'

/**
 * The single Trystero surface of the app (plan.md §3 architecture rules:
 * only this module may import trystero). Multi-room core — spec §6.3/§6.5:
 * a Map<roomId, RoomConnection>; each connection encapsulates its Trystero
 * room, its 17 registered actions (§7.1) and its status heuristic, and feeds
 * the Zustand store (§8.1).
 *
 * M3 adds the E2EE DM path (RF-04, §9.2): received raw public keys are kept
 * per peer (with their crypto-trusted fingerprints), `sendDm` derives the
 * shared key (ECDH → HKDF, cached in memory per session), encrypts with
 * AES-GCM and broadcasts a `dm` Envelope addressed with `to`; the receive
 * path filters non-recipients (§7.3), decrypts with the sender's key and
 * feeds the `dms` store channels, including unread, receipts, typing and
 * the `available` flag recomputed on every peer/room change. Incoming DMs
 * are surfaced to the notifications layer through the `onDmReceived` seam.
 *
 * M4 adds password rooms (RF-05, §9.3): joining with a password derives the
 * roomId (§9.4, the room becomes undiscoverable without it) and starts the
 * PBKDF2 room key, held in session memory only. Outgoing `chat` envelopes
 * are sealed `{enc: true, iv, body: base64(IV ‖ ct)}` (order-preserving
 * chain); incoming ones are opened with the room key, or stored as the
 * "🔒 mensaje cifrado" placeholder when they cannot be opened — never as
 * raw ciphertext. Typing, receipts and presence stay plaintext. Leaving
 * discards the key; a reload re-derives it from the re-entered password.
 *
 * Issue #22 enforces TOFU on the `keys` path: the first fingerprint seen
 * per peer is pinned under `gritos:tofu` (lib/tofu); a later, different
 * one keeps the pin as the displayed identity and flags the DM channel
 * (`keyChanged`) instead of silently rotating the shown fingerprint. The
 * live key still feeds the DM crypto so conversations keep working.
 *
 * Issue #93 (spec §12.1) — DM forward secrecy on the wire: every connection
 * also registers the directed `ephkeys` action announcing the
 * session-ephemeral ECDH P-256 public key (lib/crypto/sessionEphemeral,
 * memory-only). Received ephemeral keys land in per-connection maps for the
 * v2 DM derivation; their fingerprints are never TOFU-pinned and never
 * displayed — the long-lived identity key stays the TOFU anchor. The DM
 * send/receive flow runs v2: envelopes carry `v: DM_PROTOCOL_VERSION` and
 * keys derive over the ephemeral pairs with BOTH fingerprint pairs in the
 * HKDF salt. A connected peer that never announces `ephkeys` (a v1 build)
 * gets an explicit legacy state — `sendDm` refuses and the channel flags
 * `legacyPeer` — instead of the silent message loss of §12.1's mixed-room
 * degradation.
 *
 * Issue #95 — local moderation: the mute list (`gritos:settings`
 * .mutedFingerprints, keyed by identity fingerprint) gates the receive
 * paths. A muted author's room chat drops before the store append, the
 * mention seam and the receipt queue; directed dms are ignored before any
 * decrypt work (no channel opens); typing flags and join/leave system
 * lines never surface. Receipts and ping/pong still process — they keep
 * the transport honest (✓✓ and latency dots). Content gates resolve the
 * peerId → fingerprint on the keys-derived map and an envelope arriving
 * before that fingerprint is known fails open (see `isMuted`); the
 * join/leave line gate additionally consults the announced `presence` fp
 * (see `mutedFingerprint`).
 *
 * Issue #98 — emoji reactions: one more action, `react` (spec §7.1), same
 * cosmetic control-plane class as receipts and typing (spec §9.5). Phase 1
 * wires the protocol only: broadcast by default (every peer maintains
 * counts), directed via the optional `to` field for DM reactions (they ride
 * the room swarm targeted at the peer so they never leak to the room).
 * Receive path: mute gate → `parseReact` (whitelist/caps) → foreign-`to`
 * drop → per-peer rate cap (REACT_RATE_CAP/min) → payload dedup through the
 * connection's BoundedSeenIds → delivery through the `onReact` seam. Phase 2
 * subscribes to that seam to maintain state (dropping unknown message ids
 * there, silently); nothing persists and nothing notifies, ever.
 *
 * Issue #102 — opt-in history gossip, phase 1 (protocol): two more actions,
 * `hist-req {n}` (a peer asks for the last n ≤ 50 messages) and
 * `hist {batch}` (replayed chat envelopes, ≤ 20 per batch, sender-chunked
 * by encoded size under the 64 KB payload cap via `chunkHistBatches`).
 * Receive path of both: mute gate (a muted sharer drops before any parse,
 * the same pre-process gate as every action) → pure validation
 * (`parseHistReq`/`parseHistBatch`) → per-peer rolling rate caps (1
 * hist-req/min, 6 hist batches/min) → for `hist` per envelope: the
 * future-skew bound (the ONE freshness check the replay path keeps — the
 * MAX_ENVELOPE_AGE_MS age window is BYPASSED, the whole point of gossip)
 * and the connection's BoundedSeenIds dedup (replay flood prevention that
 * also makes a later LIVE resend of the same id dedup). Survivors are
 * delivered through the `onHistRequest`/`onRecovered` seams ONLY — no store
 * append at the transport level, no unread, no mention, no receipt, no
 * typing (✓✓ means live delivery). Phase 2 wired the CONSENT side at module
 * level (`respondToHistoryRequest`): a delivered hist-req is honored ONLY
 * while `gritos:settings`.shareHistory is on (default silence), with at
 * most the last `n` chat rows of the in-memory feed — never system lines,
 * encrypted placeholders or already-expired rows. Phase 3 wires the
 * recovered-state append at module level (`appendRecoveredToStore`: the
 * 50-per-join recipient cap, the muted-AUTHOR gate, receiver-clock TTL and
 * the `recovered: true` rows under the "messages recovered from peers" separator)
 * plus the request side the UI card drives (`requestHistory`, the
 * per-room HISTORY_ASK_RATE_CAP budget with the §10.3 park-while-searching
 * flush).
 *
 * Issue #103 (spec §12.4) — P2P file transfer, phase 3 (engine): five more
 * actions, registered in §12.4's reading order after `hist` and before
 * `ping`/`pong` (`file-meta` → binary `file-chunk` → `file-ack` →
 * `file-end` → `file-abort`). This module stays the thin shim: it drops
 * muted senders BEFORE any parse (all five actions are content, issue #95),
 * hands each handler a `FileTransferHost` (room id, live room key, mute
 * gate, `resolveTransferKey`, directed sends) and delegates the whole
 * machine — validation, credit window, framing, caps, state, blob
 * assembly — to `lib/p2p/fileTransfer.ts`. Lifecycle hooks: peer leaves
 * and connection teardowns fail that room's transfers (no resume, §12.4),
 * a fresh mute aborts the muted peer's active transfers (with
 * `file-abort`), identity regeneration invalidates every transfer (the
 * §12.2 seam, wired at module load like the react/history subscriptions),
 * and the panic path calls the engine's abortAll directly (lib/panic.ts).
 *
 * Testability: the Trystero `joinRoom` function sits behind an injectable
 * factory (`setJoinRoomFactory`) so tests drive the manager with a fake.
 */

/** RF-02 — normalized names: 1–32 chars of [a-z0-9_-]. */
export const ROOM_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

/**
 * §10.3 heuristic — no CONNECTION to any tracker within 15 s → 'error'
 * (issue #125: a peerless room with an open relay socket stays 'searching'
 * and the check re-arms; peer activity still disarms instantly).
 */
export const ERROR_HEURISTIC_MS = 15_000

/** RF-03 — a typing signal expires after 4 s. */
export const TYPING_TTL_MS = 4_000

/** §7.1 — receiver receipts are batched with this debounce before sending. */
export const RECEIPT_DEBOUNCE_MS = 300

/**
 * Issue #36 — a peer may trigger at most this many join/leave system feed
 * lines per rolling SYSTEM_LINE_RATE_WINDOW_MS. Presence and peer churn are
 * forgeable in the trustless mesh (spec §9.5), so without a cap repeated
 * rejoins (or forged announcements) could spam the feed and evict real
 * history through the 500-message FIFO. Only lines beyond the cap are
 * dropped: the first announcements of a peer always go through.
 */
export const SYSTEM_LINE_RATE_CAP = 3

/** Rolling window over which SYSTEM_LINE_RATE_CAP applies. */
export const SYSTEM_LINE_RATE_WINDOW_MS = 60_000

/**
 * Issue #98 — reactions are cosmetic control-plane traffic (spec §9.5), so a
 * peer may deliver at most this many `react` payloads per peer per rolling
 * REACT_RATE_WINDOW_MS; excess is dropped before any state can churn (the
 * same posture as SYSTEM_LINE_RATE_CAP for join/leave lines: the mesh is
 * trustless, so receive-path caps are the only flood defense).
 */
export const REACT_RATE_CAP = 30

/** Rolling window over which REACT_RATE_CAP applies. */
export const REACT_RATE_WINDOW_MS = 60_000

/**
 * Issue #102 — history-gossip receive-path rate caps (per peer, rolling
 * windows, the same trustless-mesh posture as REACT_RATE_CAP). A peer may
 * ask at most HISTORY_REQ_RATE_CAP times per rolling
 * HISTORY_REQ_RATE_WINDOW_MS via `hist-req` (one explicit ask per minute;
 * the phase-3 request UX rate-limits its own side too), and may deliver at
 * most HISTORY_RATE_CAP `hist` batches per rolling HISTORY_RATE_WINDOW_MS —
 * with the MAX_HISTORY_BATCH count cap that bounds gossip ingestion at
 * 6 × 20 = 120 messages/min/peer.
 */
export const HISTORY_REQ_RATE_CAP = 1
export const HISTORY_REQ_RATE_WINDOW_MS = 60_000
export const HISTORY_RATE_CAP = 6
export const HISTORY_RATE_WINDOW_MS = 60_000

/**
 * Issue #102 phase 3 — the REQUEST side's own politeness cap (per room
 * connection, rolling window): this tab may dispatch at most one `hist-req`
 * per room per minute through `requestHistory`, whether it sent live or
 * parked it while the room was still hunting for peers (§10.3). It bounds
 * the card flow ("repeated asks rate-limited") on top of the receivers'
 * per-peer HISTORY_REQ_RATE_CAP — a rejoin gets a fresh connection and thus
 * a fresh local budget, but every receiving peer still caps the wire rate.
 */
export const HISTORY_ASK_RATE_CAP = 1
export const HISTORY_ASK_RATE_WINDOW_MS = 60_000

/**
 * Issue #102 phase 3 — the RECIPIENT-side recovery cap: at most this many
 * recovered messages are appended per join session per room (a counter on
 * the connection, freed with it). Excess envelopes of later batches are
 * dropped silently — gossip must not be able to stuff a feed beyond what a
 * live session could have held, and the sharer's own slice is already
 * bounded by the same 50-message figure (MAX_HISTORY_REQUEST).
 */
export const MAX_RECOVERED_PER_JOIN = MAX_HISTORY_REQUEST

/**
 * Issue #20 — the §10.3 local chat queue (envelopes typed while the room has
 * no DataChannel) holds at most this many envelopes; the oldest is dropped.
 */
export const PENDING_CHATS_CAP = 100

/** Uncompressed ECDH P-256 public key: 0x04 ‖ X ‖ Y = 65 bytes (§9.1). */
export const RAW_PUBLIC_KEY_LENGTH = 65

/** Trystero joinRoom signature — the injection seam used by the tests. */
export type TrysteroJoinRoom = typeof trysteroJoinRoom

/**
 * Issue #125 — the live relay (tracker) sockets Trystero holds, keyed by
 * relay URL. Structural on purpose: the heuristic only reads `readyState`
 * and the DOM `WebSocket` type does not exist in the node test environment
 * (mirrors how `TrysteroJoinRoom` keeps the module's single Trystero
 * surface injectable).
 */
export type RelaySockets = Record<string, { readonly readyState: number }>

/** Returns Trystero's current url → relay socket record (`getRelaySockets`). */
export type RelaySocketsProvider = () => RelaySockets

/** RF-02 — exceeding settings.maxActiveRooms rejects with this typed error. */
export class RoomLimitError extends Error {
  readonly maxRooms: number

  constructor(maxRooms: number) {
    super(`Active room limit reached (${maxRooms})`)
    this.name = 'RoomLimitError'
    this.maxRooms = maxRooms
  }
}

/** RF-02 — invalid room names reject before any network call. */
export class RoomNameError extends Error {
  constructor(rawName: string) {
    super(`Invalid room name: "${rawName}"`)
    this.name = 'RoomNameError'
  }
}

/** RF-01 — invalid nicknames reject before any state/presence change. */
export class NicknameError extends Error {
  constructor(rawNickname: string) {
    super(`Invalid nickname: "${rawNickname}"`)
    this.name = 'NicknameError'
  }
}

/** RF-02 normalization: trim + lowercase + whitespace runs → '-'. */
export function normalizeRoomName(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, '-')
  return ROOM_NAME_PATTERN.test(normalized) ? normalized : null
}

/** Public, immutable view of a live connection (what the UI may hold). */
export interface RoomConnection {
  readonly roomId: string
  readonly name: string
  readonly hasPassword: boolean
  status: RoomStatus
}

interface RoomActions {
  presence: MessageAction<PresencePayload>
  /** Trystero delivers binary as ArrayBuffer; we always send Uint8Array. */
  keys: MessageAction<Uint8Array | ArrayBuffer>
  /**
   * Issue #93 (spec §12.1) — session-ephemeral ECDH public key announce,
   * directed like `keys`. Same binary discipline; never TOFU-pinned.
   */
  ephkeys: MessageAction<Uint8Array | ArrayBuffer>
  chat: MessageAction<Envelope>
  dm: MessageAction<Envelope>
  typing: MessageAction<TypingPayload>
  receipt: MessageAction<ReceiptPayload>
  /** Issue #98 — emoji reactions; broadcast, or directed via payload.to. */
  react: MessageAction<ReactPayload>
  /** Issue #102 — history gossip: the request {n ≤ 50} and the batches. */
  'hist-req': MessageAction<HistReqPayload>
  hist: MessageAction<HistPayload>
  /**
   * Issue #103 (spec §12.4) — the five file-transfer actions, in §12.4's
   * registration/reading order (offer, data, credit, close, cancel).
   * `file-chunk` is the binary one (framed `8 B fileId ‖ uint32 BE seq ‖
   * payload`); the rest are tiny JSON payloads.
   */
  'file-meta': MessageAction<FileMeta>
  /** Trystero delivers binary as ArrayBuffer; we always send Uint8Array. */
  'file-chunk': MessageAction<Uint8Array | ArrayBuffer>
  'file-ack': MessageAction<FileAckPayload>
  'file-end': MessageAction<FileEndPayload>
  'file-abort': MessageAction<FileAbortPayload>
  ping: MessageAction<PingPayload>
  pong: MessageAction<PongPayload>
}

interface RoomInternals extends RoomConnection {
  readonly password?: string
  /**
   * M4 (§9.3) — derived AES-GCM room key for password rooms, held as a
   * session-memory promise only: never persisted, never in the store.
   * null for public rooms.
   */
  roomKey: Promise<CryptoKey> | null
  /**
   * M4 — serializes the async per-message sealing so encrypted envelopes
   * reach the wire (or the pending queue) in send order.
   */
  sendChain: Promise<void>
  readonly trystero: TrysteroRoom
  readonly actions: RoomActions
  /**
   * Per-room dedup window — spec §7.3. Issue #20: bounded with FIFO
   * eviction at SEEN_IDS_CAP entries, so a flood of unique envelope ids
   * cannot grow it without bound.
   */
  readonly seenIds: BoundedSeenIds
  /** Raw ECDH public keys per peer, in memory only (§7.1). */
  readonly peerKeys: Map<string, Uint8Array>
  /** Fingerprints derived from the received keys — the crypto-trusted ones. */
  readonly peerKeyFps: Map<string, string>
  /**
   * Issue #93 (spec §12.1) — session-ephemeral ECDH public keys per peer
   * (the `ephkeys` announce), in memory only. The DM v2 derivation ECDHs
   * over these instead of the long-lived identity keys.
   */
  readonly peerEphKeys: Map<string, Uint8Array>
  /**
   * Issue #93 — fingerprints derived from the received ephemeral keys.
   * NEVER pinned (`gritos:tofu` keeps pinning the identity key, the TOFU
   * anchor) and never displayed: the ephemeral key changes every session.
   */
  readonly peerEphFps: Map<string, string>
  /** Peers whose presence was already announced in the feed (join lines). */
  readonly announcedPeers: Set<string>
  /**
   * Issue #36 — timestamps of the join/leave system lines already emitted
   * per peer (each queue holds at most SYSTEM_LINE_RATE_CAP entries),
   * gating feed-line floods over the rolling window. Kept across peer
   * leaves — clearing it there would let rejoin churn reset the cap — and
   * freed with the connection itself (memory-only, like every queue here).
   */
  readonly systemLineTimes: Map<string, number[]>
  /**
   * Issue #98 — timestamps of the react payloads already accepted per peer
   * (each queue holds at most REACT_RATE_CAP entries) gating the cosmetic-
   * class flood over the rolling window. Kept across peer leaves — like
   * systemLineTimes, clearing on leave would let rejoin churn reset the cap
   * — and freed with the connection itself (memory-only).
   */
  readonly reactTimes: Map<string, number[]>
  /**
   * Issue #102 — timestamps of the `hist-req` / `hist` payloads already
   * accepted per peer (each queue holds at most HISTORY_*_RATE_CAP entries),
   * the same rolling-window discipline as reactTimes: kept across peer
   * leaves — clearing on leave would let rejoin churn reset the cap — and
   * freed with the connection (memory-only).
   */
  readonly histReqTimes: Map<string, number[]>
  readonly histTimes: Map<string, number[]>
  /**
   * Issue #102 phase 3 — timestamps of this tab's own `hist-req` sends via
   * `requestHistory` (keyed by the own peerId, reusing the rolling-budget
   * helper), the HISTORY_ASK_RATE_CAP politeness cap of the card flow. Kept
   * on the connection like every budget here: a rejoin starts a fresh one
   * (the receivers' caps are the durable defense).
   */
  readonly historyAskTimes: Map<string, number[]>
  /**
   * Issue #102 phase 3 — a history request tapped while the room had no
   * DataChannel yet (§10.3): parked fire-and-forget like sendChat's
   * pendingChats and flushed on the first peer join. At most one (the last
   * tap wins — the ask budget already bounds repeats); dies with the
   * connection.
   */
  pendingHistReq: HistReqPayload | null
  /**
   * Issue #102 phase 3 — recovered rows accepted so far in THIS join
   * session, the MAX_RECOVERED_PER_JOIN recipient cap. Freed with the
   * connection: a leave/rejoin starts a fresh budget.
   */
  recoveredAccepted: number
  /**
   * Issue #102 phase 3 — serializes the async recovered-append tails
   * (password-room decryption) so batches append in wire order even when
   * their decrypt promises settle out of order (the sendChain discipline,
   * receive direction).
   */
  recoveredChain: Promise<void>
  /**
   * Chat envelopes awaiting the first DataChannel (§10.3 local queue).
   * Issue #20 — capped at PENDING_CHATS_CAP, oldest dropped on overflow:
   * a room that never reaches `connected` cannot grow it without bound
   * (only the user's typing rate bounded it before).
   */
  pendingChats: Envelope[]
  /**
   * Receipt ids per author peerId, flushed debounced in ≤50 batches.
   * Issue #20 audit: bounded without a cap — every entry lives at most one
   * RECEIPT_DEBOUNCE_MS window (flushReceipts deletes each key after the
   * debounced send, even for a peer that already left: safeSend swallows
   * the dead-channel error), keys only exist for known author peers, and
   * teardownConnection clears the whole map.
   */
  readonly pendingReceipts: Map<string, string[]>
  receiptTimer: ReturnType<typeof setTimeout> | null
  errorTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
}

// ---------------------------------------------------------------------------
// Module state + seams
// ---------------------------------------------------------------------------

const connections = new Map<string, RoomInternals>()

/**
 * Issue #19 — session-wide DM dedup set, shared by every room connection
 * and surviving connection churn (leave/rejoin, reconnectAll): a replayed
 * DM envelope that is still within the freshness window must be dropped
 * even when it arrives through a different room or a fresh DataChannel
 * whose per-connection dedup set is empty. Issue #20 — bounded with FIFO
 * eviction at SEEN_IDS_CAP entries: a flood shrinks the dedup window but
 * never exhausts memory. Like every dedup window it is memory-only and
 * resets on reload (the freshness window bounds what a reset can resurface).
 */
const seenDmIds = new BoundedSeenIds()

/**
 * Issue #96 — ids of TTL messages this session has already expired (fed by
 * the sweep). Bounded with the same FIFO-eviction cap as the dedup windows:
 * an id only leaves after SEEN_IDS_CAP other messages were appended AND
 * expired after it — strictly harder than evicting it from any dedup window
 * — so while it sits here a replay of its envelope (dedup entry long
 * evicted, e.g. after a reconnect churn) is dropped before any append:
 * expired messages never resurrect. Memory-only, like every queue here.
 */
const expiredMessageIds = new BoundedSeenIds()

let joinRoomImpl: TrysteroJoinRoom = trysteroJoinRoom

/**
 * Dependency-injection seam: replaces the Trystero joinRoom function so
 * tests (and only tests) drive the manager with a fake. null restores the
 * real implementation.
 */
export function setJoinRoomFactory(factory: TrysteroJoinRoom | null): void {
  joinRoomImpl = factory ?? trysteroJoinRoom
}

/**
 * Issue #125 — the live relay sockets behind the §10.3 heuristic. Like the
 * joinRoom factory above, it sits behind an injectable provider so tests
 * (and only tests) decide which tracker sockets are open. null restores the
 * real implementation.
 */
let relaySocketsImpl: RelaySocketsProvider = getRelaySockets as RelaySocketsProvider

export function setRelaySocketsProvider(provider: RelaySocketsProvider | null): void {
  relaySocketsImpl = provider ?? (getRelaySockets as RelaySocketsProvider)
}

/**
 * §10.3 reachability check (issue #125): true iff at least one relay socket
 * is OPEN (readyState === 1). An empty or missing record counts as NOT
 * reachable — the conservative default that preserves today's behavior when
 * no socket was ever opened.
 */
export function trackersReachable(): boolean {
  const sockets = relaySocketsImpl() ?? {}
  return Object.values(sockets).some((socket) => socket.readyState === 1)
}

/**
 * Trystero room handle of an auxiliary swarm — re-exported so the signal
 * manager (issue #105) never imports trystero itself (plan §3: this module
 * is the app's single Trystero surface).
 */
export type AuxiliarySwarmRoom = TrysteroRoom

/**
 * §9.4 Trystero config shared by every swarm join: appId always (issue #90,
 * resolved per join so a missing variable surfaces as a join error, never a
 * broken import); custom trackers/ICE replace the defaults only when the
 * user configured them (RF-07).
 */
function buildSwarmConfig(settings: Settings): JoinRoomConfig {
  const config: JoinRoomConfig = { appId: resolveTrysteroAppId() }
  if (settings.trackers.length > 0) {
    config.relayConfig = { urls: [...settings.trackers] }
  }
  if (settings.iceServers.length > 0) {
    config.rtcConfig = { iceServers: settings.iceServers.map((server) => ({ ...server })) }
  }
  return config
}

/**
 * Issue #105 (spec §12.5) — joins an AUXILIARY swarm (the well-known signal
 * channel) through the SAME injectable factory and the SAME config (appId,
 * trackers, ICE) the rooms use, so tests drive both swarms with one fake
 * and the signal swarm inherits the app's network settings. The signal
 * manager owns everything else about that swarm (actions, presence,
 * teardown) — this is only the join seam.
 */
export function joinAuxiliarySwarm(roomId: string): AuxiliarySwarmRoom {
  const settings = useSettingsStore.getState().settings
  return joinRoomImpl(buildSwarmConfig(settings), roomId)
}

/** The local Trystero peerId (stable per browser session). */
export function getSelfPeerId(): string {
  return trysteroSelfId
}

let sessionIdentity: SessionIdentity | null = null
let identityPromise: Promise<SessionIdentity> | null = null

/**
 * Lazily creates or restores the session identity. Idempotent — StrictMode
 * double-mounts and concurrent callers share the same identity. M3 (§8.2 +
 * §9.1): when a persisted identity exists (store or `gritos:identity`), its
 * JWK keypair is re-imported so the announced fingerprint always matches
 * the ECDH material; pre-M3 profile-only records are migrated with a fresh
 * keypair (nickname preserved). Only visitors with no identity at all get
 * an anonymous ephemeral one.
 */
export function ensureSessionIdentity(nickname?: string): Promise<SessionIdentity> {
  if (sessionIdentity !== null) return Promise.resolve(sessionIdentity)
  if (identityPromise === null) {
    identityPromise = (async () => {
      const stored = useAppStore.getState().identity
      const persisted = stored !== null ? persistedFromStoreProfile(stored) : loadIdentity()
      if (persisted !== null) {
        const { session } = await restoreSessionIdentity(persisted)
        sessionIdentity = session
        useAppStore.getState().setIdentity(session.identity)
        return sessionIdentity
      }
      const nick =
        nickname !== undefined && nickname.trim() !== '' ? nickname.trim() : generateEphemeralNick()
      const created = await createSessionIdentity(nick)
      sessionIdentity = created
      useAppStore.getState().setIdentity(created.identity)
      return sessionIdentity
    })()
  }
  return identityPromise
}

/**
 * Merges the store's display profile with the key material persisted under
 * `gritos:identity` (public JWK + wrapped envelope, issue #24): the store
 * is authoritative for the profile, storage for the keys. A missing record
 * yields a profile-only identity, which the restore path migrates exactly
 * as before.
 */
function persistedFromStoreProfile(stored: {
  nickname: string
  fingerprint: string
  createdAt: number
}): PersistedIdentity {
  const persisted = loadIdentity()
  return {
    nickname: stored.nickname,
    fingerprint: stored.fingerprint,
    createdAt: stored.createdAt,
    pubJwk: persisted?.pubJwk,
    priv: persisted?.priv,
    legacyPrivJwk: persisted?.legacyPrivJwk,
  }
}

/**
 * Installs a session identity created elsewhere (the onboarding screen
 * creates one to persist its fingerprint). First writer wins: later calls
 * no-op, keeping a single keypair per session.
 */
export function adoptSessionIdentity(session: SessionIdentity): void {
  if (sessionIdentity !== null) return
  sessionIdentity = session
  identityPromise = Promise.resolve(session)
  useAppStore.getState().setIdentity(session.identity)
}

/** Current session identity, or null before ensureSessionIdentity resolves. */
export function getSessionIdentity(): SessionIdentity | null {
  return sessionIdentity
}

// ---------------------------------------------------------------------------
// Identity-regeneration listeners (issue #97: the manual-DM path subscribes)
// ---------------------------------------------------------------------------

export type IdentityRegeneratedListener = () => void

const identityRegeneratedListeners = new Set<IdentityRegeneratedListener>()

/**
 * Subscribes to RF-07 identity regenerations; returns the unsubscribe
 * function. NOT cleared by `resetManagerForTests`: unlike the per-mount
 * listeners below, the manualDmManager self-subscribes at module load —
 * this seam is its wiring, not disposable listener state.
 */
export function onSessionIdentityRegenerated(listener: IdentityRegeneratedListener): () => void {
  identityRegeneratedListeners.add(listener)
  return () => {
    identityRegeneratedListeners.delete(listener)
  }
}

/** Fires the regeneration seam for every listener (gating lives with them). */
function fireIdentityRegenerated(): void {
  for (const listener of identityRegeneratedListeners) {
    listener()
  }
}

/**
 * Issue #105 (spec §12.5) — post-regeneration material rebroadcast seam.
 * Fires AFTER `regenerateSessionIdentity` has produced the new identity AND
 * the fresh session-ephemeral keypair (the regeneration seam above fires
 * BEFORE both — the manual path uses that to invalidate, but a re-announce
 * needs the FINAL material, not material that `setEphemeralSession(null)`
 * would strand). The signal manager subscribes at module load to re-announce
 * whoami + keys + ephkeys over its swarm, exactly like the room loop below.
 * Wiring, not disposable state: never cleared by resetManagerForTests.
 */
export type IdentityRebroadcastListener = (
  session: SessionIdentity,
  ephemeral: EphemeralSession,
) => void

const identityRebroadcastListeners = new Set<IdentityRebroadcastListener>()

export function onIdentityMaterialRebroadcast(listener: IdentityRebroadcastListener): () => void {
  identityRebroadcastListeners.add(listener)
  return () => {
    identityRebroadcastListeners.delete(listener)
  }
}

/**
 * RF-07 (M5) — regenerates the cryptographic identity: a new ECDH keypair
 * is created and persisted under `gritos:identity` (same nickname), the DM
 * key cache is dropped (old keys no longer match), the store is updated and
 * presence + keys are re-announced to every peer of every active room.
 * Issue #93 (spec §12.1) — the session-ephemeral keypair is reset and a
 * fresh one is generated and re-announced (`ephkeys`) to the same peers.
 * Issue #97 (spec §12.2) — the manual-DM path listens on this seam: its
 * pending flows and live channels are invalidated (their keys announced the
 * OLD identity) by the subscription installed in manualDmManager.
 * Returns the new session, or null when there was no session identity yet.
 */
export async function regenerateSessionIdentity(): Promise<SessionIdentity | null> {
  const current = sessionIdentity
  if (current === null) return null
  const nickname = current.identity.nickname
  const session = await regenerateIdentity(nickname)
  sessionIdentity = session
  identityPromise = Promise.resolve(session)
  clearDmKeyCache()
  // The old key material is dead from here: the manual engines hold the
  // OLD identity + ephemeral keys, so the seam fires before anything can
  // announce or use them again.
  fireIdentityRegenerated()
  useAppStore.getState().setIdentity(session.identity)
  broadcastPresence()
  // Issue #93 (spec §12.1) — hygiene: a new identity gets fresh session
  // material too. The old ephemeral key never outlives the identity that
  // announced it (the v2 DM key cache is already dropped via
  // clearDmKeyCache above). One awaited ensureEphemeralSession BEFORE the
  // loop: every peer receives the SAME fresh key, and concurrent
  // generations cannot race (unlike per-peer lazy calls).
  setEphemeralSession(null)
  const ephemeral = await ensureEphemeralSession()
  // The `keys` action carries the new public key to every peer we know of;
  // `ephkeys` re-announces the fresh session-ephemeral key to the same set.
  for (const connection of connections.values()) {
    for (const peerId of connection.peerKeys.keys()) {
      safeSend(connection.actions.keys, session.rawPublicKey, { target: peerId })
      safeSend(connection.actions.ephkeys, ephemeral.rawPublicKey, { target: peerId })
    }
  }
  // Issue #105 — auxiliary swarms (the signal channel) re-announce the same
  // FINAL material to their own peers through this seam.
  for (const listener of identityRebroadcastListeners) {
    listener(session, ephemeral)
  }
  return session
}

function generateEphemeralNick(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]
  return `par-${(random % 0xffff).toString(16).padStart(4, '0')}`
}

/**
 * Re-persists the §8.2 identity record with a new nickname, keeping the
 * keypair material untouched (M5: nickname changes survive reloads). The
 * wrapped envelope is stored verbatim (no re-wrapping, sync write); a
 * pre-#24 plaintext record is wrapped in the same stroke. The write is
 * fire-and-forget: nothing reads the record back in this call path.
 */
function repersistNickname(nickname: string): void {
  const persisted = loadIdentity()
  if (persisted !== null) {
    void persistIdentity({
      nickname,
      fingerprint: persisted.fingerprint,
      createdAt: persisted.createdAt,
      pubJwk: persisted.pubJwk,
      priv: persisted.priv,
      privJwk: persisted.legacyPrivJwk,
    })
  }
}

/**
 * RF-01 — nickname changes are announced to every peer of every room.
 * Issue #28 — the manager validates with the same local RF-01 rules the UI
 * applies (isValidNickname), so every path — including the debug panel —
 * produces spec-valid presence. Invalid input throws NicknameError (the
 * joinRoom/RoomNameError style) before any state or presence change.
 */
export function setNickname(nickname: string): void {
  const nick = nickname.trim()
  if (!isValidNickname(nick)) {
    throw new NicknameError(nickname)
  }
  if (sessionIdentity === null) {
    void ensureSessionIdentity(nick)
    return
  }
  if (sessionIdentity.identity.nickname === nick) return
  sessionIdentity = {
    ...sessionIdentity,
    identity: { ...sessionIdentity.identity, nickname: nick },
  }
  useAppStore.getState().setIdentity(sessionIdentity.identity)
  repersistNickname(nick)
  broadcastPresence()
}

/** §7.1 — announces {nick, fp} to every peer of every active room. */
export function broadcastPresence(): void {
  const identity = sessionIdentity
  if (identity === null) return
  const payload: PresencePayload = {
    nick: identity.identity.nickname,
    fp: identity.identity.fingerprint,
  }
  for (const connection of connections.values()) {
    safeSend(connection.actions.presence, payload)
  }
}

// ---------------------------------------------------------------------------
// Pong routing (useLatency subscribes; the engine computes RTT)
// ---------------------------------------------------------------------------

export type PongListener = (roomId: string, peerId: string, t: number) => void

const pongListeners = new Set<PongListener>()

/** Subscribes to pong events; returns the unsubscribe function. */
export function onPong(listener: PongListener): () => void {
  pongListeners.add(listener)
  return () => {
    pongListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// React routing (issue #98, phase 1 seam — phase 2 state subscribes here)
// ---------------------------------------------------------------------------

/**
 * Validated, rate-capped and dedup'd inbound reaction. `roomId` is the swarm
 * it rode in on; `payload.to === undefined` is a room-wide broadcast, a set
 * `to` a DM reaction addressed to THIS peer. Phase 2 owns the state policy
 * (including dropping ids of unknown/evicted messages — silently, cosmetic
 * class); phase 1 only gates and delivers.
 */
export type ReactListener = (roomId: string, peerId: string, payload: ReactPayload) => void

const reactListeners = new Set<ReactListener>()

/** Subscribes to validated inbound reactions; returns the unsubscribe function. */
export function onReact(listener: ReactListener): () => void {
  reactListeners.add(listener)
  return () => {
    reactListeners.delete(listener)
  }
}

/**
 * Issue #98 phase 2 — the store-side policy for one validated inbound
 * reaction: broadcast payloads mutate ONLY the room slice, directed ones
 * ONLY the DM slice. The channel key is the SENDER's peerId (dms[peerId],
 * the same key appendDmMessage/markDmMessagesDelivered use) — `payload.to`
 * is this peer (the phase-1 gate guaranteed it) and carries no routing
 * beyond "this is a DM reaction". Unknown or FIFO/TTL-evicted message ids
 * drop silently inside the store action (cosmetic class).
 */
function applyInboundReactionToStore(roomId: string, peerId: string, payload: ReactPayload): void {
  const store = useAppStore.getState()
  if (payload.to !== undefined) {
    store.applyDmMessageReactions(peerId, payload.ids, payload.emo, peerId, payload.on)
  } else {
    store.applyMessageReactions(roomId, payload.ids, payload.emo, peerId, payload.on)
  }
}

/**
 * Issue #98 phase 2 — the seam→store wiring, subscribed at module load like
 * manualDmManager's identity-regeneration listener: reactions must mutate
 * state whether or not a React tree is mounted. resetManagerForTests clears
 * reactListeners (tests register disposable listeners there) and re-installs
 * THIS subscription — it is wiring, not disposable listener state.
 */
onReact(applyInboundReactionToStore)

// ---------------------------------------------------------------------------
// History gossip (issue #102, phase 1 seams — phases 2/3 subscribe here)
// ---------------------------------------------------------------------------

/**
 * Validated, rate-capped inbound `hist-req`: `peerId` asks for the last `n`
 * chat messages of `roomId` (n integer, 1..50). Phase 1 only gates and
 * delivers; the CONSENT policy — whether to answer at all (default
 * silence), and what slice of the in-memory feed to share — is phase 2,
 * which subscribes here and calls `sendHistory`.
 */
export type HistRequestListener = (roomId: string, peerId: string, n: number) => void

const histRequestListeners = new Set<HistRequestListener>()

/** Subscribes to validated history requests; returns the unsubscribe function. */
export function onHistRequest(listener: HistRequestListener): () => void {
  histRequestListeners.add(listener)
  return () => {
    histRequestListeners.delete(listener)
  }
}

/**
 * Validated replayed chat envelopes for `roomId` — shape-checked by
 * parseEnvelope (the ±90 s future-skew bound kept), the freshness AGE window
 * bypassed, dedup'd against the delivering connection's BoundedSeenIds.
 * Zero transport side effects by contract: the replay path never appends to
 * the store here, never badges, never notifies, never receipts (✓✓ means
 * LIVE delivery), never touches typing. Phases 2/3 own the state wiring —
 * the append under the "recovered" separator, the 50-per-join recipient
 * cap, and dropping envelopes authored by locally-muted third parties at
 * append time (the transport only ever gates the SHARER).
 */
export type RecoveredListener = (roomId: string, envelopes: Envelope[]) => void

const recoveredListeners = new Set<RecoveredListener>()

/** Subscribes to recovered-history deliveries; returns the unsubscribe function. */
export function onRecovered(listener: RecoveredListener): () => void {
  recoveredListeners.add(listener)
  return () => {
    recoveredListeners.delete(listener)
  }
}

/**
 * Issue #102 phase 2 — the shareable slice of one room's in-memory feed,
 * rebuilt as chat envelopes for `sendHistory`. The store keeps Message rows
 * (plaintext, arrival order, oldest → newest), so this maps the LAST
 * `limit` shareable rows back to their wire form:
 *
 * - chat rows only: `kind: 'system'` lines are local feed furniture (join/
 *   leave, moderation lines, cap separators) and are never gossiped — DMs,
 *   by construction, never enter a room feed (they live in the `dms` slice),
 *   and `sendHistory` re-enforces chat-only anyway.
 * - never the encrypted placeholder rows (`encrypted: true`): the store
 *   holds neither their plaintext nor the original ciphertext (issue #21),
 *   so there is nothing honest to forward.
 * - never already-expired rows: the sweep runs on a 1 s tick, so a row
 *   whose `expiresAt` is due can still sit in the feed between ticks.
 *
 * Own messages rebuild with the real local peerId (`authorId === 'self'`
 * is the store's echo convention); received ones with their transport
 * peerId. `ts` is the author timestamp (the ±90 s future-skew bound is the
 * only freshness check the replay path keeps, and live-received rows were
 * already skew-checked on arrival); the body is the stored plaintext —
 * `sendHistory` re-validates and re-seals it for password rooms. TTL rows
 * share as session-lived: the author's original `ttl` seconds are not
 * recoverable from the store (only the absolute receiver-clock `expiresAt`
 * is kept), so nothing is fabricated.
 */
function shareableFeedEnvelopes(roomId: string, limit: number): Envelope[] {
  const feed = useAppStore.getState().rooms[roomId]?.messages ?? []
  const now = Date.now()
  const shareable = feed.filter(
    (message) =>
      message.kind !== 'system' &&
      !message.encrypted &&
      (message.expiresAt === undefined || message.expiresAt > now),
  )
  return shareable.slice(-Math.min(limit, MAX_HISTORY_REQUEST)).map((message) => ({
    v: PROTOCOL_VERSION,
    id: message.id,
    ts: message.ts,
    from: message.authorId === 'self' ? trysteroSelfId : message.authorId,
    nick: message.authorNick,
    kind: 'chat' as const,
    enc: false,
    iv: null,
    body: message.text,
  }))
}

/**
 * Issue #102 phase 2 — the consent policy for one validated `hist-req`,
 * subscribed at module level like the onReact wiring (no UI needed for the
 * loop to work; tests re-install it in resetManagerForTests). The consent
 * flag gates FIRST, so the default — and any mid-session toggle-off — is
 * enforced silence: no `hist` leaves this module for any trigger while
 * `shareHistory` is off. With consent, the requester's `n` bounds the slice
 * (protocol-capped at MAX_HISTORY_REQUEST) and `sendHistory` answers it:
 * fire-and-forget, broadcast room-wide (the phase-1 sender contract; a
 * share that races a disconnect is simply lost and the peer may ask again).
 * The recovered-envelope append wiring is phase 3's (`appendRecoveredToStore`).
 */
function respondToHistoryRequest(roomId: string, _peerId: string, n: number): void {
  if (!useSettingsStore.getState().settings.shareHistory) return
  void sendHistory(roomId, shareableFeedEnvelopes(roomId, n))
}

/**
 * Issue #102 phase 2 — the seam→consent wiring, installed at module load
 * exactly like onReact's: resetManagerForTests clears histRequestListeners
 * (tests register disposable listeners there) and re-installs THIS
 * subscription — it is wiring, not disposable listener state.
 */
onHistRequest(respondToHistoryRequest)

// ---------------------------------------------------------------------------
// History gossip phase 3 (issue #102) — the request UX's transport seam and
// the recovered-state append wiring
// ---------------------------------------------------------------------------

/**
 * Issue #102 phase 3 — the asking side of gossip, the `[Pedir]` button's
 * transport: broadcasts a `hist-req {n ≤ 50}` on `roomId`'s swarm (room
 * scope, no target — every consenting peer may answer). Fire-and-forget
 * with the HISTORY_ASK_RATE_CAP per-room politeness budget (1/min): the
 * card dismisses on tap, so this budget is what rate-limits repeat joins.
 *
 * While the room has no DataChannel yet (`searching`/`error`, §10.3) the
 * payload is PARKED (pendingHistReq) and flushed on the first peer join —
 * the sendChat local-queue discipline: a joiner reading the card right
 * after joining must not lose the ask to a race with the handshake. The
 * budget is consumed when the ask is ACCEPTED (sent or parked), not at
 * flush time, so one tap is one ask however the handshake plays out; the
 * parked payload dies with the connection (leave before any peer joins =
 * the ask is simply lost, the user may ask again next join).
 *
 * Returns whether the ask was accepted (dispatched or parked) — false for
 * an unknown room, an out-of-bounds `n` (parseHistReq is the single gate,
 * and a rejected ask consumes no budget) or an exhausted budget. Never
 * throws.
 */
export function requestHistory(roomId: string, n: number = MAX_HISTORY_REQUEST): boolean {
  const connection = connections.get(roomId)
  if (connection === undefined) return false
  const payload = parseHistReq({ n })
  if (payload === null) return false
  if (
    !consumeRollingBudget(
      connection.historyAskTimes,
      trysteroSelfId,
      HISTORY_ASK_RATE_CAP,
      HISTORY_ASK_RATE_WINDOW_MS,
    )
  ) {
    return false
  }
  if (connection.status === 'connected') {
    safeSend(connection.actions['hist-req'], payload)
  } else {
    connection.pendingHistReq = payload
  }
  return true
}

/**
 * Issue #102 phase 3 — one recovered envelope becomes a Message row through
 * the SAME shape the live path appends (author peerId, author nick, author
 * ts preserved for display), flagged `recovered: true`. `encrypted` mirrors
 * the live convention: the stored row is plaintext when it could be opened,
 * the ENCRYPTED_MESSAGE_PLACEHOLDER with `encrypted: true` when it could
 * not (the placeholder is never re-gossiped — shareableFeedEnvelopes drops
 * encrypted rows). `expiresAt` is computed by the caller on the RECEIVER
 * clock (issue #96 parity): recovery must not resurrect a zombie TTL
 * message with the author's clock.
 */
function buildRecoveredRow(
  roomId: string,
  envelope: Envelope,
  text: string,
  encrypted: boolean,
  expiresAt: number | undefined,
): Message {
  return {
    id: envelope.id,
    roomId,
    authorId: envelope.from,
    authorNick: envelope.nick,
    text,
    ts: envelope.ts,
    encrypted,
    status: 'delivered',
    kind: 'user',
    recovered: true,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

/**
 * Issue #102 phase 3 — the append-time policy for one recovered batch, run
 * INSIDE the connection's recoveredChain (strict batch order even when
 * password-room decryptions settle out of order). Per envelope, in wire
 * order:
 *
 * 1. the MAX_RECOVERED_PER_JOIN recipient cap — once the join session has
 *    accepted its 50, the rest of every later batch is dropped silently
 *    (ids were already marked seen by the transport, so re-sends of the
 *    excess dedup too: the documented cost of the cap);
 * 2. no resurrection (issue #96): an id this session already expired is
 *    dropped, so gossip cannot bring a swept TTL message back;
 * 3. the muted-AUTHOR gate (issue #95 append-time parity): the fingerprint
 *    is resolved through the delivering connection's peerKeyFps keyed by
 *    the envelope's `from` — the AUTHOR's peerId carried by the replayed
 *    envelope, not the sharer's — and an author whose keys never landed
 *    here fails OPEN like the live path (a sharer can only gossip rows its
 *    own connection saw live, where the same fail-open already applied);
 * 4. TTL on the receiver clock: expiresAt = Date.now() + ttl·1000 at
 *    append, never derived from the author ts (the ±90 s skew bound is the
 *    only freshness the replay path keeps);
 * 5. password rooms: enc envelopes are opened with the room key (plaintext
 *    row) or stored as the encrypted placeholder on failure — raw
 *    ciphertext NEVER lands in the feed as text; an enc envelope reaching a
 *    keyless (public) room is undecryptable and is dropped (§7.3).
 *
 * Zero arrival side effects: the store's appendRecoveredMessage never
 * badges, the mention seam never fires and no receipt is ever queued (✓✓
 * means LIVE delivery — transport-level guarantees from phase 1).
 */
async function acceptRecoveredEnvelopes(
  connection: RoomInternals,
  envelopes: readonly Envelope[],
): Promise<void> {
  for (const envelope of envelopes) {
    if (connection.recoveredAccepted >= MAX_RECOVERED_PER_JOIN) return
    if (expiredMessageIds.has(envelope.id)) continue
    if (isMuted(connection, envelope.from)) continue
    const expiresAt = expiresAtFor(envelope.ttl, Date.now())
    if (envelope.enc) {
      const roomKey = connection.roomKey
      if (roomKey === null) continue // keyless room: undecryptable (§7.3)
      try {
        const key = await roomKey
        const text = await decryptRoomMessage(key, {
          iv: envelope.iv ?? '',
          payload: envelope.body,
        })
        // Issue #21 parity — the seal may open into an over-limit plaintext
        // only by tampering: discard like the live path.
        if (text.length > MAX_PLAINTEXT_LENGTH) continue
        appendRecoveredRow(connection, envelope, text, false, expiresAt)
      } catch {
        appendRecoveredRow(connection, envelope, ENCRYPTED_MESSAGE_PLACEHOLDER, true, expiresAt)
      }
    } else {
      appendRecoveredRow(connection, envelope, envelope.body, false, expiresAt)
    }
  }
}

/** Appends one accepted recovered row and counts it against the join cap. */
function appendRecoveredRow(
  connection: RoomInternals,
  envelope: Envelope,
  text: string,
  encrypted: boolean,
  expiresAt: number | undefined,
): void {
  connection.recoveredAccepted += 1
  useAppStore
    .getState()
    .appendRecoveredMessage(
      connection.roomId,
      buildRecoveredRow(connection.roomId, envelope, text, encrypted, expiresAt),
    )
}

/**
 * Issue #102 phase 3 — the seam→store wiring for recovered history,
 * installed at module load like the onReact/onHistRequest wiring (no UI
 * needed for the loop to work; tests re-install it in
 * resetManagerForTests). Phase 1 delivered only shape-valid, skew-checked,
 * dedup'd envelopes per batch; everything after this point is the
 * recipient-side policy above.
 */
function appendRecoveredToStore(roomId: string, envelopes: Envelope[]): void {
  const connection = connections.get(roomId)
  if (connection === undefined) return
  connection.recoveredChain = connection.recoveredChain
    .then(() => acceptRecoveredEnvelopes(connection, envelopes))
    .catch(() => {
      // A failed decrypt tail must never reject the chain (§7.3 silence).
    })
}

onRecovered(appendRecoveredToStore)

// ---------------------------------------------------------------------------
// File transfer (issue #103, spec §12.4) — the engine's wiring lives here
// ---------------------------------------------------------------------------

/**
 * Issue #103 (spec §12.4) — identity regeneration invalidates every file
 * transfer, the same stroke as the manual-DM engines (§12.2): keys and
 * ephemeral material were announced under the OLD identity, so active
 * transfers fail (file-abort while the channels are still up) and every
 * blob URL — done cards included — is revoked (§12.4's revocation list).
 * Installed at module load exactly like the onReact/onHistRequest wiring:
 * the identity-regenerated seam is never cleared by resetManagerForTests,
 * so this subscription is wiring, not disposable listener state.
 */
onSessionIdentityRegenerated(function invalidateFileTransfersOnIdentityRegeneration() {
  abortAllOnIdentityRegeneration()
})

// ---------------------------------------------------------------------------
// Join / leave / reconnect
// ---------------------------------------------------------------------------

/** In-flight joins keyed by name+NUL+password — concurrent calls share one. */
const pendingJoins = new Map<string, Promise<RoomConnection>>()

/** RF-02 — records a joined room as recent (names only) when rememberRooms. */
function recordRecentRoom(name: string): void {
  if (!useSettingsStore.getState().settings.rememberRooms) return
  const next = pushRecentRoom(useAppStore.getState().recentRooms, name)
  useAppStore.getState().setRecentRooms(next)
  saveRecentRooms(next)
}

/**
 * Issue #31 — password-room names are session-only: they never enter the
 * recents list, and a password join actively purges the name from the store
 * state and `gritos:rooms` (covering entries recorded earlier as public
 * rooms or by older builds). The room itself keeps showing as active in the
 * sidebar for as long as it stays joined.
 */
function forgetRecentRoom(name: string): void {
  useAppStore.getState().setRecentRooms(dropRecentRoom(useAppStore.getState().recentRooms, name))
  removeRecentRoom(name)
}

/** Errors surfaced as rejection reasons are RoomLimitError / RoomNameError. */
export function joinRoom(name: string, password?: string): Promise<RoomConnection> {
  const normalized = normalizeRoomName(name)
  if (normalized === null) {
    return Promise.reject(new RoomNameError(name))
  }
  const key = `${normalized}\u0000${password ?? ''}`
  const pending = pendingJoins.get(key)
  if (pending !== undefined) return pending
  const join = doJoinRoom(normalized, password).finally(() => {
    pendingJoins.delete(key)
  })
  pendingJoins.set(key, join)
  return join
}

async function doJoinRoom(normalized: string, password?: string): Promise<RoomConnection> {
  const settings = useSettingsStore.getState().settings
  if (connections.size >= settings.maxActiveRooms) {
    throw new RoomLimitError(settings.maxActiveRooms)
  }

  const roomId = await deriveRoomId(normalized, password)
  const existing = connections.get(roomId)
  if (existing !== undefined) {
    // Issue #31 — public joins record the recents entry; password joins
    // purge it (the roomIds of the two never collide, so `existing` here
    // always matches the password argument of THIS join).
    if (password === undefined) recordRecentRoom(normalized)
    else forgetRecentRoom(normalized)
    return publicViewOf(existing)
  }

  await ensureSessionIdentity()

  // Trystero config (§6.3) — shared with the auxiliary-swarm seam below.
  const config = buildSwarmConfig(settings)

  const trysteroRoom = joinRoomImpl(config, roomId)
  // M4 (§9.3) — start the PBKDF2 derivation immediately; consumers await the
  // promise when sealing/unsealing. Memory-only: it dies with the
  // connection, and a reload re-derives from the re-entered password (RF-05).
  const roomKey = password !== undefined ? deriveRoomKey(password, normalized) : null
  // Consumers surface derivation failures locally; keep the promise from
  // surfacing as an unhandled rejection before the first send/receive.
  roomKey?.catch(() => {
    /* handled at each use site */
  })
  const connection = createConnection({
    roomId,
    name: normalized,
    password,
    hasPassword: password !== undefined,
    roomKey,
    status: 'searching',
    trystero: trysteroRoom,
  })
  connections.set(roomId, connection)

  useAppStore.getState().upsertRoom({
    id: roomId,
    name: normalized,
    hasPassword: connection.hasPassword,
    status: 'searching',
    peers: [],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
  })

  // Issue #31 — a password room's name stays session-only: never recorded
  // as recent, and any previously recorded entry is purged.
  if (password === undefined) recordRecentRoom(normalized)
  else forgetRecentRoom(normalized)
  return publicViewOf(connection)
}

/** RF-02 — closes the room's mesh, frees timers and drops its state. */
export async function leaveRoom(roomId: string): Promise<void> {
  const connection = connections.get(roomId)
  if (connection === undefined) return
  connections.delete(roomId)
  teardownConnection(connection)
  await connection.trystero.leave()
  useAppStore.getState().removeRoom(roomId)
  // M3 — peers that only lived in this room lose their DM availability.
  refreshDmAvailability()
}

/** RF-07 — re-joins every active room applying the current network settings. */
export async function reconnectAll(): Promise<void> {
  const snapshot = [...connections.values()].map((connection) => ({
    roomId: connection.roomId,
    name: connection.name,
    password: connection.password,
  }))
  for (const { roomId } of snapshot) {
    await leaveRoom(roomId)
  }
  for (const { name, password } of snapshot) {
    await joinRoom(name, password)
  }
}

/** Public view of one live connection — the tests' observability seam. */
export function getRoomConnection(roomId: string): RoomConnection | undefined {
  const connection = connections.get(roomId)
  return connection === undefined ? undefined : publicViewOf(connection)
}

export function getActiveRoomCount(): number {
  return connections.size
}

/** M3 seam — the raw ECDH public key announced by a peer, when received. */
export function getPeerRawKey(roomId: string, peerId: string): Uint8Array | null {
  return connections.get(roomId)?.peerKeys.get(peerId) ?? null
}

// ---------------------------------------------------------------------------
// Outgoing chat / typing (RF-03) — used by ChatInput and the debug panel
// ---------------------------------------------------------------------------

/**
 * Sends an action payload, swallowing rejections from channels that closed
 * mid-flight (peers leaving while a batch flush is scheduled).
 */
function safeSend<T>(
  action: { send: (data: T, options?: { target: string }) => Promise<void> },
  data: T,
  options?: { target: string },
): void {
  try {
    void Promise.resolve(action.send(data, options)).catch(() => {
      // Channel closed — nothing to report to the UI for best-effort sends.
    })
  } catch {
    // Fake transports in tests may throw synchronously; same policy.
  }
}

/**
 * RF-03 — builds a chat Envelope, broadcasts it and echoes it into the
 * store as an own 'sent' message. While the room is not connected
 * (`searching`/`error`, §10.3) the envelope is queued locally and flushed
 * on the first peer join, so the user can keep typing.
 *
 * M4 (§6.4 step 4 / §9.3) — in password rooms the wire form seals the body:
 * `{enc: true, iv, body: base64(IV ‖ ct)}`. Sealing is async, so encrypted
 * sends run through a per-connection chain that preserves send order; the
 * local feed echo stays plaintext with `encrypted: false` (the author holds
 * the key). Returns the logical (plaintext) envelope.
 *
 * Issue #96 — `ttl` (whole seconds, 30–3600) rides the envelope unchanged;
 * undefined keeps the wire form byte-identical to pre-TTL builds (no ttl
 * key). Deliberately pass-through, like `v`: the receiving parser is the
 * single gate, so an out-of-bounds ttl would get the message dropped by
 * every peer — senders pass UI-produced values only.
 *
 * Issue #99 — `opts.isAction` marks the LOCAL echo of a /me message so
 * MessageItem renders it as the italic "*nick action*" line. It never
 * touches the envelope (the wire form is byte-identical with or without
 * it): peers rebuild received messages through parseEnvelope, which drops
 * unknown fields, so their copy renders as plain text — an accepted
 * asymmetry of the no-protocol-change rendering convention (see
 * Message.isAction).
 */
export function sendChat(
  roomId: string,
  text: string,
  ttl?: number,
  opts?: { isAction?: boolean },
): Envelope | null {
  const connection = connections.get(roomId)
  const identity = sessionIdentity
  if (connection === undefined || identity === null) return null

  const envelope = createEnvelope({
    from: trysteroSelfId,
    nick: identity.identity.nickname,
    kind: 'chat',
    body: text.slice(0, MAX_PLAINTEXT_LENGTH),
    ...(ttl !== undefined ? { ttl } : {}),
  })

  const deliver = (wire: Envelope): void => {
    if (connection.status !== 'connected') {
      queuePendingChat(connection, wire)
    } else {
      safeSend(connection.actions.chat, wire)
    }
  }

  const roomKey = connection.roomKey
  if (roomKey === null) {
    // Public room: the plaintext envelope is the wire form.
    deliver(envelope)
  } else {
    connection.sendChain = connection.sendChain
      .then(async () => {
        const key = await roomKey
        const sealed = await encryptRoomMessage(key, envelope.body)
        deliver({ ...envelope, enc: true, iv: sealed.iv, body: sealed.payload })
      })
      .catch(() => {
        // Sealing failure (not expected for string passwords): the message
        // is not delivered but stays in the local feed (§7.3 silence).
      })
  }

  // Own echo expires on the receiver clock too (issue #96): the author's
  // copy disappears together with every peer's.
  const expiresAt = expiresAtFor(ttl, Date.now())
  useAppStore.getState().appendMessage(roomId, {
    id: envelope.id,
    roomId,
    authorId: 'self',
    authorNick: envelope.nick,
    text: envelope.body,
    ts: envelope.ts,
    encrypted: false,
    status: 'sent',
    ...(opts?.isAction === true ? { isAction: true } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
  return envelope
}

/**
 * Dev-only diagnosability alias over the real send path: the `?debug` panel
 * (issue #32 — gated behind `import.meta.env.DEV`, so this never ships to
 * production) broadcasts through it.
 */
export function sendTestChat(roomId: string, text: string): Envelope | null {
  return sendChat(roomId, text)
}

/** §7.1 — typing indicator for the composing state of ChatInput. */
export function sendTyping(roomId: string, on: boolean): void {
  const connection = connections.get(roomId)
  if (connection === undefined) return
  safeSend(connection.actions.typing, { on } satisfies TypingPayload)
}

// ---------------------------------------------------------------------------
// DM path (RF-04, §9.2)
// ---------------------------------------------------------------------------

export type DmReceivedListener = (peerId: string, nick: string, text: string) => void

const dmListeners = new Set<DmReceivedListener>()

/** Subscribes to decrypted incoming DMs (notifications, M3/M5). */
export function onDmReceived(listener: DmReceivedListener): () => void {
  dmListeners.add(listener)
  return () => {
    dmListeners.delete(listener)
  }
}

function emitDmReceived(peerId: string, nick: string, text: string): void {
  for (const listener of dmListeners) {
    listener(peerId, nick, text)
  }
}

/**
 * RF-04 — recomputes `DmChannel.available` for every channel: a peer is
 * available while it shares at least one active room. Runs after every
 * peer join/leave and room removal; true→false keeps the history in memory.
 * Issue #93 (spec §12.1) — it also recomputes `legacyPeer`: a CONNECTED
 * peer without an announced session-ephemeral key runs a v1 build that can
 * neither open our v2 dms nor send one — the channel flags it so the UI
 * shows an explicit hint instead of losing messages silently.
 */
function refreshDmAvailability(): void {
  const state = useAppStore.getState()
  const connected = new Set<string>()
  for (const room of Object.values(state.rooms)) {
    for (const peer of room.peers) connected.add(peer.id)
  }
  for (const [peerId, channel] of Object.entries(state.dms)) {
    // Issue #105 (spec §12.5) — signal-backed channels are keyed by identity
    // fingerprint and backed by ANOTHER swarm: their available/legacy state
    // is owned by the signal manager, this room-swarm recomputation must
    // never touch them.
    if (channel.global === true) continue
    const available = connected.has(peerId)
    if (available !== channel.available) state.setDmAvailable(peerId, available)
    const legacyPeer = available && peerEphemeralKeyOf(peerId) === null
    if (legacyPeer !== channel.legacyPeer) state.setDmLegacyPeer(peerId, legacyPeer)
  }
}

// ---------------------------------------------------------------------------
// Mention seam (RF-09, M5) — used by useNotifications
// ---------------------------------------------------------------------------

export type MentionReceivedListener = (
  roomId: string,
  roomName: string,
  nick: string,
  text: string,
) => void

const mentionListeners = new Set<MentionReceivedListener>()

/** Subscribes to room messages that mention the own nickname (RF-09). */
export function onMentionReceived(listener: MentionReceivedListener): () => void {
  mentionListeners.add(listener)
  return () => {
    mentionListeners.delete(listener)
  }
}

/** Fires the mention seam for every listener (gating lives in the hook). */
function emitMentionReceived(roomId: string, roomName: string, nick: string, text: string): void {
  for (const listener of mentionListeners) {
    listener(roomId, roomName, nick, text)
  }
}

/** Nickname of a connected peer from any shared room's entry, when present. */
function peerNicknameOf(peerId: string): { nickname: string; fingerprint: string | null } | null {
  for (const room of Object.values(useAppStore.getState().rooms)) {
    const peer = room.peers.find((entry) => entry.id === peerId)
    if (peer !== undefined) return { nickname: peer.nickname, fingerprint: peer.fingerprint }
  }
  return null
}

/**
 * RF-04 — opens (or reuses) the DM channel with a connected peer and
 * focuses it. Returns false when the peer shares no active room: there is
 * no global channel (spec §11).
 */
export function openDmChannel(peerId: string): boolean {
  const peer = peerNicknameOf(peerId)
  if (peer === null || peer.nickname.trim() === '') return false
  syncDmTofuState(peerId, peer.nickname, livePeerFingerprint(peerId) ?? peer.fingerprint)
  useAppStore.getState().setActiveView({ kind: 'dm', peerId })
  refreshDmAvailability()
  return true
}

/**
 * Issue #105 (spec §12.5) — the ROOM backing of the DmTransport interface:
 * wraps the existing shared-connection internals (identity/ephemeral key
 * maps, directed `dm`/`typing`/`receipt` sends) so a room-backed channel and
 * a signal-backed one expose identical behavior to the store and the UI.
 * Returns null when no active room holds `peerId`'s identity key. The
 * closures read the live connection maps, so key material landing after the
 * transport was built is seen by the next call; `available()` re-checks the
 * connection is still in the manager's map (a left room's stale transport
 * reads unavailable).
 */
export function roomDmTransport(peerId: string): DmTransport | null {
  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) return null
  return {
    kind: 'room',
    channelKey: peerId,
    peerId,
    available: () =>
      connections.get(shared.roomId) === shared &&
      useAppStore.getState().dms[peerId]?.available === true,
    peerIdentityFingerprint: () => {
      // CANONICAL form: the DmTransport contract (issue #105) normalizes the
      // keys-derived identity fp — the signal backing's key space is
      // canonical, and every consumer (v2 derivation, TOFU pin comparison)
      // canonicalizes internally anyway.
      const fingerprint = shared.peerKeyFps.get(peerId)
      return fingerprint === undefined ? null : canonicalFingerprint(fingerprint)
    },
    peerEphemeralKey: () => {
      const rawKey = shared.peerEphKeys.get(peerId)
      const fingerprint = shared.peerEphFps.get(peerId)
      return rawKey !== undefined && fingerprint !== undefined
        ? { rawKey, fingerprint: canonicalFingerprint(fingerprint) }
        : null
    },
    sendDmEnvelope: (envelope) => safeSend(shared.actions.dm, envelope, { target: peerId }),
    sendTyping: (on) =>
      safeSend(shared.actions.typing, { on, dm: true } satisfies TypingPayload, {
        target: peerId,
      }),
    sendReceipts: (ids) =>
      safeSend(shared.actions.receipt, { ids } satisfies ReceiptPayload, { target: peerId }),
  }
}

/**
 * RF-04/§9.2 with issue #93 (spec §12.1) — encrypts `text` for `peerId` and
 * sends the `dm` Envelope directed at the peer only (issue #18): the
 * ciphertext never reaches other room members, so they cannot profile who
 * DMs whom. `filterDmForSelf` stays on the receive path as defense in depth
 * (older peers may still broadcast, §7.1/§7.3). Session-ephemeral E2EE: the
 * key derives from THIS session's ephemeral keypair and the peer's announced
 * `ephkeys` key (`getCachedDmKeyV2`), with both fingerprint pairs — identity
 * and ephemeral — bound into the HKDF salt; the identity key no longer
 * derives anything, it stays the TOFU/salt anchor. Envelopes carry
 * `v: DM_PROTOCOL_VERSION`. Issue #96 — an optional `ttl` (whole seconds)
 * rides the envelope unchanged; undefined keeps the wire form byte-identical
 * to pre-TTL builds. Issue #105 — the guards, key resolution and delivery
 * run through the peer's `DmTransport` (room-backed here), so room and
 * signal DMs keep identical behavior by construction. Returns the envelope,
 * or null when there is no identity, the peer is unavailable (no shared
 * room), its key is unknown, it never announced an ephemeral key (a v1
 * build: DM unavailable — the channel's `legacyPeer` state makes this
 * visible instead of losing messages silently), or the text exceeds the
 * 4000-char protocol limit (§7.3).
 */
export async function sendDm(peerId: string, text: string, ttl?: number): Promise<Envelope | null> {
  const identity = sessionIdentity
  const state = useAppStore.getState()
  const channel = state.dms[peerId]
  if (identity === null) return null
  if (channel === undefined || channel.global === true) return null
  if (text.length > MAX_PLAINTEXT_LENGTH) return null

  const transport = roomDmTransport(peerId)
  if (transport === null || !transport.available()) return null

  try {
    const key = await deriveDmSessionKey(identity.identity.fingerprint, transport)
    if (key === null) return null
    const sealed = await encryptDm(key, text)
    const envelope = createEnvelope({
      from: trysteroSelfId,
      nick: identity.identity.nickname,
      kind: 'dm',
      to: transport.peerId,
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
      v: DM_PROTOCOL_VERSION,
      ...(ttl !== undefined ? { ttl } : {}),
    })
    // Directed send (issue #18): only the recipient gets the ciphertext.
    transport.sendDmEnvelope(envelope)
    const nick = channel.peerNick !== '' ? channel.peerNick : peerId
    syncDmTofuState(peerId, nick, transport.peerIdentityFingerprint())
    // Own echo expires on the receiver clock too (issue #96).
    const expiresAt = expiresAtFor(ttl, Date.now())
    useAppStore.getState().appendDmMessage(peerId, {
      id: envelope.id,
      roomId: `dm:${peerId}`,
      authorId: 'self',
      authorNick: envelope.nick,
      text,
      ts: envelope.ts,
      encrypted: false,
      status: 'sent',
      kind: 'user',
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    })
    return envelope
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// File-transfer key resolution (issue #103 phase 2, spec §12.4)
// ---------------------------------------------------------------------------

/**
 * Which conversation a file transfer rides — the two contexts the engine
 * (Phase 3, `lib/p2p/fileTransfer.ts`) can offer a transfer in. `room`
 * covers public rooms (no key) and password rooms (§9.3 key); `dm` is
 * always sealed (§9.2 v2 key).
 */
export type TransferKeyContext =
  | { readonly kind: 'room'; readonly roomId: string }
  | { readonly kind: 'dm'; readonly peerId: string }

/**
 * Issue #103 phase 2 (spec §12.4) — resolves the AES-GCM key that seals and
 * opens the chunks of a P2P file transfer, mirroring EXACTLY how sendChat
 * and sendDm resolve theirs: same caches, same guards, same failure modes.
 * The engine feeds the result to `sealChunk`/`openChunk`
 * (lib/crypto/chunkCipher.ts) and never touches key state itself.
 *
 * - `room`: the connection's cached `deriveRoomKey` promise — the very
 *   promise sendChat awaits (§9.3). A public (or unknown) room has no key
 *   and resolves `null` → the engine sends `enc: false` (DTLS-only, with
 *   the §12.4 pre-send warning). A password room whose derivation REJECTS
 *   propagates the rejection — never `null` — so a broken key state can
 *   never downgrade a transfer to cleartext (fail closed).
 * - `dm`: the cached v2 key (`getCachedDmKeyV2`) behind sendDm's exact
 *   guard sequence — session identity, available channel, a shared room
 *   holding the peer's identity key and fingerprint, and an announced
 *   session-ephemeral key (its absence is a legacy v1 build: `null`).
 *   Crypto failures on the way (ECDH/HKDF) resolve `null` like sendDm's
 *   catch. DMs are ALWAYS sealed (§12.4), so the engine must treat `null`
 *   here as a refused transfer — never as a cleartext fallback.
 */
export async function resolveTransferKey(ctx: TransferKeyContext): Promise<CryptoKey | null> {
  if (ctx.kind === 'room') {
    const roomKey = connections.get(ctx.roomId)?.roomKey
    if (roomKey === undefined || roomKey === null) {
      return null // public or unknown room: no key → §12.4 enc=false (DTLS-only)
    }
    // Rejections propagate: a failed derivation must fail the transfer,
    // never fall back to cleartext (fail closed, unlike the send path's
    // silent catch — there the message simply is not delivered).
    return roomKey
  }
  // DM branch — the sendDm guard sequence through the room transport (issue
  // #105: one shared DmTransport path for the guard order and key
  // resolution). No session-ephemeral announce (a legacy v1 build) or
  // missing identity key resolves null — a DM channel's `legacyPeer` state
  // makes that visible.
  const identity = sessionIdentity
  if (identity === null) return null
  const channel = useAppStore.getState().dms[ctx.peerId]
  if (channel === undefined || channel.global === true) return null
  const transport = roomDmTransport(ctx.peerId)
  if (transport === null || !transport.available()) return null
  return deriveDmSessionKey(identity.identity.fingerprint, transport)
}

/**
 * Issue #103 phase 4 — the DM file-send seam for the UI. A DM transfer is
 * ALWAYS sealed (§12.4, fail closed) and rides the shared room's swarm, but
 * which room that is lives in the manager's connection map — the UI never
 * sees connection internals — so this mirror of sendDm's own room lookup
 * resolves it before delegating to the engine. The refusal vocabulary is
 * the engine's (`SendFileRefusal`); no shared room answers
 * `peer-not-in-room` before anything is validated or sent.
 */
export function sendDmFileTransfer(
  peerId: string,
  file: File,
  onProgress?: (transferred: number, total: number) => void,
): Promise<SendFileOutcome> {
  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) {
    return Promise.resolve({ ok: false, reason: 'peer-not-in-room' })
  }
  return sendFileTransfer(shared.roomId, peerId, file, 'dm', onProgress)
}

/** §7.1 — DM typing signal, directed at the peer and flagged `dm`. */
export function sendDmTyping(peerId: string, on: boolean): void {
  // Issue #105 — through the room transport: signal-backed channels route
  // through signalChannel's own typing path, never this one.
  roomDmTransport(peerId)?.sendTyping(on)
}

/**
 * Issue #20 — queues a chat envelope for the §10.3 flush, dropping the
 * oldest beyond PENDING_CHATS_CAP. The flush semantics are preserved:
 * whatever remains is delivered oldest-first, in send order.
 */
function queuePendingChat(connection: RoomInternals, envelope: Envelope): void {
  connection.pendingChats.push(envelope)
  if (connection.pendingChats.length > PENDING_CHATS_CAP) {
    connection.pendingChats.shift()
  }
}

/** Flushes chat envelopes queued while the room had no DataChannel yet. */
function flushPendingChats(connection: RoomInternals): void {
  const pending = connection.pendingChats
  connection.pendingChats = []
  for (const envelope of pending) {
    safeSend(connection.actions.chat, envelope)
  }
}

/**
 * §7.1 — queues a receipt id for `authorPeerId`. The flush is debounced
 * (RECEIPT_DEBOUNCE_MS) and split into payloads of at most 50 ids.
 */
function queueReceipt(connection: RoomInternals, authorPeerId: string, messageId: string): void {
  const ids = connection.pendingReceipts.get(authorPeerId)
  if (ids === undefined) {
    connection.pendingReceipts.set(authorPeerId, [messageId])
  } else {
    ids.push(messageId)
  }
  if (connection.receiptTimer === null) {
    connection.receiptTimer = setTimeout(() => {
      connection.receiptTimer = null
      flushReceipts(connection)
    }, RECEIPT_DEBOUNCE_MS)
  }
}

/** Sends every pending receipt, chunked to MAX_RECEIPT_BATCH ids each. */
function flushReceipts(connection: RoomInternals): void {
  for (const [authorPeerId, ids] of [...connection.pendingReceipts]) {
    connection.pendingReceipts.delete(authorPeerId)
    while (ids.length > 0) {
      const batch = ids.splice(0, MAX_RECEIPT_BATCH)
      safeSend(connection.actions.receipt, { ids: batch } satisfies ReceiptPayload, {
        target: authorPeerId,
      })
    }
  }
}

/** Sends a directed latency probe (§7.1 ping). Used by the useLatency loop. */
export function sendPing(roomId: string, peerId: string, t: number): boolean {
  const connection = connections.get(roomId)
  if (connection === undefined) return false
  safeSend(connection.actions.ping, { t }, { target: peerId })
  return true
}

/**
 * Issue #98 — sends emoji reactions over `roomId`'s swarm. With `to` set the
 * batches are DIRECTED at that peer (DM reactions: they ride the room swarm
 * but must not leak to the room — same transport discipline as `dm`/
 * `receipt`); without it the reaction is a room-wide broadcast (every peer
 * maintains counts). Ids are chunked into MAX_REACT_BATCH payloads like
 * receipts (§7.1), each validated by the same canonical `parseReact` gate
 * the receive path uses — an invalid reaction (non-whitelisted emo, empty
 * id, missing `on`) never reaches the wire. Cosmetic class: fire-and-forget
 * while connected, no §10.3 pending queue (losing reactions offline costs
 * nothing; queueing them would only delay staleness), false returned when
 * the room is unknown, disconnected, or the payload is invalid.
 */
export function sendReact(
  roomId: string,
  ids: string[],
  emo: string,
  on: boolean,
  to?: string,
): boolean {
  const connection = connections.get(roomId)
  if (connection === undefined || connection.status !== 'connected') return false
  if (ids.length === 0) return false
  // Validate EVERY batch before sending ANY: a garbage id in a later chunk
  // must not let an earlier chunk reach the wire.
  const payloads: ReactPayload[] = []
  for (let i = 0; i < ids.length; i += MAX_REACT_BATCH) {
    const payload = parseReact({
      ids: ids.slice(i, i + MAX_REACT_BATCH),
      emo,
      on,
      ...(to !== undefined ? { to } : {}),
    })
    if (payload === null) return false
    payloads.push(payload)
  }
  for (const payload of payloads) {
    safeSend(
      connection.actions.react,
      payload satisfies ReactPayload,
      payload.to !== undefined ? { target: payload.to } : undefined,
    )
  }
  return true
}

/**
 * Issue #102 — shares history as `hist` batches on `roomId`'s swarm: the
 * SENDER side of gossip, callable now but wired only in phase 2 (the
 * consent layer subscribes to onHistRequest and calls this; nothing calls
 * it yet, and the default is silence). The input is a generic envelope
 * list (phase 2 feeds it from the in-memory store) and is SANITIZED before
 * anything reaches the wire: at most the first MAX_HISTORY_REQUEST (50)
 * envelopes are considered, only `kind: 'chat'` survives — DMs are NEVER
 * gossiped (room scope only; receipts/typing have no envelopes) — and each
 * survivor is re-validated with parseEnvelope, dropping malformed entries.
 * The wire forms are then chunked by MEASURED encoded size
 * (chunkHistBatches: ≤ 20 envelopes AND ≤ 48 KiB of JSON per batch — the
 * count cap alone cannot guarantee the 64 KB transport fit, and sealing
 * grows a body by ~34%, so chunking must see the POST-seal forms).
 *
 * Password rooms keep confidentiality: enc:false bodies are re-sealed with
 * the room key (fresh IVs; the store holds plaintext, so there is no
 * original ciphertext to forward), while enc:true envelopes are treated as
 * already-wire-form and pass through untouched. Any sealing failure aborts
 * the whole share with nothing sent — the sendReact no-partial-send
 * discipline. Batches are broadcast room-wide (no target): the content is
 * room-scope chat every peer could already see live, receivers dedup it
 * silently, and Trystero keeps per-action wire order, so batches arrive in
 * order. Fire-and-forget like sendReact — no §10.3 pending queue (a share
 * that races a disconnect is simply lost; the asking peer can ask again) —
 * and 0 is returned for an unknown or not-connected room (or when nothing
 * survives sanitization), otherwise the number of batches dispatched.
 */
export async function sendHistory(roomId: string, envelopes: Envelope[]): Promise<number> {
  const connection = connections.get(roomId)
  if (connection === undefined || connection.status !== 'connected') return 0

  // Sanitize: cap, chat-only, re-validate. Order preserved (phase 3 renders
  // recovered oldest → newest by author ts regardless).
  const clean: Envelope[] = []
  for (const envelope of envelopes.slice(0, MAX_HISTORY_REQUEST)) {
    if (envelope.kind !== 'chat') continue
    const validated = parseEnvelope(envelope)
    if (validated === null) continue
    clean.push(validated)
  }
  if (clean.length === 0) return 0

  // Wire forms: seal plaintext bodies when this room has a key; enc
  // envelopes are already wire-form and pass through.
  let wireForms = clean
  const roomKey = connection.roomKey
  if (roomKey !== null) {
    try {
      const key = await roomKey
      wireForms = []
      for (const envelope of clean) {
        if (envelope.enc) {
          wireForms.push(envelope)
          continue
        }
        const sealed = await encryptRoomMessage(key, envelope.body)
        wireForms.push({ ...envelope, enc: true, iv: sealed.iv, body: sealed.payload })
      }
    } catch {
      return 0 // sealing failure (not expected for string passwords): §7.3 silence
    }
  }

  const batches = chunkHistBatches(wireForms)
  for (const batch of batches) {
    safeSend(connection.actions.hist, { batch } satisfies HistPayload)
  }
  return batches.length
}

/**
 * Issue #98 phase 2 — the UI toggle: applies the local peerId to the message
 * OPTIMISTICALLY (the store action is the same gate remote payloads use, so
 * caps and idempotence hold) and sends the matching `react` payload. The
 * direction comes from current state: selfId already on the list → unreact.
 * Composition with the wire is duplicate-free by construction — Trystero
 * never loops own broadcasts back, and the store add is idempotent should an
 * echo ever surface. `to` selects the DM slice (keyed by the peer) and rides
 * the first shared room's swarm directed at the peer (the sendDmTyping
 * discipline); without it the toggle is a room broadcast. Returns whether
 * the send was dispatched; the local toggle stands even when it was not —
 * cosmetic state, losing the propagation costs nothing (the same posture as
 * sendReact skipping the §10.3 queue). False (no state change) for a
 * non-whitelisted emoji or an unknown message id.
 */
export function toggleReaction(
  roomId: string,
  messageId: string,
  emo: string,
  to?: string,
): boolean {
  if (!(REACT_EMOJIS as readonly string[]).includes(emo)) return false
  const store = useAppStore.getState()
  const message =
    to !== undefined
      ? store.dms[to]?.messages.find((entry) => entry.id === messageId)
      : store.rooms[roomId]?.messages.find((entry) => entry.id === messageId)
  if (message === undefined) return false
  const on = !(message.reactions?.[emo as ReactEmoji] ?? []).includes(trysteroSelfId)
  if (to !== undefined) {
    store.applyDmMessageReactions(to, [messageId], emo, trysteroSelfId, on)
    const shared = [...connections.values()].find((entry) => entry.peerKeys.has(to))
    if (shared === undefined) return false
    return sendReact(shared.roomId, [messageId], emo, on, to)
  }
  store.applyMessageReactions(roomId, [messageId], emo, trysteroSelfId, on)
  return sendReact(roomId, [messageId], emo, on)
}

/** RF-03 — drops typing entries older than TYPING_TTL_MS. */
export function pruneExpiredTyping(roomId: string, now: number): void {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) return
  for (const [peerId, ts] of Object.entries(room.typing)) {
    if (now - ts >= TYPING_TTL_MS) {
      useAppStore.getState().setTyping(roomId, peerId, null)
    }
  }
}

/**
 * Issue #96 — receiver-clock expiry instant for an envelope's optional ttl:
 * `receivedAt` is THIS peer's Date.now() AT THE STORE APPEND — never the
 * author `ts`, which is only skew-tolerated ±90 s (MAX_CLOCK_SKEW_MS) and
 * must not be trusted for expiry. ttl-less messages stay session-lived
 * (undefined = never swept).
 */
function expiresAtFor(ttl: number | undefined, receivedAt: number): number | undefined {
  return ttl === undefined ? undefined : receivedAt + ttl * 1000
}

/**
 * Issue #96 — one expiry sweep over every room and DM feed (the 1 s tick of
 * useExpirySweep). The store action does the guarded removal and returns the
 * removed ids; they land in `expiredMessageIds` so the receive paths can
 * drop a replayed envelope instead of resurrecting the expired message.
 */
export function pruneExpiredMessages(now: number): string[] {
  const removed = useAppStore.getState().sweepExpiredMessages(now)
  for (const id of removed) expiredMessageIds.add(id)
  return removed
}

// ---------------------------------------------------------------------------
// Local mute enforcement (issue #95) — receive-path gate
// ---------------------------------------------------------------------------

/**
 * Issue #95 — whether a fingerprint (either notation) is on the local mute
 * list. Deliberately cheap: one canonicalization plus one `includes()` over
 * the canonical list per envelope, no index or cache.
 */
function mutedFingerprint(fingerprint: string): boolean {
  return useSettingsStore
    .getState()
    .settings.mutedFingerprints.includes(canonicalFingerprint(fingerprint))
}

/**
 * Issue #95 — whether `peerId`'s identity fingerprint is muted. The
 * fingerprint comes from the connection's keys-derived map (the same
 * crypto-trusted value the peer list shows), never from the spoofable
 * `presence` self-announcement. Fail-open by decision (issue #95): a peer
 * whose `keys` announce has not landed yet has no known fingerprint and is
 * NOT muted — presence and keys travel the same join burst, so the window
 * is tiny, and buffering or retro-filtering would cost more than the leak.
 * (The join/leave line gate below is the one exception: there the announced
 * `fp` is consulted too, since on a fresh join it is all the identity
 * material received so far — and a spoofed value can only suppress the
 * spoofer's own line.)
 */
function isMuted(connection: RoomInternals, peerId: string): boolean {
  const fingerprint = connection.peerKeyFps.get(peerId)
  return fingerprint !== undefined && mutedFingerprint(fingerprint)
}

/**
 * Issue #95 — local-only feedback line for a UI mute/unmute, appended to the
 * ACTIVE room feed (same RF-06 local-line path as join/leave). Skipped
 * silently when the active view is not a room (a DM view or no view at all:
 * there is no room feed to show it in). Deliberately NOT subject to
 * SYSTEM_LINE_RATE_CAP — the cap throttles peer-controlled join/leave
 * floods; this line only ever follows a local user action.
 */
function appendMuteLineToActiveRoom(text: string): void {
  const { activeView, rooms } = useAppStore.getState()
  if (activeView?.kind !== 'room') return
  if (rooms[activeView.id] === undefined) return
  appendSystemMessage(activeView.id, text)
}

/**
 * Issue #95 — mutes a fingerprint from the UI (PeerList menu, MessageItem
 * author affordance): stores it via the settings helper and, when this is a
 * fresh mute (an idempotent re-mute only refreshes the last-seen nickname),
 * appends '@nick was muted' to the active room. False when the
 * fingerprint is malformed or the mute list is full.
 */
export function muteFromUi(fingerprint: string, nickname: string): boolean {
  const store = useSettingsStore.getState()
  const fresh = !store.settings.mutedFingerprints.includes(canonicalFingerprint(fingerprint))
  if (!store.muteFingerprint(fingerprint, nickname)) return false
  if (fresh) appendMuteLineToActiveRoom(muteSystemLine(nickname))
  // Issue #103 (spec §12.4) — muting a peer aborts its active transfers on
  // the spot (local discard + file-abort to the other side): a muted
  // peer's content stops accumulating immediately.
  for (const connection of connections.values()) {
    for (const [peerId, peerFp] of connection.peerKeyFps) {
      if (mutedFingerprint(peerFp)) abortActiveTransfersWithPeer(connection.roomId, peerId)
    }
  }
  return true
}

/**
 * Issue #95 — lifts a mute from the UI (PeerList menu, Privacy-tab mute
 * list): removes it via the settings helper and, when a last-seen nickname
 * is still known (it rides memory-only and dies with the session), appends
 * '@nick is no longer muted' to the active room. False when the
 * fingerprint is malformed or was not muted.
 */
export function unmuteFromUi(fingerprint: string): boolean {
  const nickname = getMutedNickname(fingerprint)
  if (!useSettingsStore.getState().unmuteFingerprint(fingerprint)) return false
  if (nickname !== null) appendMuteLineToActiveRoom(unmuteSystemLine(nickname))
  return true
}

// ---------------------------------------------------------------------------
// TOFU pinning (issue #22) — fingerprint pin + DM channel reconciliation
// ---------------------------------------------------------------------------

/** Live keys-derived fingerprint of a peer in any active room, when known. */
function livePeerFingerprint(peerId: string): string | null {
  for (const connection of connections.values()) {
    const fingerprint = connection.peerKeyFps.get(peerId)
    if (fingerprint !== undefined) return fingerprint
  }
  return null
}

/**
 * Issue #93 (spec §12.1) — the session-ephemeral public key announced by
 * `peerId` via `ephkeys` (first connection holding it) together with its
 * derived fingerprint, or null when the key (or its still-async
 * fingerprint) has not landed yet. The v2 send path ECDHs over it and the
 * DM availability guard treats null as a LEGACY peer (v1 build, DM
 * unavailable). The fingerprint here is crypto-trust only — never pinned
 * under `gritos:tofu` (the identity key stays the TOFU anchor) and never
 * displayed (§12.1).
 */
export function peerEphemeralKeyOf(
  peerId: string,
): { rawKey: Uint8Array; fingerprint: string } | null {
  for (const connection of connections.values()) {
    const rawKey = connection.peerEphKeys.get(peerId)
    const fingerprint = connection.peerEphFps.get(peerId)
    if (rawKey !== undefined && fingerprint !== undefined) {
      return { rawKey, fingerprint }
    }
  }
  return null
}

/**
 * Reconciles the DM channel of `peerId` with its TOFU pin: the pinned
 * first-seen fingerprint (`gritos:tofu`) is authoritative for display, and
 * a live fingerprint that differs flags the channel `keyChanged` (advisory)
 * instead of silently rotating the shown identity. Creates the channel when
 * missing — the open/send/receive path. A pin persisted by the previous
 * 64-bit format (issue #23) is the same key: the live 128-bit fingerprint
 * is displayed and nothing is flagged.
 */
function syncDmTofuState(peerId: string, peerNick: string, liveFingerprint: string | null): void {
  const state = useAppStore.getState()
  const pinned = getTofuFingerprint(peerId)
  const pinStaleForLive =
    pinned !== null && liveFingerprint !== null && !pinMatchesFingerprint(pinned, liveFingerprint)
  state.ensureDmChannel(peerId, peerNick, pinStaleForLive ? pinned : (liveFingerprint ?? pinned))
  state.setDmKeyChanged(peerId, pinStaleForLive)
}

/**
 * Same reconciliation for an EXISTING channel only — the `keys` receive
 * path must not open channels (they are created on demand: open/send/
 * receive, RF-04).
 */
function syncExistingDmTofuState(peerId: string, liveFingerprint: string): void {
  if (useAppStore.getState().dms[peerId] === undefined) return
  syncDmTofuState(peerId, '', liveFingerprint)
}

// ---------------------------------------------------------------------------
// Connection internals
// ---------------------------------------------------------------------------

function publicViewOf(connection: RoomInternals): RoomConnection {
  return {
    roomId: connection.roomId,
    name: connection.name,
    hasPassword: connection.hasPassword,
    status: connection.status,
  }
}

function createConnection(init: {
  roomId: string
  name: string
  password?: string
  hasPassword: boolean
  roomKey: Promise<CryptoKey> | null
  status: RoomStatus
  trystero: TrysteroRoom
}): RoomInternals {
  const trysteroRoom = init.trystero
  const actions: RoomActions = {
    presence: trysteroRoom.makeAction<PresencePayload>('presence'),
    keys: trysteroRoom.makeAction<Uint8Array | ArrayBuffer>('keys'),
    ephkeys: trysteroRoom.makeAction<Uint8Array | ArrayBuffer>('ephkeys'),
    chat: trysteroRoom.makeAction<Envelope>('chat'),
    dm: trysteroRoom.makeAction<Envelope>('dm'),
    typing: trysteroRoom.makeAction<TypingPayload>('typing'),
    receipt: trysteroRoom.makeAction<ReceiptPayload>('receipt'),
    // Issue #98 phase 1 — SPIKE RESULT (mixed-build tolerance), by source
    // analysis of the installed @trystero-p2p/core 0.25.4
    // (node_modules/@trystero-p2p/core/dist/action-wire.mjs). Registering one
    // more action is safe for old peers that never register it:
    //
    // 1. Actions route BY NAME, not by negotiated index. Every wire chunk
    //    embeds the action type string itself, zero-padded to 32 bytes at
    //    offset 0 (action-wire.mjs:66-73 build `typeBytesPadded`; :104
    //    `chunk.set(typeBytesPadded)` per chunk). There is no handshake that
    //    maps names to per-connection ids, so a NEW action name cannot shift
    //    the encoding an OLD peer parses for its EXISTING actions — each
    //    message self-describes its action.
    // 2. On receive, handleData decodes the name and looks it up in the
    //    LOCAL registry (`const action = actions[type]`,
    //    action-wire.mjs:142-145). For an unregistered name the chunks are
    //    still reassembled but then parked in `pendingActionPayloads[type]`
    //    (:169-177) — no handler fires, nothing throws; the payload would
    //    only be delivered if that action were registered later (:78-85).
    //    An old build therefore ignores `react` traffic silently, and its
    //    existing actions keep routing untouched. (Trystero's own internal
    //    actions are `@_`-prefixed — room.mjs:8, :80-93 — so `react` cannot
    //    collide with them either.)
    // 3. The 16-bit `nonce` in the header is a per-(peer, type) chunk-
    //    reassembly counter (action-wire.mjs:105, :111, :147, :156-157),
    //    never an action id.
    //
    // Conclusion: the issue's feared fallback (riding reactions through the
    // receipt channel) is NOT needed; the `react` action ships as designed.
    // Residual note: an old peer buffers unclaimed payloads in
    // `pendingActionPayloads` without bound (Trystero's own design); the
    // sender-side REACT_RATE_CAP and the cosmetic payload size keep honest
    // builds' contribution negligible.
    react: trysteroRoom.makeAction<ReactPayload>('react'),
    // Issue #102 phase 1 — history gossip rides the same mixed-build
    // tolerance analyzed for `react` above (actions route by name; old
    // builds park unclaimed payloads without firing a handler), so
    // `hist-req`/`hist` register as their own actions.
    'hist-req': trysteroRoom.makeAction<HistReqPayload>('hist-req'),
    hist: trysteroRoom.makeAction<HistPayload>('hist'),
    // Issue #103 (spec §12.4) — the five file-transfer actions, registered
    // together after `hist` and before `ping`/`pong` in §12.4's reading
    // order: offer, data, credit, close, cancel (the order is NOT
    // load-bearing — actions route by name). Same mixed-build tolerance as
    // `react`/`hist`: an old build parks these payloads without firing a
    // handler (silent §12.4 degradation with mixed builds).
    'file-meta': trysteroRoom.makeAction<FileMeta>('file-meta'),
    'file-chunk': trysteroRoom.makeAction<Uint8Array | ArrayBuffer>('file-chunk'),
    'file-ack': trysteroRoom.makeAction<FileAckPayload>('file-ack'),
    'file-end': trysteroRoom.makeAction<FileEndPayload>('file-end'),
    'file-abort': trysteroRoom.makeAction<FileAbortPayload>('file-abort'),
    ping: trysteroRoom.makeAction<PingPayload>('ping'),
    pong: trysteroRoom.makeAction<PongPayload>('pong'),
  }

  const connection: RoomInternals = {
    roomId: init.roomId,
    name: init.name,
    password: init.password,
    hasPassword: init.hasPassword,
    roomKey: init.roomKey,
    sendChain: Promise.resolve(),
    status: init.status,
    trystero: trysteroRoom,
    actions,
    seenIds: new BoundedSeenIds(),
    peerKeys: new Map<string, Uint8Array>(),
    peerKeyFps: new Map<string, string>(),
    peerEphKeys: new Map<string, Uint8Array>(),
    peerEphFps: new Map<string, string>(),
    announcedPeers: new Set<string>(),
    systemLineTimes: new Map<string, number[]>(),
    reactTimes: new Map<string, number[]>(),
    histReqTimes: new Map<string, number[]>(),
    histTimes: new Map<string, number[]>(),
    historyAskTimes: new Map<string, number[]>(),
    pendingHistReq: null,
    recoveredAccepted: 0,
    recoveredChain: Promise.resolve(),
    pendingChats: [],
    pendingReceipts: new Map<string, string[]>(),
    receiptTimer: null,
    errorTimer: null,
    typingTimer: null,
  }

  // Issue #103 (spec §12.4) — the per-connection context every file
  // handler receives (and the send path looks up by room id). The roomKey
  // is read through a live getter: teardownConnection nulls it on leave,
  // and a torn-down room must never re-seal with a dead key.
  const fileHost: FileTransferHost = {
    roomId: connection.roomId,
    get roomKey() {
      return connection.roomKey
    },
    isConnected: () => connection.status === 'connected',
    hasPeer: (peerId) => connection.peerKeys.has(peerId),
    isPeerMuted: (peerId) => isMuted(connection, peerId),
    resolveKey: (ctx) => resolveTransferKey(ctx),
    send: (action, data, target) =>
      safeSend(
        connection.actions[action] as {
          send: (data: unknown, options?: { target: string }) => Promise<void>
        },
        data,
        { target },
      ),
  }
  registerFileHost(fileHost)

  actions.presence.onMessage = (payload, { peerId }) => {
    if (typeof payload?.nick !== 'string' || typeof payload?.fp !== 'string') {
      return
    }
    // Issue #28 — the remote nick is sanitized at the boundary (control/
    // invisible characters stripped, length capped). When nothing legible
    // remains the peerId-prefix default set on peer join is kept, instead
    // of overwriting it with an unusable nickname.
    const nick = sanitizeRemoteNick(payload.nick)
    // The fingerprint derived from the peer's `keys` action is the trusted
    // one (§9.1): a diverging presence fingerprint never overwrites it and
    // nothing is logged (§7.3 silence).
    const patch: Partial<Peer> = {}
    if (nick !== null) patch.nickname = nick
    if (!connection.peerKeyFps.has(peerId)) patch.fingerprint = payload.fp
    useAppStore.getState().updatePeer(connection.roomId, peerId, patch)
    // RF-06 — the first presence announcement of a peer becomes a discrete
    // system feed line; later ones are nickname changes and stay silent.
    // Issue #36 — beyond the per-peer rate cap the line is suppressed and
    // the peer stays unannounced, so the join line is emitted (at most
    // SYSTEM_LINE_RATE_CAP times) once the rolling window allows it again.
    // Issue #95 — a muted peer announces no line and stays unannounced
    // (no budget burned either): once unmuted, its next presence
    // announcement surfaces the deferred join line. The line gate falls
    // back to the announced `fp` because on a fresh join it is the only
    // fingerprint received so far (the keys announce lands moments later,
    // after the async hash) — and a spoofed value can only suppress the
    // spoofer's own line.
    const lineFingerprint = connection.peerKeyFps.get(peerId) ?? payload.fp
    if (
      nick !== null &&
      !connection.announcedPeers.has(peerId) &&
      !mutedFingerprint(lineFingerprint)
    ) {
      if (consumeSystemLineBudget(connection, peerId)) {
        connection.announcedPeers.add(peerId)
        appendSystemMessage(connection.roomId, joinSystemLine(nick))
      }
    }
  }

  actions.keys.onMessage = (data, { peerId }) => {
    // Trystero delivers binary payloads as ArrayBuffers (or TypedArrays).
    const bytes =
      data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (bytes === null) return
    if (isOversized(bytes.byteLength) || bytes.byteLength !== RAW_PUBLIC_KEY_LENGTH) {
      return
    }
    connection.peerKeys.set(peerId, bytes)
    void computeFingerprint(bytes).then((fingerprint) => {
      // The peer may have left while the hash was being computed.
      if (connection.peerKeys.has(peerId)) {
        connection.peerKeyFps.set(peerId, fingerprint)
        // Issue #22 (TOFU): the first fingerprint seen per peer is pinned
        // under `gritos:tofu` (first write wins) and stays the displayed
        // identity even when a later key differs — the channel is flagged
        // `keyChanged` instead. Without storage the pin is a no-op and
        // everything keeps working per session.
        pinTofuFingerprint(peerId, fingerprint)
        // Issue #23 — a pin persisted by the previous 64-bit format is the
        // same key: the live 128-bit fingerprint wins on display too.
        const pinned = getTofuFingerprint(peerId)
        useAppStore.getState().updatePeer(connection.roomId, peerId, {
          fingerprint:
            pinned !== null && !pinMatchesFingerprint(pinned, fingerprint) ? pinned : fingerprint,
        })
        // Refresh the DM header fingerprint of an existing channel (RF-04);
        // channels are only created on demand (open/send/receive).
        syncExistingDmTofuState(peerId, fingerprint)
      }
    })
  }

  actions.ephkeys.onMessage = (data, { peerId }) => {
    // Issue #93 (spec §12.1) — the session-ephemeral announce follows the
    // exact binary discipline of `keys`: Trystero delivers binary payloads
    // as ArrayBuffers (or TypedArrays), the transport cap applies, and only
    // an exact uncompressed P-256 public key (65 bytes) is accepted.
    const bytes =
      data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
    if (bytes === null) return
    if (isOversized(bytes.byteLength) || bytes.byteLength !== RAW_PUBLIC_KEY_LENGTH) {
      return
    }
    connection.peerEphKeys.set(peerId, bytes)
    void computeFingerprint(bytes).then((fingerprint) => {
      // The peer may have left while the hash was being computed.
      if (connection.peerEphKeys.has(peerId)) {
        connection.peerEphFps.set(peerId, fingerprint)
        // Issue #93 (spec §12.1) — from this moment the peer is v2-capable:
        // a legacy flag on its DM channel (if any) flips false, exactly in
        // the async-tail style of the `keys` handler above.
        refreshDmAvailability()
      }
    })
    // Spec §12.1 — deliberately NO pinTofuFingerprint and no store write:
    // the ephemeral fingerprint is never pinned (it changes on every
    // session; the long-lived identity key stays the TOFU anchor under
    // `gritos:tofu`) and is never displayed. The key only feeds the v2 DM
    // derivation.
  }

  actions.chat.onMessage = (data, context) => {
    handleChatEnvelope(connection, data, context.peerId)
  }

  actions.dm.onMessage = (data, context) => {
    handleDmEnvelope(connection, data, context.peerId)
  }

  actions.typing.onMessage = (payload, { peerId }) => {
    if (typeof payload?.on !== 'boolean') return
    // Issue #95 — a muted peer's typing flags (room and dm) never land.
    if (isMuted(connection, peerId)) return
    if (payload.dm === true) {
      // M3 — directed DM typing (RF-04): lands on the channel, not the room.
      useAppStore.getState().setDmTyping(peerId, payload.on ? Date.now() : null)
      if (payload.on) ensureTypingSweeper(connection)
      return
    }
    if (payload.on) {
      useAppStore.getState().setTyping(connection.roomId, peerId, Date.now())
      ensureTypingSweeper(connection)
    } else {
      useAppStore.getState().setTyping(connection.roomId, peerId, null)
    }
  }

  actions.receipt.onMessage = (payload, { peerId }) => {
    if (!validateReceipt(payload)) return
    useAppStore.getState().markMessagesDelivered(connection.roomId, payload.ids)
    // M3 — DM messages of the same author flip to ✓✓ too (RF-04).
    useAppStore.getState().markDmMessagesDelivered(peerId, payload.ids)
  }
  // Issue #98 — reactions never touch the store in phase 1: the validated
  // payload goes through the onReact seam only (phase 2 subscribes to it).
  actions.react.onMessage = (payload, { peerId }) => {
    handleReactPayload(connection, payload, peerId)
  }
  // Issue #102 — history gossip never touches the store in phase 1 either:
  // validated traffic goes through the onHistRequest/onRecovered seams only
  // (phase 2 consent + state subscribe there).
  actions['hist-req'].onMessage = (payload, { peerId }) => {
    handleHistRequest(connection, payload, peerId)
  }
  actions.hist.onMessage = (payload, { peerId }) => {
    handleHistBatch(connection, payload, peerId)
  }
  // Issue #103 (spec §12.4) — the five file actions share ONE pre-parse
  // gate: a muted sender's file traffic is content and drops before any
  // parsing, effect or state (the same door as chat/dm/typing, issue #95).
  // Everything after the gate (validation, caps, credit window, framing,
  // the state machine) lives in the engine.
  actions['file-meta'].onMessage = (payload, { peerId }) => {
    if (isMuted(connection, peerId)) return
    handleFileMeta(fileHost, payload, peerId)
  }
  actions['file-chunk'].onMessage = (data, { peerId }) => {
    if (isMuted(connection, peerId)) return
    handleFileChunk(fileHost, data, peerId)
  }
  actions['file-ack'].onMessage = (payload, { peerId }) => {
    if (isMuted(connection, peerId)) return
    handleFileAck(fileHost, payload, peerId)
  }
  actions['file-end'].onMessage = (payload, { peerId }) => {
    if (isMuted(connection, peerId)) return
    handleFileEnd(fileHost, payload, peerId)
  }
  actions['file-abort'].onMessage = (payload, { peerId }) => {
    if (isMuted(connection, peerId)) return
    handleFileAbort(fileHost, payload, peerId)
  }
  actions.ping.onMessage = (payload, { peerId }) => {
    if (typeof payload?.t !== 'number' || !Number.isFinite(payload.t)) return
    safeSend(connection.actions.pong, { t: payload.t } satisfies PongPayload, { target: peerId })
  }

  actions.pong.onMessage = (payload, { peerId }) => {
    if (typeof payload?.t !== 'number' || !Number.isFinite(payload.t)) return
    for (const listener of pongListeners) {
      listener(connection.roomId, peerId, payload.t)
    }
  }

  trysteroRoom.onPeerJoin = (peerId) => handlePeerJoin(connection, peerId)
  trysteroRoom.onPeerLeave = (peerId) => handlePeerLeave(connection, peerId)

  armErrorHeuristic(connection)
  return connection
}

function handlePeerJoin(connection: RoomInternals, peerId: string): void {
  // First peer activity disproves the tracker-dead heuristic (§10.3).
  disarmErrorHeuristic(connection)
  setConnectionStatus(connection, 'connected')
  // Issue #102 phase 3 — a history ask tapped while the room was still
  // hunting goes out now that a DataChannel exists (budget already paid at
  // accept time; the payload dies with the connection if no peer ever
  // joined).
  const parkedAsk = connection.pendingHistReq
  if (parkedAsk !== null) {
    connection.pendingHistReq = null
    safeSend(connection.actions['hist-req'], parkedAsk)
  }
  // §10.3 — messages typed while searching go out now that a DataChannel
  // exists.
  flushPendingChats(connection)

  const identity = sessionIdentity
  if (identity !== null) {
    safeSend(
      connection.actions.presence,
      { nick: identity.identity.nickname, fp: identity.identity.fingerprint },
      { target: peerId },
    )
    safeSend(connection.actions.keys, identity.rawPublicKey, { target: peerId })
    // Issue #93 (spec §12.1) — the session-ephemeral key announce follows
    // `keys`, directed at the joiner. The keypair is generated lazily on
    // first use; when the peer leaves before generation resolves, the
    // directed send dies in safeSend like every best-effort tail.
    void ensureEphemeralSession().then((session) => {
      safeSend(connection.actions.ephkeys, session.rawPublicKey, { target: peerId })
    })
  }

  const peer: Peer = {
    id: peerId,
    nickname: peerId.slice(0, 8),
    fingerprint: null,
    latencyMs: null,
    degraded: false,
  }
  useAppStore.getState().addPeer(connection.roomId, peer)
  // M3 — the peer is (back) in a shared room: DM channels may go available.
  refreshDmAvailability()
}

function handlePeerLeave(connection: RoomInternals, peerId: string): void {
  // RF-06 — the leave becomes a discrete system line with the last known
  // nickname, before the peer entry is dropped. Issue #36 — leave lines
  // share the per-peer budget with join lines, so rejoin churn cannot use
  // them to flood the feed either. Issue #95 — a muted peer stays silent
  // (checked before the fingerprint maps are dropped below).
  const room = useAppStore.getState().rooms[connection.roomId]
  const nickname = room?.peers.find((peer) => peer.id === peerId)?.nickname
  if (nickname !== undefined && nickname.trim() !== '' && !isMuted(connection, peerId)) {
    if (consumeSystemLineBudget(connection, peerId)) {
      appendSystemMessage(connection.roomId, leaveSystemLine(nickname))
    }
  }
  connection.peerKeys.delete(peerId)
  connection.peerKeyFps.delete(peerId)
  // Issue #93 — the ephemeral material dies with the peer too.
  connection.peerEphKeys.delete(peerId)
  connection.peerEphFps.delete(peerId)
  // Issue #103 (spec §12.4) — a reconnect mid-transfer FAILS the transfer,
  // no resume: offsets and accumulators are per-connection memory.
  onPeerGone(connection.roomId, peerId)
  connection.announcedPeers.delete(peerId)
  useAppStore.getState().removePeer(connection.roomId, peerId)
  useAppStore.getState().setTyping(connection.roomId, peerId, null)
  useAppStore.getState().setDmTyping(peerId, null)
  // M3 — losing the last shared room flips the DM channel to disconnected;
  // its history stays in memory until reload (RF-04).
  refreshDmAvailability()

  if (
    useAppStore.getState().rooms[connection.roomId] !== undefined &&
    (useAppStore.getState().rooms[connection.roomId]?.peers.length ?? 1) === 0
  ) {
    // No DataChannel left: back to hunting (§10.3 searching).
    setConnectionStatus(connection, 'searching')
    armErrorHeuristic(connection)
  }
}

function handleChatEnvelope(
  connection: RoomInternals,
  data: unknown,
  transportPeerId: string,
): void {
  // Issue #95 — a muted author drops before any parsing, dedup, store
  // append, mention emission or receipt queuing (§7.3 silence).
  if (isMuted(connection, transportPeerId)) return
  const envelope = parseEnvelope(data)
  if (envelope === null || envelope.kind !== 'chat') return
  // Dedup BEFORE the async decrypt tail: full-mesh duplicates of an
  // encrypted envelope must be dropped exactly once (§7.3).
  if (!shouldProcess(envelope, connection.seenIds)) return
  // Issue #96 — no resurrection: once this session has expired the message,
  // a replay of its envelope (its dedup entry may long be evicted) is
  // dropped before any append, receipt or mention side effect.
  if (expiredMessageIds.has(envelope.id)) return
  if (envelope.enc) {
    const roomKey = connection.roomKey
    if (roomKey === null) return // public room has no key: discard (§7.3)
    void decryptChatEnvelope(connection, envelope, transportPeerId, roomKey)
    return
  }

  appendRoomChat(connection, envelope, transportPeerId, envelope.body, false)

  // §6.4 step 2 — receipt directed to the author (debounced, ≤50 ids).
  queueReceipt(connection, transportPeerId, envelope.id)
}

/** Shared store append for the plaintext and placeholder chat paths. */
function appendRoomChat(
  connection: RoomInternals,
  envelope: Envelope,
  authorId: string,
  text: string,
  encrypted: boolean,
): void {
  // Issue #96 — expiry on the RECEIVER clock: Date.now() at the append,
  // never the author `ts` (skew-tolerated only).
  const expiresAt = expiresAtFor(envelope.ttl, Date.now())
  useAppStore.getState().appendMessage(connection.roomId, {
    id: envelope.id,
    roomId: connection.roomId,
    authorId,
    authorNick: envelope.nick,
    text,
    ts: envelope.ts,
    encrypted,
    status: 'delivered',
    kind: 'user',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
  // RF-09 — a received message mentioning the own nickname surfaces through
  // the mention seam (the notifications hook applies the hidden/settings/
  // permission gate). Encrypted placeholders can never match a nickname.
  const ownNick = sessionIdentity?.identity.nickname
  if (ownNick !== undefined && !encrypted && mentionsNickname(text, ownNick)) {
    emitMentionReceived(connection.roomId, connection.name, envelope.nick, text)
  }
}

/**
 * M4 — async tail of the encrypted chat receive path (§6.4 step 4). With
 * the room key the payload opens into plaintext stored with
 * `encrypted: false`. When the key is missing or the seal fails to open
 * (theoretical: derivation collision or tampering), the message is stored
 * as the RF-05 placeholder "🔒 mensaje cifrado" with `encrypted: true` —
 * the raw ciphertext NEVER lands in the feed as text. The delivery receipt
 * is emitted either way: receipting is about transport, not readability.
 */
async function decryptChatEnvelope(
  connection: RoomInternals,
  envelope: Envelope,
  senderId: string,
  roomKey: Promise<CryptoKey>,
): Promise<void> {
  try {
    const key = await roomKey
    const text = await decryptRoomMessage(key, { iv: envelope.iv ?? '', payload: envelope.body })
    // Issue #21 — the ciphertext cap still admits ~12 KB of ciphertext, and
    // the send-side 4000-char cap only binds honest clients: a key-holding
    // peer can seal an over-limit plaintext that opens validly. It is
    // discarded here like any other invalid payload (§7.3 silence); the
    // receipt below still answers the transport, not readability.
    if (text.length <= MAX_PLAINTEXT_LENGTH) {
      appendRoomChat(connection, envelope, senderId, text, false)
    }
  } catch {
    appendRoomChat(connection, envelope, senderId, ENCRYPTED_MESSAGE_PLACEHOLDER, true)
  }
  queueReceipt(connection, senderId, envelope.id)
}

/**
 * Rolling per-peer budget shared by every rate-capped receive path (join/
 * leave lines, reactions, history gossip): true when one more payload from
 * `peerId` fits under `cap` within the last `windowMs`. The per-peer queue
 * never grows beyond `cap` entries; queues are kept across peer leaves
 * (clearing them there would let rejoin churn reset the cap) and freed
 * with the connection. Issue #105 — exported: the signal manager's knock
 * cap (spec §12.5, KNOCK_RATE_CAP 5/min/peer) rides the same helper so the
 * rolling-window semantics stay identical across swarms.
 */
export function consumeRollingBudget(
  times: Map<string, number[]>,
  peerId: string,
  cap: number,
  windowMs: number,
): boolean {
  const now = Date.now()
  const windowStart = now - windowMs
  const recent = (times.get(peerId) ?? []).filter((ts) => ts > windowStart)
  if (recent.length >= cap) {
    times.set(peerId, recent)
    return false
  }
  recent.push(now)
  times.set(peerId, recent)
  return true
}

/**
 * Issue #36 — consumes one slot of `peerId`'s join/leave system-line budget
 * over the rolling window: true when a line may be emitted.
 */
function consumeSystemLineBudget(connection: RoomInternals, peerId: string): boolean {
  return consumeRollingBudget(
    connection.systemLineTimes,
    peerId,
    SYSTEM_LINE_RATE_CAP,
    SYSTEM_LINE_RATE_WINDOW_MS,
  )
}

/**
 * Issue #98 — receive path of one `react` payload. Gate order tightens cost:
 * local mute (issue #95 parity — a muted peer's reactions never surface, the
 * same policy as typing flags), then the pure `parseReact` validation
 * (whitelist/caps; violations dropped whole, silently — cosmetic class, no
 * system lines), then the foreign-directed drop (`to` addressed to another
 * peer: DM reactions ride the swarm TARGETED at the recipient, so this only
 * bites peers that still broadcast directed traffic — defense in depth like
 * `filterDmForSelf`, and never relayed, §7.3), then the per-peer rate cap
 * (before dedup, so even replay storms cannot churn the dedup window), and
 * finally payload dedup through the connection's BoundedSeenIds (full-mesh
 * duplicates + replay flooding). What survives is delivered to the onReact
 * seam; phase 2 owns everything after (including silently dropping ids of
 * unknown or FIFO-evicted messages).
 */
function handleReactPayload(connection: RoomInternals, data: unknown, peerId: string): void {
  if (isMuted(connection, peerId)) return
  const payload = parseReact(data)
  if (payload === null) return
  if (payload.to !== undefined && payload.to !== trysteroSelfId) return
  if (!consumeReactBudget(connection, peerId)) return
  if (!markSeen(connection.seenIds, reactSeenKey(payload))) return
  for (const listener of reactListeners) {
    listener(connection.roomId, peerId, payload)
  }
}

/**
 * Issue #98 — consumes one slot of `peerId`'s react budget over the rolling
 * window: true when a payload may be processed.
 */
function consumeReactBudget(connection: RoomInternals, peerId: string): boolean {
  return consumeRollingBudget(connection.reactTimes, peerId, REACT_RATE_CAP, REACT_RATE_WINDOW_MS)
}

/**
 * Issue #102 — receive path of one `hist-req` payload. Gate order tightens
 * cost, the react pattern: local mute (a muted peer's requests never even
 * reach the rate cap — pre-process parity with every other action), then
 * the pure `parseHistReq` bounds (integer 1..50; violations dropped
 * silently), then the per-peer rate cap (1/min). What survives is delivered
 * to the onHistRequest seam ONLY: phase 1 never answers a request — whether
 * to share, and what, is the phase-2 consent layer's decision (default
 * silence), so no `hist` may leave this path.
 */
function handleHistRequest(connection: RoomInternals, data: unknown, peerId: string): void {
  if (isMuted(connection, peerId)) return
  const payload = parseHistReq(data)
  if (payload === null) return
  if (
    !consumeRollingBudget(
      connection.histReqTimes,
      peerId,
      HISTORY_REQ_RATE_CAP,
      HISTORY_REQ_RATE_WINDOW_MS,
    )
  ) {
    return
  }
  for (const listener of histRequestListeners) {
    listener(connection.roomId, peerId, payload.n)
  }
}

/**
 * Issue #102 — receive path of one `hist` batch (the REPLAY path). Gate
 * order tightens cost: local mute (a muted SHARER's gossip drops before any
 * parse — the same pre-decrypt/pre-process gate as every other action;
 * envelopes authored by locally-muted THIRD parties are phases 2/3's
 * append-time concern, not the transport's), then the pure
 * `parseHistBatch` validation (batch cap + full per-envelope shape checks
 * incl. the version gates, chat-only; any violation drops the WHOLE batch),
 * then the per-peer rate cap (6 batches/min → ≤ 120 msgs/min/peer, before
 * dedup so replay storms cannot churn the dedup window), then per envelope:
 * the future-skew bound — the ONE freshness check the replay path keeps
 * (isWithinFutureSkew); the MAX_ENVELOPE_AGE_MS age window is BYPASSED, the
 * whole point of gossip — and the connection's BoundedSeenIds dedup:
 * batched ids are marked seen on receipt, so a replay flood collapses AND a
 * later LIVE resend of the same id dedups through shouldProcess. A rejected
 * envelope consumes no dedup id and triggers zero side effects. Survivors
 * go to the onRecovered seam only — no store append, no unread, no mention,
 * no receipt, no typing (✓✓ means LIVE delivery); a fully-deduped batch
 * calls no listener at all.
 */
function handleHistBatch(connection: RoomInternals, data: unknown, peerId: string): void {
  if (isMuted(connection, peerId)) return
  const batch = parseHistBatch(data)
  if (batch === null) return
  if (
    !consumeRollingBudget(connection.histTimes, peerId, HISTORY_RATE_CAP, HISTORY_RATE_WINDOW_MS)
  ) {
    return
  }
  const recovered: Envelope[] = []
  for (const envelope of batch) {
    if (!isWithinFutureSkew(envelope.ts)) continue
    if (!markSeen(connection.seenIds, envelope.id)) continue
    recovered.push(envelope)
  }
  if (recovered.length === 0) return
  for (const listener of recoveredListeners) {
    listener(connection.roomId, recovered)
  }
}

/** Local-only feed line (RF-06): never sent over the wire, no dedup needed. */
function appendSystemMessage(roomId: string, text: string): void {
  useAppStore.getState().appendMessage(roomId, {
    id: crypto.randomUUID(),
    roomId,
    authorId: 'system',
    authorNick: '',
    text,
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'system',
  })
}

function handleDmEnvelope(connection: RoomInternals, data: unknown, transportPeerId: string): void {
  // Issue #95 — a muted sender is ignored before ANY work: no parse, no
  // dedup slot, no channel reconciliation, no decrypt (§7.3 silence).
  if (isMuted(connection, transportPeerId)) return
  const envelope = parseEnvelope(data)
  // Issue #93 (spec §12.1) — the parser only lets v2 dms through: a v1 dm
  // (old build) dies here, the accepted mixed-version degradation.
  if (envelope === null || envelope.kind !== 'dm') return
  if (filterDmForSelf(envelope, trysteroSelfId) === null) return
  // Issue #19 — dedup against the session-wide set, not the connection's:
  // replays through other rooms or fresh connections must still be dropped.
  if (!shouldProcess(envelope, seenDmIds)) return
  // Issue #96 — same no-resurrection guard as the room chat path: an
  // already-expired DM envelope never re-enters its channel.
  if (expiredMessageIds.has(envelope.id)) return
  if (!envelope.enc || envelope.iv === null) return

  const identity = sessionIdentity
  const peerRawKey = connection.peerKeys.get(transportPeerId)
  // §9.2 — the sender's identity raw public key must be known (TOFU/salt
  // anchor); otherwise the payload is undecryptable and is discarded
  // silently (§7.3).
  if (identity === null || peerRawKey === undefined) return

  // Issue #93 (spec §12.1) — the v2 derivation ECDHs over the sender's
  // session-ephemeral key, so BOTH the announced key and its fingerprint
  // must have landed. A v2 envelope from a peer that never announced
  // `ephkeys` (old build, forge or replay) is undecryptable: silent
  // discard (§7.3).
  const senderEphRaw = connection.peerEphKeys.get(transportPeerId)
  const senderEphFp = connection.peerEphFps.get(transportPeerId)
  if (senderEphRaw === undefined || senderEphFp === undefined) return

  const senderIdFp = connection.peerKeyFps.get(transportPeerId) ?? null
  void decryptDmEnvelope(
    connection,
    envelope,
    transportPeerId,
    peerRawKey,
    senderIdFp,
    senderEphRaw,
    senderEphFp,
  )
}

/**
 * Async tail of the DM receive path (issue #93, spec §12.1): derive the v2
 * key over the ephemeral pairs → decrypt → store. The identity fingerprints
 * only anchor the salt (and the TOFU sync); the ECDH runs on the
 * session-ephemeral material of both sides.
 */
async function decryptDmEnvelope(
  connection: RoomInternals,
  envelope: Envelope,
  senderId: string,
  peerRawKey: Uint8Array,
  senderIdFp: string | null,
  senderEphRaw: Uint8Array,
  senderEphFp: string,
): Promise<void> {
  const identity = sessionIdentity
  if (identity === null) return
  const theirIdFp = senderIdFp ?? (await computeFingerprint(peerRawKey))
  const ownSession = await ensureEphemeralSession()
  try {
    const key = await getCachedDmKeyV2(
      ownSession.keypair.privateKey,
      senderEphRaw,
      identity.identity.fingerprint,
      theirIdFp,
      ownSession.fingerprint,
      senderEphFp,
    )
    const text = await decryptDm(key, { iv: envelope.iv ?? '', payload: envelope.body })
    // Issue #21 — the send-side cap only binds honest clients: a key-holding
    // peer can seal an over-limit plaintext that opens validly. Discarded
    // with zero side effects (no channel, no receipt, no notification), the
    // same §7.3 silence as the catch below.
    if (text.length > MAX_PLAINTEXT_LENGTH) return
    syncDmTofuState(senderId, envelope.nick, theirIdFp)
    // Issue #96 — expiry on the RECEIVER clock: Date.now() at the append.
    const expiresAt = expiresAtFor(envelope.ttl, Date.now())
    useAppStore.getState().appendDmMessage(senderId, {
      id: envelope.id,
      roomId: `dm:${senderId}`,
      authorId: senderId,
      authorNick: envelope.nick,
      text,
      ts: envelope.ts,
      encrypted: false,
      status: 'delivered',
      kind: 'user',
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    })
    refreshDmAvailability()
    // §6.4/§7.1 — the DM answers with the same debounced directed receipt
    // as a room chat message.
    queueReceipt(connection, senderId, envelope.id)
    emitDmReceived(senderId, envelope.nick, text)
  } catch {
    // Wrong key, tampered tag or malformed payload (§7.3): silent discard.
  }
}

function setConnectionStatus(connection: RoomInternals, status: RoomStatus): void {
  connection.status = status
  useAppStore.getState().setRoomStatus(connection.roomId, status)
}

/**
 * §10.3 heuristic — 15 s with no connection to any tracker while searching
 * → 'error' (issue #125). Peer activity disarms it instantly (handlePeerJoin);
 * an empty room over an OPEN relay socket is signaling, not breakage, so the
 * timer re-arms and a later outage is still caught by a future check.
 */
function armErrorHeuristic(connection: RoomInternals): void {
  disarmErrorHeuristic(connection)
  connection.errorTimer = setTimeout(() => {
    connection.errorTimer = null
    if (connection.status === 'searching') {
      if (trackersReachable()) {
        // Issue #125 — signaling is up, the room is just peerless: keep
        // hunting instead of firing the error, and re-check after another
        // window so a tracker that dies LATER still trips the heuristic.
        armErrorHeuristic(connection)
        return
      }
      setConnectionStatus(connection, 'error')
    }
  }, ERROR_HEURISTIC_MS)
}

function disarmErrorHeuristic(connection: RoomInternals): void {
  if (connection.errorTimer !== null) {
    clearTimeout(connection.errorTimer)
    connection.errorTimer = null
  }
}

function ensureTypingSweeper(connection: RoomInternals): void {
  if (connection.typingTimer !== null) return
  connection.typingTimer = setInterval(() => {
    pruneExpiredTyping(connection.roomId, Date.now())
    pruneExpiredDmTyping(Date.now())
    const room = useAppStore.getState().rooms[connection.roomId]
    const dmTypingActive = Object.values(useAppStore.getState().dms).some(
      (channel) => Object.keys(channel.typing).length > 0,
    )
    if (
      (room === undefined || Object.keys(room.typing).length === 0) &&
      !dmTypingActive &&
      connection.typingTimer !== null
    ) {
      clearInterval(connection.typingTimer)
      connection.typingTimer = null
    }
  }, 1_000)
}

/** RF-04 — DM typing entries expire after TYPING_TTL_MS like room ones. */
export function pruneExpiredDmTyping(now: number): void {
  for (const [peerId, channel] of Object.entries(useAppStore.getState().dms)) {
    if (channel.typing[peerId] === undefined) continue
    if (now - (channel.typing[peerId] as number) >= TYPING_TTL_MS) {
      useAppStore.getState().setDmTyping(peerId, null)
    }
  }
}

function teardownConnection(connection: RoomInternals): void {
  disarmErrorHeuristic(connection)
  // Issue #103 (spec §12.4) — the room's file-transfer host dies with the
  // connection and its active transfers fail locally (no file-abort: the
  // channels are going away).
  roomTornDown(connection.roomId)
  // M4 (RF-05) — leaving discards the room key: the password and its derived
  // key exist only for the lifetime of the connection.
  connection.roomKey = null
  connection.sendChain = Promise.resolve()
  if (connection.receiptTimer !== null) {
    clearTimeout(connection.receiptTimer)
    connection.receiptTimer = null
  }
  connection.pendingReceipts.clear()
  connection.pendingChats = []
  // Issue #102 phase 3 — an unflushed history ask dies with the connection
  // (a leave before any peer joined simply loses the ask; the next join may
  // ask again, budget fresh).
  connection.pendingHistReq = null
  if (connection.typingTimer !== null) {
    clearInterval(connection.typingTimer)
    connection.typingTimer = null
  }
  connection.trystero.onPeerJoin = null
  connection.trystero.onPeerLeave = null
}

/**
 * Test-only reset: drops every connection without network side effects and
 * restores the pristine store state. Never call from production code.
 */
export function resetManagerForTests(): void {
  for (const connection of connections.values()) {
    teardownConnection(connection)
    try {
      void connection.trystero.leave()
    } catch {
      // Fake rooms may not implement leave; nothing to clean up in tests.
    }
  }
  connections.clear()
  pendingJoins.clear()
  seenDmIds.clear()
  // Issue #96 — the expired-id guard dies with the session like every dedup
  // window; tests must start pristine.
  expiredMessageIds.clear()
  pongListeners.clear()
  reactListeners.clear()
  // Issue #98 phase 2 — re-install the module-load seam→store wiring the
  // clear above purged: tests only own disposable listeners (see the
  // subscription comment at onReact).
  onReact(applyInboundReactionToStore)
  // Issue #102 phases 2+3 — same for the consent layer and the recovered-
  // state append wiring: module-load wiring, not disposable listener state.
  histRequestListeners.clear()
  onHistRequest(respondToHistoryRequest)
  recoveredListeners.clear()
  onRecovered(appendRecoveredToStore)
  dmListeners.clear()
  mentionListeners.clear()
  // Issue #103 — the engine's records, sessions, hosts, rate budgets and
  // seams die with the manager's state: tests start pristine.
  resetFileTransfersForTests()
  clearDmKeyCache()
  sessionIdentity = null
  identityPromise = null
  // Issue #93 — mirrors resetSessionIdentity: tests start with no
  // session-ephemeral material either.
  setEphemeralSession(null)
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAppStore.setState({ ...INITIAL_APP_STATE })
}

// ---------------------------------------------------------------------------
// Panic path (RF-08) — used by lib/panic.ts
// ---------------------------------------------------------------------------

/**
 * RF-08 — synchronously tears down every connection (WebRTC meshes closed
 * via `leave`, timers freed, room keys discarded) and clears the manager's
 * join bookkeeping. Best-effort: a fake/real transport that throws on leave
 * never blocks the wipe.
 */
export function abortAllRooms(): void {
  for (const connection of connections.values()) {
    teardownConnection(connection)
    try {
      void connection.trystero.leave()
    } catch {
      // Nothing to clean up beyond the teardown itself.
    }
  }
  connections.clear()
  pendingJoins.clear()
}

/**
 * RF-08 — drops the in-memory session identity (its keys are wiped).
 * Issue #93 (spec §12.1) — the session-ephemeral keypair dies in the same
 * stroke: a panic wipe must leave no DM-derivation material behind (the v2
 * DM key caches are already covered by clearDmKeyCache in panic.ts).
 */
export function resetSessionIdentity(): void {
  sessionIdentity = null
  identityPromise = null
  setEphemeralSession(null)
}
