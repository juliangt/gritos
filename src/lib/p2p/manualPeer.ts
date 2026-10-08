import {
  DM_PROTOCOL_VERSION,
  MAX_PLAINTEXT_LENGTH,
  MAX_RECEIPT_BATCH,
  BoundedSeenIds,
  createEnvelope,
  parseEnvelope,
  shouldProcess,
  validateReceipt,
  type Envelope,
} from './protocol'
import {
  base64ToBytes,
  bytesToBase64,
  canonicalFingerprint,
  decryptDm,
  encryptDm,
  getCachedDmKeyV2,
} from '../crypto/dm'
import { computeFingerprint, type SessionIdentity } from '../crypto/identity'
import type { EphemeralSession } from '../crypto/sessionEphemeral'

/**
 * Trackerless 1:1 DM engine — spec.md §12.2 (issue #97): a direct WebRTC
 * DataChannel established by manually exchanging two self-contained invite
 * blobs (copy/paste; no trackers, no signaling server, no relay). Everything
 * above the transport is reused intact from the room path: DM envelopes
 * `v: DM_PROTOCOL_VERSION` sealed with the §9.2 v2 derivation (dual salt
 * over BOTH fingerprint pairs), ✓/✓✓ receipts, typing flags and the
 * freshness window + dedup of §7.3. The manual peers share no swarm, so the
 * blob exchange plays Trystero's signaling role and this module plays the
 * roomManager role.
 *
 * Blob format (§12.2): `{v, role: 'invite'|'answer', nick?, fp, idKey,
 * ephKey, sdp:{type, sdp}}` JSON → standard base64 (decoding tolerates the
 * whitespace a clipboard adds). Both public keys of the author travel INSIDE
 * the blob — the protocol is closed in two pastes, with no clear-text phase
 * over the data channel. The receiver validates BEFORE touching the network:
 * known `v`, role coherent with the SDP type (`invite`⇔offer,
 * `answer`⇔answer), 65-byte keys, and the fingerprint RECOMPUTED from the
 * raw identity key — a blob whose `fp` does not match SHA-256(`idKey`) is
 * rejected as corrupted or tampered; a missing or malformed `ephKey`
 * invalidates the whole blob. There is no legacy-peer degradation (§12.1):
 * the v2 capability is announced by the blob itself.
 *
 * Non-trickle ICE (§12.2): the blob is produced only when candidate
 * gathering completes, guarded by a 5 s timer that emits the current
 * `localDescription` as-is — mDNS host candidates usually resolve fast, and
 * a stale srflx candidate is better than never emitting; there is no
 * signaling channel to receive late candidates through.
 *
 * Architecture rule (§12.2, mirror of the roomManager rule): components
 * never touch WebRTC — `RTCPeerConnection` may only appear in this file.
 * Testability mirrors roomManager too: the constructor sits behind the
 * injectable `setPeerConnectionFactory` seam, so tests drive the engine
 * with a fake peer pair and no real WebRTC. Headless by design: no React,
 * no store — the engine reports through callbacks and exposes the remote
 * fingerprint; the DmChannel wiring is a later phase of the issue.
 */

/** Blob format version (§12.2) — independent of the envelope's `v` (§7.2). */
export const MANUAL_BLOB_VERSION = 1

/** §12.2 — ICE gathering guard: emits the partial SDP when it fires. */
export const ICE_GATHER_GUARD_MS = 5_000

/**
 * §12.2 — establishment guard, the 15 s heuristic of §10.3 (same value as
 * roomManager's ERROR_HEURISTIC_MS; deliberately NOT imported: importing
 * roomManager would drag Trystero and the stores into this module's graph).
 * Armed at the earliest moment establishment can actually progress on each
 * side — role A when the answer is applied, role B when the data channel is
 * announced — so the waits owned by the humans (handing the blob over)
 * carry no clock timeout, only cancellation (§12.2).
 */
export const CONNECT_GUARD_MS = 15_000

/**
 * §7.1 — receiver receipts are batched with this debounce before sending.
 * Same value as roomManager's RECEIPT_DEBOUNCE_MS (not imported, see the
 * CONNECT_GUARD_MS note).
 */
export const RECEIPT_DEBOUNCE_MS = 300

/** Uncompressed ECDH P-256 public key: 0x04 ‖ X ‖ Y = 65 bytes (§9.1). */
export const RAW_PUBLIC_KEY_LENGTH = 65

