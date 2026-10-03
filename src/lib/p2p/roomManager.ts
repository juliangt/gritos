import {
  joinRoom as trysteroJoinRoom,
  selfId as trysteroSelfId,
  type JoinRoomConfig,
  type MessageAction,
  type Room as TrysteroRoom,
} from '@trystero-p2p/torrent'
import { deriveRoomId } from '../crypto/hashes'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type Peer,
  type RoomStatus,
} from '../../stores/useAppStore'
import { DEFAULT_SETTINGS, useSettingsStore } from '../../stores/useSettingsStore'
import { createEnvelope } from './protocol'
import {
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
import { computeFingerprint, createSessionIdentity, loadIdentity, restoreSessionIdentity, type SessionIdentity } from '../crypto/identity'
import { decryptDm, encryptDm, getCachedDmKey, clearDmKeyCache } from '../crypto/dm'
import {
  decryptRoomMessage,
  deriveRoomKey,
  encryptRoomMessage,
} from '../crypto/roomKey'
import { ENCRYPTED_MESSAGE_PLACEHOLDER } from '../rooms'
import { pushRecentRoom, saveRecentRooms } from '../recentRooms'
import { joinSystemLine, leaveSystemLine } from '../feed'

/**
 * The single Trystero surface of the app (plan.md §3 architecture rules:
 * only this module may import trystero). Multi-room core — spec §6.3/§6.5:
 * a Map<roomId, RoomConnection>; each connection encapsulates its Trystero
 * room, its 8 registered actions (§7.1) and its status heuristic, and feeds
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
 * Testability: the Trystero `joinRoom` function sits behind an injectable
 * factory (`setJoinRoomFactory`) so tests drive the manager with a fake.
 */

/** spec §9.4 — constant Trystero appId. */
export const APP_ID = 'gritos-app-v1'

/** RF-02 — normalized names: 1–32 chars of [a-z0-9_-]. */
export const ROOM_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/

/** §10.3 heuristic — no tracker/peer activity within 15 s → 'error'. */
export const ERROR_HEURISTIC_MS = 15_000

/** RF-03 — a typing signal expires after 4 s. */
export const TYPING_TTL_MS = 4_000

/** §7.1 — receiver receipts are batched with this debounce before sending. */
export const RECEIPT_DEBOUNCE_MS = 300

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
  /** Per-room dedup window — spec §7.3. */
  readonly seenIds: Set<string>
  /** Raw ECDH public keys per peer, in memory only (§7.1). */
  readonly peerKeys: Map<string, Uint8Array>
  /** Fingerprints derived from the received keys — the crypto-trusted ones. */
  readonly peerKeyFps: Map<string, string>
  /** Peers whose presence was already announced in the feed (join lines). */
  readonly announcedPeers: Set<string>
  /** Chat envelopes awaiting the first DataChannel (§10.3 local queue). */
  pendingChats: Envelope[]
  /** Receipt ids per author peerId, flushed debounced in ≤50 batches. */
  readonly pendingReceipts: Map<string, string[]>
  receiptTimer: ReturnType<typeof setTimeout> | null
  errorTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
}

// ---------------------------------------------------------------------------
// Module state + seams
// ---------------------------------------------------------------------------

const connections = new Map<string, RoomInternals>()

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
      const persisted =
        stored !== null
          ? {
              nickname: stored.nickname,
              fingerprint: stored.fingerprint,
              createdAt: stored.createdAt,
              ...extractPersistedJwks(),
            }
          : loadIdentity()
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

