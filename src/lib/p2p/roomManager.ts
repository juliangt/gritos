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
  type Message,
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
import { computeFingerprint, createSessionIdentity, type SessionIdentity } from '../crypto/identity'
import { pushRecentRoom, saveRecentRooms } from '../recentRooms'
import { joinSystemLine, leaveSystemLine } from '../feed'

/**
 * The single Trystero surface of the app (plan.md §3 architecture rules:
 * only this module may import trystero). Multi-room core — spec §6.3/§6.5:
 * a Map<roomId, RoomConnection>; each connection encapsulates its Trystero
 * room, its 8 registered actions (§7.1) and its status heuristic, and feeds
 * the Zustand store (§8.1).
 *
 * dm/keys full crypto lands in M3: the actions are already registered,
 * received raw public keys are kept in memory per peer, and dm payloads are
 * protocol-filtered (foreign recipients discard) and then ignored until M3.
 * M2 adds the outgoing chat path (sendChat with a local queue while the
 * room is not connected, §10.3), debounced receipt batching (§7.1), the
 * typing send, system feed lines for joins/leaves (RF-06) and the
 * recent-rooms recording (§8.2 `gritos:rooms`).
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
  readonly trystero: TrysteroRoom
  readonly actions: RoomActions
  /** Per-room dedup window — spec §7.3. */
  readonly seenIds: Set<string>
  /** Raw ECDH public keys per peer, in memory only (consumed in M3). */
  readonly peerKeys: Map<string, Uint8Array>
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
 * Lazily creates the ephemeral session identity (M2: keys stay ephemeral;
 * the profile persists). Idempotent — StrictMode double-mounts and
 * concurrent callers share the same identity. When the store already holds
 * an identity (restored from `gritos:identity` by the onboarding/boot
 * hooks), its nickname/fingerprint/createdAt are adopted so what is
 * announced over the wire matches what the UI and localStorage hold.
 */
export function ensureSessionIdentity(nickname?: string): Promise<SessionIdentity> {
  if (sessionIdentity !== null) return Promise.resolve(sessionIdentity)
  if (identityPromise === null) {
    const storedIdentity = useAppStore.getState().identity
    const nick =
      storedIdentity?.nickname ??
      (nickname !== undefined && nickname.trim() !== '' ? nickname.trim() : generateEphemeralNick())
    identityPromise = createSessionIdentity(nick).then((created) => {
      const identity = storedIdentity ?? created.identity
      sessionIdentity = { ...created, identity }
      useAppStore.getState().setIdentity(identity)
      return sessionIdentity
    })
  }
  return identityPromise
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
  const connection = createConnection({
    roomId,
    name: normalized,
    password,
    hasPassword: password !== undefined,
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
  if (connection.status !== 'connected') {
    connection.pendingChats.push(envelope)
  } else {
    safeSend(connection.actions.chat, envelope)
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
    status: init.status,
    trystero: trysteroRoom,
    actions,
    seenIds: new Set<string>(),
    peerKeys: new Map<string, Uint8Array>(),
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
    useAppStore
      .getState()
      .updatePeer(connection.roomId, peerId, { nickname: payload.nick, fingerprint: payload.fp })
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
        useAppStore.getState().updatePeer(connection.roomId, peerId, { fingerprint })
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
    if (payload.on) {
      useAppStore.getState().setTyping(connection.roomId, peerId, Date.now())
      ensureTypingSweeper(connection)
    } else {
      useAppStore.getState().setTyping(connection.roomId, peerId, null)
    }
  }

  actions.receipt.onMessage = (payload) => {
    if (!validateReceipt(payload)) return
    useAppStore.getState().markMessagesDelivered(connection.roomId, payload.ids)
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
  connection.announcedPeers.delete(peerId)
  useAppStore.getState().removePeer(connection.roomId, peerId)
  useAppStore.getState().setTyping(connection.roomId, peerId, null)

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
  if (envelope.enc) return // password-room ciphertext is decrypted in M4
  if (!shouldProcess(envelope, connection.seenIds)) return

  const message: Message = {
    id: envelope.id,
    roomId: connection.roomId,
    authorId: transportPeerId,
    authorNick: envelope.nick,
    text: envelope.body,
    ts: envelope.ts,
    encrypted: false,
    status: 'delivered',
    kind: 'user',
  }
  useAppStore.getState().appendMessage(connection.roomId, message)

  // §6.4 step 2 — receipt directed to the author (debounced, ≤50 ids).
  queueReceipt(connection, transportPeerId, envelope.id)
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
  _transportPeerId: string,
): void {
  const envelope = parseEnvelope(data)
  if (envelope === null || envelope.kind !== 'dm') return
  if (filterDmForSelf(envelope, trysteroSelfId) === null) return
  if (!shouldProcess(envelope, connection.seenIds)) return
  // E2EE consumption lands in M3: addressed DMs are intentionally ignored.
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
    const room = useAppStore.getState().rooms[connection.roomId]
    if (room === undefined || Object.keys(room.typing).length === 0) {
      if (connection.typingTimer !== null) {
        clearInterval(connection.typingTimer)
        connection.typingTimer = null
      }
    }
  }, 1_000)
}

function teardownConnection(connection: RoomInternals): void {
  disarmErrorHeuristic(connection)
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
  sessionIdentity = null
  identityPromise = null
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useAppStore.setState({ ...INITIAL_APP_STATE })
}