/** Data channel label; carries JSON text frames only (§12.2). */
const DATA_CHANNEL_LABEL = 'gritos-dm'

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Why `parseManualBlob` rejected a blob (§12.2 validation order). */
export type ManualBlobErrorReason =
  | 'encoding' // not base64 / not JSON / not an object
  | 'version' // unknown `v`
  | 'role' // unknown role, or incoherent with the SDP type
  | 'keys' // idKey/ephKey missing, malformed or not exactly 65 bytes
  | 'fingerprint' // `fp` does not match SHA-256(idKey) — corrupt or tampered
  | 'sdp' // missing/malformed SDP shape

export class ManualBlobError extends Error {
  readonly reason: ManualBlobErrorReason

  constructor(reason: ManualBlobErrorReason, message: string) {
    super(message)
    this.name = 'ManualBlobError'
    this.reason = reason
  }
}

/** Why the engine refused an operation (state machine + guards + sends). */
export type ManualPeerErrorCode =
  | 'illegal-transition' // the pasted blob or action does not fit the state
  | 'bad-blob' // a blob was pasted into the wrong role slot
  | 'fingerprint-mismatch' // §12.2: explicit reject, never a silent channel
  | 'connect-timeout' // the 15 s establishment guard fired
  | 'not-connected' // nothing is ever sent before `connected` (DTLS + E2EE)
  | 'too-long' // above the 4000-char protocol limit (§7.3)

export class ManualPeerError extends Error {
  readonly code: ManualPeerErrorCode

  constructor(code: ManualPeerErrorCode, message: string) {
    super(message)
    this.name = 'ManualPeerError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Blob encode / decode (pure, §12.2)
// ---------------------------------------------------------------------------

export type ManualBlobRole = 'invite' | 'answer'

/**
 * The decoded, fully validated blob. `fingerprint` and `ephFingerprint` are
 * RECOMPUTED from the raw keys — never read from the wire (the blob carries
 * no ephemeral fingerprint at all).
 */
export interface ParsedManualBlob {
  role: ManualBlobRole
  /** Display nickname from the blob; advisory, never verified (§12.2). */
  nick: string
  /** Identity fingerprint, display form, recomputed from `idKey`. */
  fingerprint: string
  /** Raw 65-byte identity public key (§9.1). */
  idKey: Uint8Array
  /** Raw 65-byte session-ephemeral public key (§9.2). */
  ephKey: Uint8Array
  /** Fingerprint recomputed from `ephKey` — feeds the v2 derivation only. */
  ephFingerprint: string
  sdp: { type: 'offer' | 'answer'; sdp: string }
}

interface RawManualBlob {
  v?: unknown
  role?: unknown
  nick?: unknown
  fp?: unknown
  idKey?: unknown
  ephKey?: unknown
  sdp?: unknown
}

/** Everything a blob carries besides its role. */
export interface ManualBlobFields {
  nick?: string
  fingerprint: string
  idKey: Uint8Array
  ephKey: Uint8Array
  sdp: { type: 'offer' | 'answer'; sdp: string }
}

/**
 * Shared wire encoding (§12.2): the fields JSON-serialized (UTF-8 safe —
 * the nickname may be non-ASCII) and standard-base64'd. `createInviteBlob`
 * and `createAnswerBlob` are the only writers.
 */
function encodeManualBlob(role: ManualBlobRole, fields: ManualBlobFields): string {
  const wire: Record<string, unknown> = {
    v: MANUAL_BLOB_VERSION,
    role,
    fp: fields.fingerprint,
    idKey: bytesToBase64(fields.idKey),
    ephKey: bytesToBase64(fields.ephKey),
    sdp: { type: fields.sdp.type, sdp: fields.sdp.sdp },
  }
  if (fields.nick !== undefined) wire.nick = fields.nick
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(wire)))
}

/** Role A's blob: an offer plus both public keys (§12.2). Pure. */
export function createInviteBlob(fields: ManualBlobFields): string {
  return encodeManualBlob('invite', fields)
}

/** Role B's blob: an answer plus both public keys (§12.2). Pure. */
export function createAnswerBlob(fields: ManualBlobFields): string {
  return encodeManualBlob('answer', fields)
}

function decodeRawKey(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new ManualBlobError('keys', `Clave ausente o malformada: ${field}`)
  }
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(value)
  } catch {
    throw new ManualBlobError('keys', `Clave con base64 inválido: ${field}`)
  }
  if (bytes.length !== RAW_PUBLIC_KEY_LENGTH) {
    throw new ManualBlobError('keys', `Clave de longitud incorrecta: ${field}`)
  }
  return bytes
}