/** Reads the optional JWK fields of the persisted record, when readable. */
function extractPersistedJwks(): { pubJwk?: JsonWebKey; privJwk?: JsonWebKey } {
  const persisted = loadIdentity()
  if (persisted?.pubJwk !== undefined && persisted.privJwk !== undefined) {
    return { pubJwk: persisted.pubJwk, privJwk: persisted.privJwk }
  }
  return {}
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

function generateEphemeralNick(): string {
  const random = crypto.getRandomValues(new Uint32Array(1))[0]
  return `par-${(random % 0xffff).toString(16).padStart(4, '0')}`
}

/** RF-01 — nickname changes are announced to every peer of every room. */
export function setNickname(nickname: string): void {
  const nick = nickname.trim()
  if (nick === '') return
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
    void connection.actions.presence.send(payload)
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
    recordRecentRoom(normalized)
    return publicViewOf(existing)
  }

  await ensureSessionIdentity()

  // Trystero config (§6.3): appId always; custom trackers/ICE replace the
  // defaults only when the user configured them (RF-07).
  const config: JoinRoomConfig = { appId: APP_ID }
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

  recordRecentRoom(normalized)
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

/** All active connections (UI/debug snapshot). */
export function getActiveRooms(): RoomConnection[] {
  return [...connections.values()].map(publicViewOf)
}

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
      connection.pendingChats.push(wire)
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

/** M1 debug-panel alias over the real send path (removed in M6). */
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
  const state = useAppStore.getState()
  state.ensureDmChannel(peerId, peer.nickname, peer.fingerprint)
  state.setActiveView({ kind: 'dm', peerId })
  refreshDmAvailability()
  return true
}

/**
 * RF-04/§9.2 — encrypts `text` for `peerId` and broadcasts the `dm`
 * Envelope (broadcast with `to`; non-recipients discard, §7.1). Returns the
 * envelope, or null when there is no identity, the peer is unavailable
 * (no shared room), its key is unknown, or the text exceeds the 4000-char
 * protocol limit (§7.3).
 */
export function sendDm(peerId: string, text: string): Promise<Envelope | null> {
  const identity = sessionIdentity
  const state = useAppStore.getState()
  const channel = state.dms[peerId]
  if (identity === null) return Promise.resolve(null)
  if (channel === undefined || !channel.available) return Promise.resolve(null)
  if (text.length > MAX_PLAINTEXT_LENGTH) return Promise.resolve(null)

  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) return Promise.resolve(null)

  const peerRawKey = shared.peerKeys.get(peerId) as Uint8Array
  const theirFp = shared.peerKeyFps.get(peerId)
  if (theirFp === undefined) return Promise.resolve(null)

  return getCachedDmKey(
    identity.keypair.privateKey,
    peerRawKey,
    identity.identity.fingerprint,
    theirFp,
  )
    .then((key) => encryptDm(key, text))
    .then((sealed) => {
      const envelope = createEnvelope({
        from: trysteroSelfId,
        nick: identity.identity.nickname,
        kind: 'dm',
        to: peerId,
        enc: true,
        iv: sealed.iv,
        body: sealed.payload,
      })
      safeSend(shared.actions.dm, envelope)
      const nick = channel.peerNick !== '' ? channel.peerNick : peerId
      useAppStore.getState().ensureDmChannel(peerId, nick, theirFp)
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
    })
    .catch(() => null)
}

