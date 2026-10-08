import {
  joinRoom as trysteroJoinRoom,
  selfId as trysteroSelfId,
  type JoinRoomConfig,
  type MessageAction,
  type Room as TrysteroRoom,
} from '@trystero-p2p/torrent'
import { resolveTrysteroAppId } from './appId'
import { deriveRoomId } from '../crypto/hashes'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type Peer,
  type RoomStatus,
} from '../../stores/useAppStore'
import { DEFAULT_SETTINGS, getMutedNickname, useSettingsStore } from '../../stores/useSettingsStore'
import { createEnvelope, DM_PROTOCOL_VERSION } from './protocol'
import {
  BoundedSeenIds,
  MAX_PLAINTEXT_LENGTH,
  filterDmForSelf,
  isOversized,
  parseEnvelope,
  shouldProcess,
  validateReceipt,
  MAX_RECEIPT_BATCH,
  type Envelope,
  type PingPayload,
  type PongPayload,
  type PresencePayload,
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
import { ensureEphemeralSession, setEphemeralSession } from '../crypto/sessionEphemeral'
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

/**
 * The single Trystero surface of the app (plan.md §3 architecture rules:
 * only this module may import trystero). Multi-room core — spec §6.3/§6.5:
 * a Map<roomId, RoomConnection>; each connection encapsulates its Trystero
 * room, its 9 registered actions (§7.1) and its status heuristic, and feeds
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
 * Testability: the Trystero `joinRoom` function sits behind an injectable
 * factory (`setJoinRoomFactory`) so tests drive the manager with a fake.
 */

/** RF-02 — normalized names: 1–32 chars of [a-z0-9_-]. */
export const ROOM_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

/** §10.3 heuristic — no tracker/peer activity within 15 s → 'error'. */
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
 * Issue #20 — the §10.3 local chat queue (envelopes typed while the room has
 * no DataChannel) holds at most this many envelopes; the oldest is dropped.
 */
export const PENDING_CHATS_CAP = 100

/** Uncompressed ECDH P-256 public key: 0x04 ‖ X ‖ Y = 65 bytes (§9.1). */
export const RAW_PUBLIC_KEY_LENGTH = 65

/** Trystero joinRoom signature — the injection seam used by the tests. */
export type TrysteroJoinRoom = typeof trysteroJoinRoom

/** RF-02 — exceeding settings.maxActiveRooms rejects with this typed error. */
export class RoomLimitError extends Error {
  readonly maxRooms: number

  constructor(maxRooms: number) {
    super(`Límite de salas activas alcanzado (${maxRooms})`)
    this.name = 'RoomLimitError'
    this.maxRooms = maxRooms
  }
}

/** RF-02 — invalid room names reject before any network call. */
export class RoomNameError extends Error {
  constructor(rawName: string) {
    super(`Nombre de sala no válido: «${rawName}»`)
    this.name = 'RoomNameError'
  }
}