/**
 * Full validation of a pasted blob, BEFORE any network touch (§12.2): the
 * order below is the spec's — encoding, version, role coherence, keys,
 * fingerprint recomputation, SDP shape. Rejects with `ManualBlobError`.
 * Async because the fingerprint check is a SHA-256 over Web Crypto.
 */
export async function parseManualBlob(text: string): Promise<ParsedManualBlob> {
  let raw: RawManualBlob
  try {
    // Clipboard whitespace and line wraps are tolerated (§12.2).
    const json = new TextDecoder().decode(base64ToBytes(text.replace(/\s+/g, '')))
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ManualBlobError('encoding', 'El blob no es un objeto JSON')
    }
    raw = parsed as RawManualBlob
  } catch (error) {
    if (error instanceof ManualBlobError) throw error
    throw new ManualBlobError('encoding', 'El blob no es base64/JSON válido')
  }

  if (raw.v !== MANUAL_BLOB_VERSION) {
    throw new ManualBlobError('version', `Versión de blob desconocida: ${String(raw.v)}`)
  }
  if (raw.role !== 'invite' && raw.role !== 'answer') {
    throw new ManualBlobError('role', `Rol de blob desconocido: ${String(raw.role)}`)
  }
  const role: ManualBlobRole = raw.role

  const idKey = decodeRawKey(raw.idKey, 'idKey')
  const ephKey = decodeRawKey(raw.ephKey, 'ephKey')

  // §12.2 — the anchor check: the claimed fingerprint must match the one
  // recomputed from the raw identity key, compared in canonical form so the
  // display spacing/case of the paste is irrelevant. The recomputed display
  // value is what the engine exposes downstream.
  const recomputed = await computeFingerprint(idKey)
  if (
    typeof raw.fp !== 'string' ||
    canonicalFingerprint(raw.fp) !== canonicalFingerprint(recomputed)
  ) {
    throw new ManualBlobError('fingerprint', 'La huella no coincide con la clave de identidad')
  }

  // Role ⇔ SDP type coherence (§12.2: invite⇔offer, answer⇔answer).
  const sdp = raw.sdp as Partial<{ type: unknown; sdp: unknown }> | null | undefined
  const expectedType = role === 'invite' ? 'offer' : 'answer'
  if (
    typeof sdp !== 'object' ||
    sdp === null ||
    sdp.type !== expectedType ||
    typeof sdp.sdp !== 'string' ||
    sdp.sdp === ''
  ) {
    throw new ManualBlobError('role', `El SDP no es coherente con el rol ${role}`)
  }
  const description = sdp.sdp

  const ephFingerprint = await computeFingerprint(ephKey)
  return {
    role,
    nick: typeof raw.nick === 'string' ? raw.nick : '',
    fingerprint: recomputed,
    idKey,
    ephKey,
    ephFingerprint,
    sdp: { type: expectedType, sdp: description },
  }
}

// ---------------------------------------------------------------------------
// Connection factory seam (mirror of setJoinRoomFactory)
// ---------------------------------------------------------------------------

/**
 * Factory signature: receives the RTCConfiguration the engine resolved from
 * its `iceServers` option (undefined = browser defaults, mirroring the room
 * path where an empty user list never replaces Trystero's defaults).
 */
export type PeerConnectionFactory = (config: RTCConfiguration | undefined) => RTCPeerConnection

function defaultPeerConnectionFactory(config: RTCConfiguration | undefined): RTCPeerConnection {
  return new RTCPeerConnection(config)
}

let peerConnectionImpl: PeerConnectionFactory = defaultPeerConnectionFactory

/**
 * Dependency-injection seam: replaces the RTCPeerConnection constructor so
 * tests (and only tests) drive the engine with a fake peer pair. null
 * restores the real implementation.
 */