/** §7.1 — DM typing signal, directed at the peer and flagged `dm`. */
export function sendDmTyping(peerId: string, on: boolean): void {
  const shared = [...connections.values()].find((entry) => entry.peerKeys.has(peerId))
  if (shared === undefined) return
  safeSend(shared.actions.typing, { on, dm: true } satisfies TypingPayload, { target: peerId })
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
  void connection.actions.ping.send({ t }, { target: peerId })
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
    seenIds: new Set<string>(),
    peerKeys: new Map<string, Uint8Array>(),
    peerKeyFps: new Map<string, string>(),
    announcedPeers: new Set<string>(),
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
    // The fingerprint derived from the peer's `keys` action is the trusted
    // one (§9.1): a diverging presence fingerprint never overwrites it and
    // nothing is logged (§7.3 silence).
    const patch: Partial<Peer> = { nickname: payload.nick }
    if (!connection.peerKeyFps.has(peerId)) patch.fingerprint = payload.fp
    useAppStore.getState().updatePeer(connection.roomId, peerId, patch)
    // RF-06 — the first presence announcement of a peer becomes a discrete
    // system feed line; later ones are nickname changes and stay silent.
    if (!connection.announcedPeers.has(peerId) && payload.nick.trim() !== '') {
      connection.announcedPeers.add(peerId)
      appendSystemMessage(connection.roomId, joinSystemLine(payload.nick))
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
        useAppStore.getState().updatePeer(connection.roomId, peerId, { fingerprint })
        // Refresh the DM header fingerprint of an existing channel (RF-04);
        // channels are only created on demand (open/send/receive).
        if (useAppStore.getState().dms[peerId] !== undefined) {
          useAppStore.getState().ensureDmChannel(peerId, '', fingerprint)
        }
      }
    })
  }

  actions.chat.onMessage = (data, context) => {
    handleChatEnvelope(connection, data, context.peerId)
  }

  actions.dm.onMessage = (data, context) => {
    handleDmEnvelope(connection, data, context.peerId)
  }

  actions.typing.onMessage = (payload, { peerId }) => {
    if (typeof payload?.on !== 'boolean') return
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
    void connection.actions.pong.send({ t: payload.t } satisfies PongPayload, {
      target: peerId,
    })
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
    void connection.actions.presence.send(
      { nick: identity.identity.nickname, fp: identity.identity.fingerprint },
      { target: peerId },
    )
    void connection.actions.keys.send(identity.rawPublicKey, { target: peerId })
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
  // nickname, before the peer entry is dropped.
  const room = useAppStore.getState().rooms[connection.roomId]
  const nickname = room?.peers.find((peer) => peer.id === peerId)?.nickname
  if (nickname !== undefined && nickname.trim() !== '') {
    appendSystemMessage(connection.roomId, leaveSystemLine(nickname))
  }
  connection.peerKeys.delete(peerId)
  connection.peerKeyFps.delete(peerId)
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
    appendRoomChat(connection, envelope, senderId, text, false)
  } catch {
    appendRoomChat(connection, envelope, senderId, ENCRYPTED_MESSAGE_PLACEHOLDER, true)
  }
  queueReceipt(connection, senderId, envelope.id)
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

function handleDmEnvelope(
  connection: RoomInternals,
  data: unknown,
  transportPeerId: string,
): void {
  const envelope = parseEnvelope(data)
  if (envelope === null || envelope.kind !== 'dm') return
  if (filterDmForSelf(envelope, trysteroSelfId) === null) return
  if (!shouldProcess(envelope, connection.seenIds)) return
  if (!envelope.enc || envelope.iv === null) return

  const identity = sessionIdentity
  const peerRawKey = connection.peerKeys.get(transportPeerId)
  // §9.2 — the sender's raw public key must be known; otherwise the payload
  // is undecryptable and is discarded silently (§7.3).
  if (identity === null || peerRawKey === undefined) return

  const senderFp =
    connection.peerKeyFps.get(transportPeerId) ?? null
  void decryptDmEnvelope(connection, envelope, transportPeerId, peerRawKey, senderFp)
}

/** Async tail of the DM receive path: derive → decrypt → store. */
async function decryptDmEnvelope(
  connection: RoomInternals,
  envelope: Envelope,
  senderId: string,
  peerRawKey: Uint8Array,
  senderFp: string | null,
): Promise<void> {
  const identity = sessionIdentity
  if (identity === null) return
  const theirFp = senderFp ?? (await computeFingerprint(peerRawKey))
  try {
    const key = await getCachedDmKey(
      identity.keypair.privateKey,
      peerRawKey,
      identity.identity.fingerprint,
      theirFp,
    )
    const text = await decryptDm(key, { iv: envelope.iv ?? '', payload: envelope.body })
    const state = useAppStore.getState()
    state.ensureDmChannel(senderId, envelope.nick, theirFp)
    state.appendDmMessage(senderId, {
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
  pongListeners.clear()
  dmListeners.clear()
  clearDmKeyCache()
  sessionIdentity = null
  identityPromise = null
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAppStore.setState({ ...INITIAL_APP_STATE })
}