/** RF-01 — invalid nicknames reject before any state/presence change. */
export class NicknameError extends Error {
  constructor(rawNickname: string) {
    super(`Apodo no válido: «${rawNickname}»`)
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

let joinRoomImpl: TrysteroJoinRoom = trysteroJoinRoom

/**
 * Dependency-injection seam: replaces the Trystero joinRoom function so
 * tests (and only tests) drive the manager with a fake. null restores the
 * real implementation.
 */
export function setJoinRoomFactory(factory: TrysteroJoinRoom | null): void {
  joinRoomImpl = factory ?? trysteroJoinRoom
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

/**
 * RF-07 (M5) — regenerates the cryptographic identity: a new ECDH keypair
 * is created and persisted under `gritos:identity` (same nickname), the DM
 * key cache is dropped (old keys no longer match), the store is updated and
 * presence + keys are re-announced to every peer of every active room.
 * Issue #93 (spec §12.1) — the session-ephemeral keypair is reset and a
 * fresh one is generated and re-announced (`ephkeys`) to the same peers.
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

  // Trystero config (§6.3): appId always; custom trackers/ICE replace the
  // defaults only when the user configured them (RF-07). Issue #90 — the
  // appId comes from the build environment, resolved per join so a missing
  // variable surfaces as a join error instead of breaking at import time.
  const config: JoinRoomConfig = { appId: resolveTrysteroAppId() }
  if (settings.trackers.length > 0) {
    config.relayConfig = { urls: [...settings.trackers] }
  }
  if (settings.iceServers.length > 0) {
    config.rtcConfig = { iceServers: settings.iceServers.map((server) => ({ ...server })) }
  }

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
 */
export function sendChat(roomId: string, text: string): Envelope | null {
  const connection = connections.get(roomId)
  const identity = sessionIdentity
  if (connection === undefined || identity === null) return null

  const envelope = createEnvelope({
    from: trysteroSelfId,
    nick: identity.identity.nickname,
    kind: 'chat',
    body: text.slice(0, MAX_PLAINTEXT_LENGTH),
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

  useAppStore.getState().appendMessage(roomId, {
    id: envelope.id,
    roomId,
    authorId: 'self',
    authorNick: envelope.nick,
    text: envelope.body,
    ts: envelope.ts,
    encrypted: false,
    status: 'sent',
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
 * RF-04/§9.2 with issue #93 (spec §12.1) — encrypts `text` for `peerId` and
 * sends the `dm` Envelope directed at the peer only (issue #18): the
 * ciphertext never reaches other room members, so they cannot profile who
 * DMs whom. `filterDmForSelf` stays on the receive path as defense in depth
 * (older peers may still broadcast, §7.1/§7.3). Session-ephemeral E2EE: the
 * key derives from THIS session's ephemeral keypair and the peer's announced
 * `ephkeys` key (`getCachedDmKeyV2`), with both fingerprint pairs — identity
 * and ephemeral — bound into the HKDF salt; the identity key no longer
 * derives anything, it stays the TOFU/salt anchor. Envelopes carry
 * `v: DM_PROTOCOL_VERSION`. Returns the envelope, or null when there is no
 * identity, the peer is unavailable (no shared room), its key is unknown,
 * it never announced an ephemeral key (a v1 build: DM unavailable — the
 * channel's `legacyPeer` state makes this visible instead of losing
 * messages silently), or the text exceeds the 4000-char protocol limit
 * (§7.3).
 */
export async function sendDm(peerId: string, text: string): Promise<Envelope | null> {
  const identity = sessionIdentity
  const state = useAppStore.getState()
  const channel = state.dms[peerId]
  if (identity === null) return null
  if (channel === undefined || !channel.available) return null
  if (text.length > MAX_PLAINTEXT_LENGTH) return null

  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) return null

  const theirFp = shared.peerKeyFps.get(peerId)
  if (theirFp === undefined) return null

  // Issue #93 (spec §12.1) — the peer must have announced a session-
  // ephemeral key AND its fingerprint (`ephkeys`); without it this is a v1
  // build that can never open a v2 dm: refuse here, the UI shows the
  // legacy state instead of letting the message vanish.
  const eph = peerEphemeralKeyOf(peerId)
  if (eph === null) return null

  try {
    // The ephemeral keypair is generated lazily on first use — after the
    // guards, so a refused send never triggers a pointless keygen.
    const session = await ensureEphemeralSession()
    const key = await getCachedDmKeyV2(
      session.keypair.privateKey,
      eph.rawKey,
      identity.identity.fingerprint,
      theirFp,
      session.fingerprint,
      eph.fingerprint,
    )
    const sealed = await encryptDm(key, text)
    const envelope = createEnvelope({
      from: trysteroSelfId,
      nick: identity.identity.nickname,
      kind: 'dm',
      to: peerId,
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
      v: DM_PROTOCOL_VERSION,
    })
    // Directed send (issue #18): only the recipient gets the ciphertext.
    safeSend(shared.actions.dm, envelope, { target: peerId })
    const nick = channel.peerNick !== '' ? channel.peerNick : peerId
    syncDmTofuState(peerId, nick, theirFp)
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
    })
    return envelope
  } catch {
    return null
  }
}

/** §7.1 — DM typing signal, directed at the peer and flagged `dm`. */
export function sendDmTyping(peerId: string, on: boolean): void {
  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) return
  safeSend(shared.actions.typing, { on, dm: true } satisfies TypingPayload, { target: peerId })
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
 * appends '@nick fue silenciado' to the active room. False when the
 * fingerprint is malformed or the mute list is full.
 */
export function muteFromUi(fingerprint: string, nickname: string): boolean {
  const store = useSettingsStore.getState()
  const fresh = !store.settings.mutedFingerprints.includes(canonicalFingerprint(fingerprint))
  if (!store.muteFingerprint(fingerprint, nickname)) return false
  if (fresh) appendMuteLineToActiveRoom(muteSystemLine(nickname))
  return true
}

/**
 * Issue #95 — lifts a mute from the UI (PeerList menu, Privacidad mute
 * list): removes it via the settings helper and, when a last-seen nickname
 * is still known (it rides memory-only and dies with the session), appends
 * '@nick ya no está silenciado' to the active room. False when the
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
    pendingChats: [],
    pendingReceipts: new Map<string, string[]>(),
    receiptTimer: null,
    errorTimer: null,
    typingTimer: null,
  }

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
 * Issue #36 — consumes one slot of `peerId`'s join/leave system-line budget
 * over the rolling window: true when a line may be emitted. The per-peer
 * queue never grows beyond SYSTEM_LINE_RATE_CAP entries (bounded memory);
 * queues of peers that never return are freed with the connection.
 */
function consumeSystemLineBudget(connection: RoomInternals, peerId: string): boolean {
  const now = Date.now()
  const windowStart = now - SYSTEM_LINE_RATE_WINDOW_MS
  const recent = (connection.systemLineTimes.get(peerId) ?? []).filter((ts) => ts > windowStart)
  if (recent.length >= SYSTEM_LINE_RATE_CAP) {
    connection.systemLineTimes.set(peerId, recent)
    return false
  }
  recent.push(now)
  connection.systemLineTimes.set(peerId, recent)
  return true
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

/** §10.3 heuristic — 15 s with zero peer activity while searching → 'error'. */
function armErrorHeuristic(connection: RoomInternals): void {
  disarmErrorHeuristic(connection)
  connection.errorTimer = setTimeout(() => {
    connection.errorTimer = null
    if (connection.status === 'searching') {
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
  pongListeners.clear()
  dmListeners.clear()
  mentionListeners.clear()
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