export function setPeerConnectionFactory(factory: PeerConnectionFactory | null): void {
  peerConnectionImpl = factory ?? defaultPeerConnectionFactory
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * States exactly as §12.2 — role A (invite): `idle → invite-ready →
 * answer-pasted → connected`; role B (answer): `idle → invite-pasted →
 * answer-ready → connected`. Terminal states: `failed` (a machine guard
 * fired), `disconnected` (the link dropped after connecting — the «El par
 * se ha desconectado» state; history is the store's concern), `closed`
 * (`cancel()`/`dispose()`). Blobs are single-use and reconnection always
 * needs a fresh blob exchange, so every terminal state means: new engine
 * instance for a new exchange.
 */
export type ManualPeerState =
  | 'idle'
  | 'invite-ready'
  | 'answer-pasted'
  | 'invite-pasted'
  | 'answer-ready'
  | 'connected'
  | 'failed'
  | 'disconnected'
  | 'closed'

/** Callbacks the engine reports through; the store/UI wiring is phase 3. */
export interface ManualPeerCallbacks {
  /** Every state transition; `error` carries the guard failure detail. */
  onStateChange?: (state: ManualPeerState, error?: ManualPeerError) => void
  /** A DM opened and decrypted: the wire envelope plus its plaintext. */
  onDmMessage?: (envelope: Envelope, text: string) => void
  /** The peer's typing flag (same semantics as room DM typing, §7.1). */
  onTyping?: (on: boolean) => void
  /** The peer's ✓✓ receipt batch (§7.1 validated `ids`). */
  onReceipt?: (ids: string[]) => void
}

export interface ManualPeerEngineOptions {
  role: ManualBlobRole
  /** §9.1 identity: the TOFU anchor — announces `idKey`/`fp` in the blob. */
  session: SessionIdentity
  /** §9.2 session-ephemeral pair — announces `ephKey`, holds the ECDH key. */
  ephemeral: EphemeralSession
  callbacks?: ManualPeerCallbacks
  /**
   * User-configured ICE servers (settings); empty/undefined keeps the
   * browser defaults. The caller passes them — the engine never reads the
   * settings store (headless, no store imports).
   */
  iceServers?: RTCIceServer[]
  /** Guard overrides — tests only; defaults are the exported constants. */
  iceGatherGuardMs?: number
  connectGuardMs?: number
}

/**
 * One manual DM exchange. Owns exactly one RTCPeerConnection and one data
 * channel; speaks the §12.2 wire framing — JSON text frames, one message
 * per frame: `{"action": "dm"|"typing"|"receipt", "payload": …}`.
 *
 * Addressing without a Trystero peerId: envelope `from`/`to` carry the
 * canonical identity fingerprints (the channel is keyed by fingerprint per
 * §12.2), so the receive path filters foreign `to` values exactly like the
 * room path's `filterDmForSelf`.
 */
export class ManualPeerEngine {
  readonly role: ManualBlobRole
  private readonly session: SessionIdentity
  private readonly ephemeral: EphemeralSession
  private readonly callbacks: ManualPeerCallbacks
  private readonly iceServers: RTCIceServer[]
  private readonly iceGatherGuardMs: number
  private readonly connectGuardMs: number

  private state: ManualPeerState = 'idle'
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private remote: ParsedManualBlob | null = null
  private keyPromise: Promise<CryptoKey> | null = null
  /** §7.3 dedup window of the manual path — same cap as the room routes. */
  private readonly seenIds = new BoundedSeenIds()
  private pendingReceipts: string[] = []
  private receiptTimer: ReturnType<typeof setTimeout> | null = null
  private gatherTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  /** Rejector of an in-flight `waitForLocalDescription` — cancel()/dispose(). */
  private gatherAbort: ((error: ManualPeerError) => void) | null = null

  constructor(options: ManualPeerEngineOptions) {
    this.role = options.role
    this.session = options.session
    this.ephemeral = options.ephemeral
    this.callbacks = options.callbacks ?? {}
    this.iceServers = options.iceServers ?? []
    this.iceGatherGuardMs = options.iceGatherGuardMs ?? ICE_GATHER_GUARD_MS
    this.connectGuardMs = options.connectGuardMs ?? CONNECT_GUARD_MS
  }

  /** Current state of the §12.2 machine. */
  get currentState(): ManualPeerState {
    return this.state
  }

  /**
   * The peer's identity fingerprint (display form, recomputed from its raw
   * key), or null before a peer blob has been validated. This is what the
   * UI phase displays and what TOFU pins under `manual:` (§12.2) — the
   * ephemeral fingerprint is never displayed (§12.1).
   */
  get remoteFingerprint(): string | null {
    return this.remote?.fingerprint ?? null
  }

  /** Advisory nickname from the peer's blob; never verified (§12.2). */
  get remoteNick(): string | null {
    return this.remote?.nick ?? null
  }

  // -- Role A (invite): idle → invite-ready ---------------------------------

  /**
   * Creates the offer and produces the invite blob (§12.2). Resolves with
   * the base64 blob only after candidate gathering completes (or the 5 s
   * guard emits the partial SDP). Illegal from any state but `idle`; the
   * PC/channel of a previous exchange never survive a terminal state (new
   * engine required), so `idle` here means a pristine one.
   */
  async createInvite(): Promise<string> {
    if (this.role !== 'invite') {
      throw new ManualPeerError('illegal-transition', 'Solo el rol «invite» crea invitaciones')
    }
    this.assertState('idle')
    const pc = this.createPeerConnection()
    this.attachChannel(pc.createDataChannel(DATA_CHANNEL_LABEL))
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const description = await this.waitForLocalDescription(pc)
    this.assertNotTerminal()
    const blob = createInviteBlob({
      nick: this.session.identity.nickname,
      fingerprint: this.session.identity.fingerprint,
      idKey: this.session.rawPublicKey,
      ephKey: this.ephemeral.rawPublicKey,
      sdp: { type: description.type as 'offer', sdp: description.sdp },
    })
    this.enter('invite-ready')
    return blob
  }

  /**
   * Validates and applies B's answer: `invite-ready → answer-pasted`.
   * Rejections (bad blob, foreign answer, fingerprint mismatch) throw and
   * LEAVE the state at `invite-ready` with the PC untouched — the paste can
   * be corrected and retried; the machine only moves to `failed` on its own
   * guard timeouts. `expectedPeerFingerprint` (optional) is the out-of-band
   * comparison anchor: a mismatching answer is rejected with an explicit
   * error and never opens a channel (§12.2).
   */
  async acceptAnswer(text: string, options?: { expectedPeerFingerprint?: string }): Promise<void> {
    if (this.role !== 'invite') {
      throw new ManualPeerError('illegal-transition', 'Solo el rol «invite» acepta respuestas')
    }
    this.assertState('invite-ready')
    const parsed = await this.parsePeerBlob(text, 'answer')
    if (
      options?.expectedPeerFingerprint !== undefined &&
      canonicalFingerprint(options.expectedPeerFingerprint) !==
        canonicalFingerprint(parsed.fingerprint)
    ) {
      throw new ManualPeerError(
        'fingerprint-mismatch',
        'La huella de la respuesta no coincide con la esperada',
      )
    }
    this.remote = parsed
    const pc = this.requirePeerConnection()
    await pc.setRemoteDescription({ type: parsed.sdp.type, sdp: parsed.sdp.sdp })
    this.assertNotTerminal()
    this.deriveSharedKey(parsed)
    this.enter('answer-pasted')
    this.armConnectGuard()
  }

  // -- Role B (answer): idle → invite-pasted → answer-ready -----------------

  /**
   * Validates A's invite, applies it and produces the answer blob:
   * `idle → invite-pasted → answer-ready`. Resolves with the base64 blob
   * after gathering completes (same 5 s guard). Rejections leave the state
   * at `idle` with no PC created — the paste can be corrected and retried.
   */
  async acceptInvite(text: string): Promise<string> {
    if (this.role !== 'answer') {
      throw new ManualPeerError('illegal-transition', 'Solo el rol «answer» acepta invitaciones')
    }
    this.assertState('idle')
    const parsed = await this.parsePeerBlob(text, 'invite')
    this.remote = parsed
    const pc = this.createPeerConnection()
    await pc.setRemoteDescription({ type: parsed.sdp.type, sdp: parsed.sdp.sdp })
    this.assertNotTerminal()
    this.deriveSharedKey(parsed)
    this.enter('invite-pasted')
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    const description = await this.waitForLocalDescription(pc)
    this.assertNotTerminal()
    const blob = createAnswerBlob({
      nick: this.session.identity.nickname,
      fingerprint: this.session.identity.fingerprint,
      idKey: this.session.rawPublicKey,
      ephKey: this.ephemeral.rawPublicKey,
      sdp: { type: description.type as 'answer', sdp: description.sdp },
    })
    this.enter('answer-ready')
    return blob
  }

  // -- Connected-channel surface ---------------------------------------------

  /**
   * Seals `text` with the v2 key (same derivation as the room path, cached
   * in the shared session cache) and sends the `dm` frame. THROWS before
   * `connected` or above the 4000-char limit — a single-use manual channel
   * has no §10.3 queue to hide behind (deliberate deviation from rooms).
   * Returns the wire envelope so the caller can echo it as its own message.
   */
  async sendDm(text: string, ttl?: number): Promise<Envelope> {
    this.assertConnected()
    if (text.length > MAX_PLAINTEXT_LENGTH) {
      throw new ManualPeerError(
        'too-long',
        `El mensaje supera el límite de ${MAX_PLAINTEXT_LENGTH} caracteres`,
      )
    }
    const key = await this.requireKey()
    const sealed = await encryptDm(key, text)
    const envelope = createEnvelope({
      from: this.selfId(),
      nick: this.session.identity.nickname,
      kind: 'dm',
      to: this.remoteId(),
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
      v: DM_PROTOCOL_VERSION,
      ...(ttl !== undefined ? { ttl } : {}),
    })
    this.sendFrame('dm', envelope)
    return envelope
  }

  /**
   * §7.1 DM typing (every typing on this channel is a DM typing). Best
   * effort: silently ignored while not connected, never queued.
   */
  sendTyping(on: boolean): void {
    if (this.state !== 'connected') return
    this.sendFrame('typing', { on, dm: true })
  }

  // -- Teardown ---------------------------------------------------------------

  /**
   * Cancels from any waiting state (§12.2): closes the PC and channel,
   * frees every timer and lands on the terminal `closed`. Idempotent.
   */
  cancel(): void {
    this.teardown('closed')
  }

  /**
   * Full teardown — same mechanics as `cancel()` (they are the same
   * terminal path; the UI phase may call this on unmount or on identity
   * regeneration, RF-07). Idempotent.
   */
  dispose(): void {
    this.teardown('closed')
  }

  // -- Internals ---------------------------------------------------------------

  private selfId(): string {
    return canonicalFingerprint(this.session.identity.fingerprint)
  }

  private remoteId(): string {
    const remote = this.remote
    if (remote === null) throw new ManualPeerError('not-connected', 'No hay par validado')
    return canonicalFingerprint(remote.fingerprint)
  }

  private assertState(expected: ManualPeerState): void {
    if (this.state !== expected) {
      throw new ManualPeerError(
        'illegal-transition',
        `Se esperaba el estado «${expected}», hay «${this.state}»`,
      )
    }
  }

  /**
   * Post-await guard for the handshake methods: cancel()/dispose() may run
   * while an await is in flight, and the continuation must never clobber a
   * terminal state (a cancelled session stays cancelled).
   */
  private assertNotTerminal(): void {
    if (this.state === 'failed' || this.state === 'disconnected' || this.state === 'closed') {
      throw new ManualPeerError('illegal-transition', `La sesión ya terminó en «${this.state}»`)
    }
  }

  private assertConnected(): void {
    if (this.state !== 'connected' || this.channel?.readyState !== 'open') {
      throw new ManualPeerError('not-connected', 'El canal manual no está conectado')
    }
  }

  private enter(state: ManualPeerState, error?: ManualPeerError): void {
    this.state = state
    this.callbacks.onStateChange?.(state, error)
  }

  private createPeerConnection(): RTCPeerConnection {
    // Non-empty user list replaces the browser defaults (room-path rule,
    // RF-07); copies keep the caller's array untouched.
    const config =
      this.iceServers.length > 0
        ? { iceServers: this.iceServers.map((s) => ({ ...s })) }
        : undefined
    const pc = peerConnectionImpl(config)
    pc.oniceconnectionstatechange = () => this.handleIceStateChange(pc)
    pc.onconnectionstatechange = () => this.handleConnectionStateChange(pc)
    if (this.role === 'answer') {
      pc.ondatachannel = (event) => this.attachChannel(event.channel)
    }
    this.pc = pc
    return pc
  }

  private requirePeerConnection(): RTCPeerConnection {
    const pc = this.pc
    if (pc === null) throw new ManualPeerError('illegal-transition', 'No hay conexión activa')
    return pc
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel
    channel.onopen = () => this.handleChannelOpen()
    channel.onclose = () => this.handleChannelClosed()
    channel.onmessage = (event) => this.handleFrame(event.data)
  }

  /**
   * Non-trickle ICE (§12.2): resolves with the final `localDescription`
   * once gathering completes, or with the partial one when the 5 s guard
   * fires (documented above — mDNS candidates usually resolve fast, and an
   * incomplete srflx set beats never emitting a blob).
   */
  private waitForLocalDescription(pc: RTCPeerConnection): Promise<RTCSessionDescription> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve(pc.localDescription!)
    return new Promise((resolve, reject) => {
      const finish = (description: RTCSessionDescription): void => {
        if (this.gatherTimer !== null) {
          clearTimeout(this.gatherTimer)
          this.gatherTimer = null
        }
        pc.onicegatheringstatechange = null
        this.gatherAbort = null
        resolve(description)
      }
      this.gatherAbort = reject
      this.gatherTimer = setTimeout(() => {
        this.gatherTimer = null
        finish(pc.localDescription!)
      }, this.iceGatherGuardMs)
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') finish(pc.localDescription!)
      }
    })
  }

  /**
   * The 15 s establishment guard (§12.2, §10.3 heuristic). Armed at the
   * earliest moment establishment can progress: A applies the answer, B
   * receives the data channel announce. The human waits (handing the blob
   * over) never arm it — they have cancellation only.
   */
  private armConnectGuard(): void {
    if (this.connectTimer !== null) return
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null
      if (
        this.state === 'answer-pasted' ||
        this.state === 'invite-pasted' ||
        this.state === 'answer-ready'
      ) {
        this.teardown(
          'failed',
          new ManualPeerError('connect-timeout', 'La conexión no se estableció a tiempo'),
        )
      }
    }, this.connectGuardMs)
  }

  private disarmConnectGuard(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private handleChannelOpen(): void {
    this.disarmConnectGuard()
    if (
      this.state === 'answer-pasted' ||
      this.state === 'invite-pasted' ||
      this.state === 'answer-ready'
    ) {
      this.enter('connected')
    }
  }

  /** §12.2 — a drop after connecting lands on «El par se ha desconectado». */
  private handleChannelClosed(): void {
    if (this.state === 'connected') {
      this.teardown('disconnected')
    }
  }

  private handleIceStateChange(pc: RTCPeerConnection): void {
    if (
      this.state === 'connected' &&
      (pc.iceConnectionState === 'failed' ||
        pc.iceConnectionState === 'disconnected' ||
        pc.iceConnectionState === 'closed')
    ) {
      this.teardown('disconnected')
    } else if (
      this.role === 'answer' &&
      (this.state === 'invite-pasted' || this.state === 'answer-ready') &&
      pc.iceConnectionState !== 'new'
    ) {
      // B's establishment started (A's candidates are flowing): the machine
      // wait begins, so the 15 s guard arms here — never during the human
      // wait for A to paste the answer.
      this.armConnectGuard()
    }
  }

  private handleConnectionStateChange(pc: RTCPeerConnection): void {
    if (
      this.state === 'connected' &&
      (pc.connectionState === 'failed' || pc.connectionState === 'closed')
    ) {
      this.teardown('disconnected')
    }
  }

  /**
   * Derives and caches the shared key the moment both blobs are known —
   * the SAME §9.2 v2 derivation as the room path, through the SAME session
   * cache (`getCachedDmKeyV2`): ECDH over the ephemeral pairs, dual salt
   * over all four canonical fingerprints. The identity pair never ECDHs;
   * it anchors the salt (and the TOFU display).
   */
  private deriveSharedKey(remote: ParsedManualBlob): void {
    if (this.keyPromise !== null) return
    this.keyPromise = getCachedDmKeyV2(
      this.ephemeral.keypair.privateKey,
      remote.ephKey,
      this.session.identity.fingerprint,
      remote.fingerprint,
      this.ephemeral.fingerprint,
      remote.ephFingerprint,
    )
    this.keyPromise.catch(() => {
      // Derivation cannot honestly fail with validated 65-byte keys; keep
      // the rejection from surfacing as unhandled before a send/receive.
    })
  }

  private async requireKey(): Promise<CryptoKey> {
    const key = this.keyPromise
    if (key === null)
      throw new ManualPeerError('not-connected', 'La clave compartida no está derivada')
    return key
  }

  private sendFrame(action: 'dm' | 'typing' | 'receipt', payload: unknown): void {
    const channel = this.channel
    if (channel === null || channel.readyState !== 'open') return
    try {
      channel.send(JSON.stringify({ action, payload }))
    } catch {
      // Channel closed mid-flight (peer dropped): best-effort send policy.
    }
  }

  /** One JSON text frame per message (§12.2 framing); junk frames die here. */
  private handleFrame(data: unknown): void {
    if (typeof data !== 'string' || this.state !== 'connected') return
    let frame: { action?: unknown; payload?: unknown }
    try {
      const parsed: unknown = JSON.parse(data)
      if (typeof parsed !== 'object' || parsed === null) return
      frame = parsed as { action?: unknown; payload?: unknown }
    } catch {
      return
    }
    if (frame.action === 'dm') this.handleDmFrame(frame.payload)
    else if (frame.action === 'typing') this.handleTypingFrame(frame.payload)
    else if (frame.action === 'receipt') this.handleReceiptFrame(frame.payload)
  }

  /** Room-path parity: parse → self filter → freshness+dedup → decrypt. */
  private handleDmFrame(payload: unknown): void {
    const envelope = parseEnvelope(payload)
    // The parser only lets v2 dms through (§12.1): the manual path has no
    // legacy degradation at all — the blob announced the v2 capability.
    if (envelope === null || envelope.kind !== 'dm') return
    if (envelope.to !== this.selfId()) return
    // Issue #19 freshness window (MAX_ENVELOPE_AGE_MS, reused through
    // `shouldProcess`) BEFORE dedup: a stale replay has zero side effects.
    if (!shouldProcess(envelope, this.seenIds)) return
    if (!envelope.enc || envelope.iv === null) return

    void this.decryptAndSurface(envelope)
  }

  private async decryptAndSurface(envelope: Envelope): Promise<void> {
    try {
      const key = await this.requireKey()
      const text = await decryptDm(key, { iv: envelope.iv ?? '', payload: envelope.body })
      // Same §21 discipline as the room path: the send-side cap only binds
      // honest clients; over-limit plaintexts die with zero side effects.
      if (text.length > MAX_PLAINTEXT_LENGTH) return
      this.callbacks.onDmMessage?.(envelope, text)
      // ✓✓ — the debounced receipt answers the transport, not readability.
      this.queueReceipt(envelope.id)
    } catch {
      // Wrong key, tampered tag or malformed payload (§7.3): silent discard.
    }
  }

  private handleTypingFrame(payload: unknown): void {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { on?: unknown }).on !== 'boolean'
    ) {
      return
    }
    this.callbacks.onTyping?.((payload as { on: boolean }).on)
  }

  private handleReceiptFrame(payload: unknown): void {
    if (!validateReceipt(payload)) return
    this.callbacks.onReceipt?.([...payload.ids])
  }

  /** §7.1 — receipt ids are debounced (RECEIPT_DEBOUNCE_MS) and flushed in
   * batches of at most MAX_RECEIPT_BATCH, exactly like the room routes. */
  private queueReceipt(id: string): void {
    this.pendingReceipts.push(id)
    if (this.receiptTimer === null) {
      this.receiptTimer = setTimeout(() => {
        this.receiptTimer = null
        this.flushReceipts()
      }, RECEIPT_DEBOUNCE_MS)
    }
  }

  private flushReceipts(): void {
    const ids = this.pendingReceipts
    this.pendingReceipts = []
    while (ids.length > 0) {
      this.sendFrame('receipt', { ids: ids.splice(0, MAX_RECEIPT_BATCH) })
    }
  }

  /**
   * Single teardown path for cancel/dispose/guard-failure/drop: transport
   * closed, handlers detached (the fake PCs in tests assert on this), every
   * timer freed, terminal state entered. The derived key and the remote
   * identity stay readable on `remoteFingerprint` — the «desconectado»
   * display and the TOFU pin belong to later phases, keyed by fingerprint.
   */
  private teardown(state: 'failed' | 'disconnected' | 'closed', error?: ManualPeerError): void {
    this.disarmConnectGuard()
    if (this.gatherTimer !== null) {
      clearTimeout(this.gatherTimer)
      this.gatherTimer = null
    }
    // A handshake await parked in the gather wait must not hang forever.
    const abort = this.gatherAbort
    this.gatherAbort = null
    abort?.(new ManualPeerError('illegal-transition', 'La espera de recogida ICE fue cancelada'))
    if (this.receiptTimer !== null) {
      clearTimeout(this.receiptTimer)
      this.receiptTimer = null
    }
    this.pendingReceipts = []
    const channel = this.channel
    this.channel = null
    if (channel !== null) {
      channel.onopen = null
      channel.onclose = null
      channel.onmessage = null
      try {
        channel.close()
      } catch {
        // Fakes may not implement close; the detachment above is the point.
      }
    }
    const pc = this.pc
    this.pc = null
    if (pc !== null) {
      pc.oniceconnectionstatechange = null
      pc.onconnectionstatechange = null
      pc.ondatachannel = null
      try {
        pc.close()
      } catch {
        // Same policy as the channel above.
      }
    }
    this.enter(state, error)
  }

  private parsePeerBlob(text: string, expected: ManualBlobRole): Promise<ParsedManualBlob> {
    return parseManualBlob(text).then((parsed) => {
      if (parsed.role !== expected) {
        throw new ManualPeerError(
          'bad-blob',
          `Se esperaba un blob «${expected}», no «${parsed.role}»`,
        )
      }
      return parsed
    })
  }
}
