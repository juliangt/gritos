import { sealChunk, openChunk } from '../crypto/chunkCipher'
import { REMOTE_NICK_INVISIBLE_PATTERN } from '../nickname'
import type { TransferKeyContext } from './roomManager'

/**
 * P2P file-transfer engine — spec.md §12.4 (issue #103, phase 3), the
 * headless state machine behind the five §7.1 file actions (`file-meta`,
 * binary `file-chunk`, `file-ack`, `file-end`, `file-abort`). The ACTIONS
 * are registered by roomManager's `createConnection` (§12.4's registration
 * note) and its handlers are thin shims that gather the per-connection
 * context (mute gate, room key, directed sends) into a `FileTransferHost`
 * and delegate here — this module is the ONLY place that knows about
 * credits, framing, caps and the transfer state machine.
 *
 * Scope (§12.4, binding contract): STRICTLY directed 1:1 — the sender
 * offers to one peer; only an explicit acceptance (the first `file-ack`)
 * lets a single byte flow. A room-wide file is N independent transfers.
 * Broadcast is rejected by design (consent + mesh amplification).
 *
 * Roles:
 *
 * - SENDER (`sendFileTransfer`): validates and caps locally, resolves the
 *   conversation key through the roomManager's `resolveTransferKey` (room
 *   transfer: sealed iff a room key exists; DM: always sealed — a null key
 *   REFUSES, never downgrades), sends the clear `file-meta` offer and then
 *   paces `file-chunk`s under the receiver's credit window, slicing the
 *   `File` with `File.slice()` per chunk (the whole file is NEVER loaded).
 *   Terminal states surface through the returned `settled` promise and the
 *   record map.
 * - RECEIVER (the `handleFile*` shims): validates the offer (§12.4's
 *   `parseFileMeta` contract), records it and notifies the `onFileOffer`
 *   seam — NOTHING else flows until `acceptFileTransfer` grants the first
 *   credit window. Chunks are framed (`8 B fileId ‖ uint32 BE seq ‖
 *   payload`), unsealed when `meta.enc` (room key first, then the DM key —
 *   the one §12.4 ambiguity: the wire cannot distinguish a password-room
 *   transfer from a DM transfer riding the same swarm, and GCM
 *   authentication disambiguates safely), accumulated under the hard
 *   `MAX_FILE_BYTES` cap, and assembled into a Blob + revocable object URL
 *   on completion.
 *
 * Flow control (§12.4): the receiver owns the window — its FIRST
 * `file-ack {id, nextSeq: 1, grant: 8}` IS the acceptance; every data ack
 * re-grants the full `FILE_CREDIT_WINDOW`; the sender never holds more than
 * `FILE_CREDIT_WINDOW` unacknowledged chunks in flight; the final
 * `{id, nextSeq: chunks + 1, grant: 0}` completes the transfer. A chunk
 * beyond the granted credit is DISCARDED (the window is the receiver's
 * memory plan); the 30 s no-progress stall fails both ends. `file-end` is
 * the sender's "last chunk dispatched" signal — the receiver uses it to
 * fail fast when chunks went missing instead of waiting out the stall.
 *
 * Memory and revocation (§12.4): everything lives in THIS module's
 * session-scoped maps — `transferRecords` (the `fileOffers` map keyed
 * `${peerId}:${meta.id}` Phase 4 renders from) plus the in-flight
 * sessions. Nothing persists: no localStorage, no IndexedDB, no TTL, no
 * FIFO interplay. URLs are revoked on abort/failure, by
 * `revokeTransferUrl` (the explicit card dismissal), on panic (RF-08) and
 * on identity regeneration (the §12.2 seam, wired in roomManager).
 *
 * Chunk storms: `file-chunk` frames are NOT envelope ids and bypass the
 * BoundedSeenIds dedup on purpose — they are bounded by the credit window
 * (≤ 8 in flight), the per-seq range/duplicate checks and the exact
 * `chunks` count, and a violating peer only burns its own transfer into
 * the 30 s stall. The rate-capped, deduped JSON plane (meta/ack/end/abort)
 * stays cheap.
 *
 * Testability: the engine never imports Trystero or the roomManager at
 * runtime — everything room-specific arrives through the host interface —
 * so the fake Trystero transport drives it end to end.
 */

// ---------------------------------------------------------------------------
// Constants (§12.4 — the binding numbers; do not tune without the spec)
// ---------------------------------------------------------------------------

/** §12.4 — hard receiver cap: meta over it is invalid, streams over it die. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024

/**
 * §12.4 — cleartext slice per chunk in BOTH modes (16 KiB − 28 B of GCM
 * IV+tag), so `chunks` never depends on the mode and a sealed payload lands
 * at exactly ≤ 16 KiB.
 */
export const FILE_CHUNK_PAYLOAD_BYTES = 16_356

/** §12.4 — at most this many unacknowledged chunks in flight. */
export const FILE_CREDIT_WINDOW = 8

/** §12.4 — no progress at all for this long in `transferring` → failed. */
export const FILE_STALL_TIMEOUT_MS = 30_000

/** §12.4 — at most this many concurrent transfers per peer, BOTH sides. */
export const MAX_TRANSFERS_PER_PEER = 3

/** §12.4 — a legit file name is longer than a nickname: its own cap. */
export const FILE_NAME_MAX_LENGTH = 120

/** §12.4 — display-only mime string cap. */
export const FILE_MIME_MAX_LENGTH = 100

/** §12.4 — at most this many `file-meta` offers per peer per minute. */
export const FILE_OFFER_RATE_CAP = 5

/** Rolling window over which FILE_OFFER_RATE_CAP applies. */
export const FILE_OFFER_RATE_WINDOW_MS = 60_000

/** §12.4 — fileId length: the SHA-256 of the meta id, truncated. */
export const FILE_ID_BYTES = 8

/** §12.4 — frame header: 8 B fileId ‖ uint32 BE seq. */
export const FILE_FRAME_HEADER_BYTES = FILE_ID_BYTES + 4

/**
 * §12.4 — sealed payload cap post-GCM: the plaintext slice plus the fixed
 * 28-byte seal overhead (12 B IV + 16 B tag).
 */
export const FILE_CHUNK_SEALED_MAX_BYTES = FILE_CHUNK_PAYLOAD_BYTES + 28

/** §12.4 — total frame cap: header + max sealed payload (≤ 16 396 B). */
export const FILE_FRAME_MAX_BYTES = FILE_FRAME_HEADER_BYTES + FILE_CHUNK_SEALED_MAX_BYTES

// ---------------------------------------------------------------------------
// Wire shapes (§7.1 / §12.4)
// ---------------------------------------------------------------------------

/**
 * The `file-meta` offer — the only wire form of the five whose fields travel
 * CLEAR (§12.4: same exposure as presence nicks; only the CONTENT is
 * sealed). `enc` is required, `chunks` is exact (`ceil(size /
 * FILE_CHUNK_PAYLOAD_BYTES)`), `name`/`mime` are sanitized at the boundary.
 *
 * Wire payload types are `type` aliases, not interfaces, so they satisfy
 * Trystero's `DataPayload` (JSON-value index signature) constraint — the
 * protocol.ts convention.
 */
export type FileMeta = {
  /** Non-empty string — the transfer id on both ends (sender: randomUUID). */
  readonly id: string
  /** Sanitized display name (never used for filesystem access). */
  readonly name: string
  /** Exact byte size, 1..MAX_FILE_BYTES. */
  readonly size: number
  /** Display-only mime hint ('' when unknown); never a permission. */
  readonly mime: string
  /** Exact chunk count — the receiver recomputes and rejects drifts. */
  readonly chunks: number
  /** Required boolean: whether chunks travel GCM-sealed. */
  readonly enc: boolean
}

/** §7.1 — receiver credit: everything before `nextSeq` arrived contiguously. */
export type FileAckPayload = {
  id: string
  nextSeq: number
  grant: number
}

/** §7.1 — sender's "last chunk dispatched" close signal. */
export type FileEndPayload = { id: string }

/** §7.1 — cancel from either party, or an explicit offer rejection. */
export type FileAbortPayload = { id: string }

/** The five §12.4 actions, in registration/reading order. */
export type FileActionName = 'file-meta' | 'file-chunk' | 'file-ack' | 'file-end' | 'file-abort'

// ---------------------------------------------------------------------------
// Records and states (the §12.4 `fileOffers` map, memory-only)
// ---------------------------------------------------------------------------

/** Canonical per-transfer machine (§12.4); `rejected` branches off `offer`. */
export type FileTransferState =
  'offer' | 'accepted' | 'transferring' | 'done' | 'aborted' | 'rejected' | 'failed'

export type FileTransferDirection = 'send' | 'receive'

/**
 * Why a transfer hit `failed`. `completeness` covers both a byte-sum
 * mismatch at assembly and the file-end fail-fast with missing chunks.
 */
export type FileFailureReason =
  | 'stall'
  | 'peer-drop'
  | 'room-gone'
  | 'size-limit'
  | 'bad-frame'
  | 'crypto'
  | 'completeness'
  | 'identity-regenerated'

/** What Phase 4 renders the consent/progress card from — one transfer. */
export interface FileTransferRecord {
  /** `${peerId}:${meta.id}` — the §12.4 map key. */
  readonly key: string
  /** Swarm the transfer rides (a DM transfer rides the shared room's). */
  readonly roomId: string
  /** The REMOTE peer — counterpart of the transfer. */
  readonly peerId: string
  readonly direction: FileTransferDirection
  readonly meta: FileMeta
  state: FileTransferState
  /** Chunks acked (sender) or contiguously received (receiver). */
  transferred: number
  /** Receiver-only: the object URL minted on `done`; revoked via revokeTransferUrl. */
  url: string | null
  /** Set iff state === 'failed'. */
  failureReason: FileFailureReason | null
}

/** States that count against MAX_TRANSFERS_PER_PEER and keep machinery alive. */
const ACTIVE_STATES: ReadonlySet<FileTransferState> = new Set(['offer', 'accepted', 'transferring'])

// ---------------------------------------------------------------------------
// Host interface — everything room-specific, injected by roomManager
// ---------------------------------------------------------------------------

/**
 * The per-connection context roomManager hands to every handler call (and
 * registers for the send path): the mute gate stays roomManager's (it owns
 * the keys-derived fingerprint maps), the key resolution delegates to its
 * `resolveTransferKey`, and sends ride ITS connection's five file actions
 * directed at the peer. Deliberately narrow so the engine stays
 * transport-agnostic and testable.
 */
export interface FileTransferHost {
  readonly roomId: string
  /** Room key promise, or null for public rooms (live getter on the connection). */
  readonly roomKey: Promise<CryptoKey> | null
  isConnected(): boolean
  hasPeer(peerId: string): boolean
  /** Issue #95 mute gate — roomManager drops BEFORE any parse; this is the
   * engine-side view used by the mid-transfer mute abort. */
  isPeerMuted(peerId: string): boolean
  resolveKey(ctx: TransferKeyContext): Promise<CryptoKey | null>
  /** Directed, best-effort send of one file action over this connection. */
  send(action: FileActionName, data: unknown, target: string): void
}

// ---------------------------------------------------------------------------
// Module state — memory-only, session lifetime (§12.4)
// ---------------------------------------------------------------------------

/** The §12.4 `fileOffers` map, keyed `${peerId}:${meta.id}` — never persisted. */
const transferRecords = new Map<string, FileTransferRecord>()

/** In-flight machinery per active record; deleted on every terminal state. */
interface TransferSession {
  readonly record: FileTransferRecord
  readonly role: 'sender' | 'receiver'
  readonly host: FileTransferHost
  readonly fileIdPromise: Promise<Uint8Array>
  /** Resolved `fileIdPromise` cache (receiver prefix matching). */
  fileIdBytes: Uint8Array | null
  /** Receiver: serializes per-chunk processing (decryptions settle out of
   * order — the recoveredChain/sendChain discipline, receive direction). */
  recvChain: Promise<void>
  /** Sender: the File handle (dropped at terminal states). */
  file: File | null
  /** Sender: sealing key; null when meta.enc is false (public room). */
  sealKey: CryptoKey | null
  /** Sender: highest seq dispatched. */
  lastSent: number
  /** Sender: every seq < ackedThrough is acknowledged. */
  ackedThrough: number
  /** Sender: file-end dispatched once after the last chunk. */
  fileEndSent: boolean
  /** Sender: pump loop guard. */
  pumping: boolean
  /** Receiver: plaintext slices, indexed seq-1; null once terminal. */
  parts: (Uint8Array | null)[] | null
  /** Receiver: sum of stored plaintext bytes (the hard-cap meter). */
  receivedBytes: number
  /** Receiver: next expected seq (contiguous discipline). */
  contiguousNext: number
  /** Receiver: credits granted but not yet consumed by stored chunks. */
  creditsOutstanding: number
  /** Receiver: key that opened the first chunk (cached for the stream). */
  openKey: CryptoKey | null
  stallTimer: ReturnType<typeof setTimeout> | null
  /** Sender: resolves the caller's settled promise at the terminal state. */
  settle: ((terminal: FileTransferState) => void) | null
  /** Sender: the caller's optional progress callback. */
  onProgress: ((transferred: number, total: number) => void) | null
}

const sessions = new Map<string, TransferSession>()

/** Live hosts per room — registered by createConnection, dropped on teardown. */
const hosts = new Map<string, FileTransferHost>()

/** Rolling FILE_OFFER_RATE_CAP budgets per `roomId\0peerId`, freed on teardown. */
const offerTimes = new Map<string, number[]>()

// ---------------------------------------------------------------------------
// Listener seams — Phase 4 (and tests) subscribe; the engine stays headless
// ---------------------------------------------------------------------------

export type FileOfferListener = (roomId: string, peerId: string, meta: FileMeta) => void
export type FileProgressListener = (
  roomId: string,
  peerId: string,
  id: string,
  transferred: number,
  total: number,
) => void
export type FileDoneListener = (
  roomId: string,
  peerId: string,
  meta: FileMeta,
  url: string | null,
) => void
export type FileAbortListener = (roomId: string, peerId: string, id: string) => void
export type FileFailedListener = (
  roomId: string,
  peerId: string,
  id: string,
  reason: FileFailureReason,
) => void

const offerListeners = new Set<FileOfferListener>()
const progressListeners = new Set<FileProgressListener>()
const doneListeners = new Set<FileDoneListener>()
const abortListeners = new Set<FileAbortListener>()
const failedListeners = new Set<FileFailedListener>()

/** Subscribes to validated incoming offers; returns the unsubscribe function. */
export function onFileOffer(listener: FileOfferListener): () => void {
  offerListeners.add(listener)
  return () => {
    offerListeners.delete(listener)
  }
}

/** Subscribes to per-chunk progress (both directions); returns the unsubscribe. */
export function onFileProgress(listener: FileProgressListener): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

/** Subscribes to `done` transfers (receiver: url minted; sender: url null). */
export function onFileDone(listener: FileDoneListener): () => void {
  doneListeners.add(listener)
  return () => {
    doneListeners.delete(listener)
  }
}

/** Subscribes to aborted/rejected transfers; returns the unsubscribe. */
export function onFileAbort(listener: FileAbortListener): () => void {
  abortListeners.add(listener)
  return () => {
    abortListeners.delete(listener)
  }
}

/** Subscribes to failed transfers (with the reason); returns the unsubscribe. */
export function onFileFailed(listener: FileFailedListener): () => void {
  failedListeners.add(listener)
  return () => {
    failedListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The §12.4 map key of a transfer. */
export function transferKeyOf(peerId: string, metaId: string): string {
  return `${peerId}:${metaId}`
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * §12.4 — the 8-byte frame prefix: first 8 bytes of the SHA-256 of the meta
 * id (UTF-8). The hash spreads 64 uniform bits where an 8-char hex truncation
 * of the UUID string would leave ~32 — collision-negligible under the
 * ≤ 3-concurrent-transfers-per-peer cap, and the receiver additionally only
 * matches the prefix against ITS active transfers of that peer.
 */
async function computeFileId(metaId: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(metaId) as BufferSource,
  )
  return new Uint8Array(digest).slice(0, FILE_ID_BYTES)
}

/**
 * §12.4 — file names get the remote-nickname discipline (issue #28 class:
 * control/invisible characters stripped, trimmed) with the file-specific
 * 120-char cap (a legit file name is longer than a nickname). Names carry
 * no path semantics — blobs are memory-only — so path separators stay;
 * only unusable (control/invisible-only) names invalidate the meta.
 * Returns null when nothing legible remains (the name IS the consent card).
 */
export function sanitizeFileName(name: string): string | null {
  const cleaned = name.replace(REMOTE_NICK_INVISIBLE_PATTERN, '').trim()
  if (cleaned === '') return null
  return cleaned.slice(0, FILE_NAME_MAX_LENGTH)
}

/**
 * §12.4 — mimes get the same character class; the result is display-only
 * and never gates anything. Over-length mimes invalidate the meta on the
 * receive path (senders cap their own).
 */
export function sanitizeMime(mime: string): string {
  return mime.replace(REMOTE_NICK_INVISIBLE_PATTERN, '')
}

/**
 * §12.4 `parseFileMeta` — the file-meta validation contract. Any violation
 * drops the WHOLE payload silently (§7.3): id non-empty; name sanitized and
 * non-empty (it is the consent card); size an integer 1..MAX_FILE_BYTES;
 * chunks EXACTLY ceil(size / FILE_CHUNK_PAYLOAD_BYTES) — the count is
 * recomputed here, not trusted from the wire; mime ≤ 100 clean chars (''
 * legitimate); enc a REQUIRED boolean with no default. Returns the
 * normalized meta (sanitized name/mime) or null.
 */
export function parseFileMeta(raw: unknown): FileMeta | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null
  if (typeof candidate.name !== 'string') return null
  const name = sanitizeFileName(candidate.name)
  if (name === null) return null
  if (typeof candidate.size !== 'number' || !Number.isInteger(candidate.size)) return null
  if (candidate.size < 1 || candidate.size > MAX_FILE_BYTES) return null
  if (typeof candidate.mime !== 'string') return null
  const mime = sanitizeMime(candidate.mime)
  if (mime.length > FILE_MIME_MAX_LENGTH) return null
  if (typeof candidate.enc !== 'boolean') return null
  const expectedChunks = Math.ceil(candidate.size / FILE_CHUNK_PAYLOAD_BYTES)
  if (candidate.chunks !== expectedChunks) return null
  return {
    id: candidate.id,
    name,
    size: candidate.size,
    mime,
    chunks: expectedChunks,
    enc: candidate.enc,
  }
}

/** Expected plaintext length of one seq (the last chunk carries the tail). */
function expectedChunkLength(seq: number, meta: FileMeta): number {
  return seq < meta.chunks
    ? FILE_CHUNK_PAYLOAD_BYTES
    : meta.size - FILE_CHUNK_PAYLOAD_BYTES * (meta.chunks - 1)
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function clearStallTimer(session: TransferSession): void {
  if (session.stallTimer !== null) {
    clearTimeout(session.stallTimer)
    session.stallTimer = null
  }
}

/** Arms the §12.4 stall: 30 s without progress in `transferring` → failed. */
function armStallTimer(session: TransferSession): void {
  clearStallTimer(session)
  session.stallTimer = setTimeout(() => {
    session.stallTimer = null
    if (session.record.state === 'transferring') {
      transitionTerminal(session, 'failed', 'stall', { notifyPeer: true })
    }
  }, FILE_STALL_TIMEOUT_MS)
}

function countActiveForPeer(peerId: string): number {
  let count = 0
  for (const record of transferRecords.values()) {
    if (record.peerId === peerId && ACTIVE_STATES.has(record.state)) count += 1
  }
  return count
}

interface TerminalOptions {
  /** Best-effort `file-abort` to the peer (peer-drop/room-gone skip it). */
  readonly notifyPeer?: boolean
}

/**
 * The single terminal-state funnel: clears timers, releases the sender's
 * File handle and the receiver's accumulated buffers, notifies the peer
 * when asked, resolves the caller's settled promise, deletes the session
 * machinery and fires the matching seam. Records stay in the map (the card
 * awaits its explicit dismissal via revokeTransferUrl — §12.4).
 */
function transitionTerminal(
  session: TransferSession,
  state: Exclude<FileTransferState, 'offer' | 'accepted' | 'transferring'>,
  reason: FileFailureReason | null,
  options: TerminalOptions = {},
): void {
  const record = session.record
  if (!ACTIVE_STATES.has(record.state)) return
  clearStallTimer(session)
  record.state = state
  record.failureReason = state === 'failed' ? reason : null
  // Release the big buffers immediately — the §12.4 "liberación inmediata".
  session.file = null
  session.parts = null
  if (options.notifyPeer === true) {
    session.host.send(
      'file-abort',
      { id: record.meta.id } satisfies FileAbortPayload,
      record.peerId,
    )
  }
  const settle = session.settle
  sessions.delete(record.key)
  const { roomId, peerId, meta } = record
  if (state === 'done') {
    for (const listener of doneListeners) listener(roomId, peerId, meta, record.url)
  } else if (state === 'failed') {
    for (const listener of failedListeners)
      listener(roomId, peerId, meta.id, reason as FileFailureReason)
  } else {
    for (const listener of abortListeners) listener(roomId, peerId, meta.id)
  }
  settle?.(state)
}

/** Receiver-side assembly: Blob from the stored plaintext slices + object URL. */
function assembleReceiverBlob(session: TransferSession): string {
  const parts = (session.parts ?? []) as Uint8Array[]
  const blob = new Blob(parts as BlobPart[], {
    type: session.record.meta.mime !== '' ? session.record.meta.mime : 'application/octet-stream',
  })
  session.parts = null
  return URL.createObjectURL(blob)
}

function emitProgress(session: TransferSession): void {
  const { roomId, peerId, meta, transferred } = session.record
  for (const listener of progressListeners)
    listener(roomId, peerId, meta.id, transferred, meta.chunks)
  session.onProgress?.(session.record.transferred, session.record.meta.chunks)
}

// ---------------------------------------------------------------------------
// SENDER — sendFileTransfer and the credit-paced pump
// ---------------------------------------------------------------------------

export type SendFileRefusal =
  | 'unknown-room'
  | 'not-connected'
  | 'peer-not-in-room'
  | 'invalid-file'
  | 'file-too-big'
  | 'name-required'
  | 'concurrency-cap'
  | 'dm-key-unavailable'
  | 'key-resolution-failed'

/** Terminal states a sender's settled promise can resolve with. */
export type SendFileTerminalState = 'done' | 'aborted' | 'rejected' | 'failed'

export type SendFileOutcome =
  | {
      readonly ok: true
      readonly id: string
      readonly key: string
      /** Resolves when the transfer reaches a terminal state. */
      readonly settled: Promise<SendFileTerminalState>
    }
  | { readonly ok: false; readonly reason: SendFileRefusal }

/**
 * SENDER entry (§12.4 phase 3) — validates locally, resolves the
 * conversation key, sends the clear `file-meta` offer and returns. The
 * transfer then runs by itself: the first `file-ack` from `peerId` is the
 * acceptance, chunks flow credit-paced, and `settled` resolves at the
 * terminal state (`done` = final ack received; `aborted` = cancel or peer
 * abort; `rejected` = offer refused via file-abort; `failed` = stall or
 * peer drop). The whole file is NEVER loaded: chunks are `File.slice()`d
 * (and GCM-sealed when enc) one at a time.
 *
 * `kind` selects the conversation whose key seals the chunks — `room` uses
 * the shared room's key (public room → enc=false, the DTLS-only mode that
 * Phase 4 warns about pre-send), `dm` is ALWAYS sealed: the shared room in
 * `roomId` is only the swarm; a null DM key REFUSES the transfer instead of
 * downgrading to cleartext (§12.4, fail closed).
 *
 * `onProgress(ackedChunks, totalChunks)` fires per cumulative ack advance.
 * Local refusals return `{ok: false, reason}` before anything hits the wire.
 */
export async function sendFileTransfer(
  roomId: string,
  peerId: string,
  file: File,
  kind: 'room' | 'dm',
  onProgress?: (transferred: number, total: number) => void,
): Promise<SendFileOutcome> {
  const host = hosts.get(roomId)
  if (host === undefined) return { ok: false, reason: 'unknown-room' }
  if (!host.isConnected()) return { ok: false, reason: 'not-connected' }
  if (!host.hasPeer(peerId)) return { ok: false, reason: 'peer-not-in-room' }
  if (!Number.isInteger(file.size) || file.size < 1) return { ok: false, reason: 'invalid-file' }
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: 'file-too-big' }
  const name = sanitizeFileName(file.name)
  if (name === null) return { ok: false, reason: 'name-required' }
  const mime = sanitizeMime(file.type).slice(0, FILE_MIME_MAX_LENGTH)
  if (countActiveForPeer(peerId) >= MAX_TRANSFERS_PER_PEER) {
    return { ok: false, reason: 'concurrency-cap' }
  }

  let sealKey: CryptoKey | null
  let enc: boolean
  try {
    if (kind === 'dm') {
      sealKey = await host.resolveKey({ kind: 'dm', peerId })
      if (sealKey === null) return { ok: false, reason: 'dm-key-unavailable' }
      enc = true
    } else {
      // Rejections propagate out of resolveTransferKey (fail closed) — a
      // broken key state must never downgrade a transfer to cleartext.
      sealKey = await host.resolveKey({ kind: 'room', roomId })
      enc = sealKey !== null
    }
  } catch {
    return { ok: false, reason: 'key-resolution-failed' }
  }

  const chunks = Math.ceil(file.size / FILE_CHUNK_PAYLOAD_BYTES)
  // randomUUID collisions are negligible; the loop only guards the map key.
  let id = crypto.randomUUID()
  while (transferRecords.has(transferKeyOf(peerId, id))) {
    id = crypto.randomUUID()
  }

  const meta: FileMeta = { id, name, size: file.size, mime, chunks, enc }
  const key = transferKeyOf(peerId, id)
  const record: FileTransferRecord = {
    key,
    roomId,
    peerId,
    direction: 'send',
    meta,
    state: 'offer',
    transferred: 0,
    url: null,
    failureReason: null,
  }
  let resolveSettled: ((terminal: SendFileTerminalState) => void) | null = null
  const settled = new Promise<SendFileTerminalState>((resolve) => {
    resolveSettled = resolve
  })
  const session: TransferSession = {
    record,
    role: 'sender',
    host,
    fileIdPromise: computeFileId(id),
    fileIdBytes: null,
    recvChain: Promise.resolve(),
    file,
    sealKey,
    lastSent: 0,
    ackedThrough: 0,
    fileEndSent: false,
    pumping: false,
    parts: null,
    receivedBytes: 0,
    contiguousNext: 1,
    creditsOutstanding: 0,
    openKey: null,
    stallTimer: null,
    settle: resolveSettled,
    onProgress: onProgress ?? null,
  }
  transferRecords.set(key, record)
  sessions.set(key, session)
  host.send('file-meta', meta, peerId)
  return { ok: true, id, key, settled }
}

/**
 * Sender pump — dispatches chunks while the §12.4 invariant holds
 * (`sent − acked ≤ FILE_CREDIT_WINDOW`), slicing, (sealing,) framing and
 * sending one chunk at a time; dispatches `file-end` right after the last
 * chunk (it is the "last chunk DISPATCHED" signal, not an ack barrier).
 * The guard keeps one loop alive even when acks land mid-await.
 */
function pumpSender(session: TransferSession): void {
  if (session.pumping) return
  session.pumping = true
  void (async () => {
    try {
      while (session.record.state === 'transferring') {
        const meta = session.record.meta
        const allowedThrough = session.ackedThrough - 1 + FILE_CREDIT_WINDOW
        if (session.lastSent >= meta.chunks || session.lastSent >= allowedThrough) break
        const seq = session.lastSent + 1
        const file = session.file
        if (file === null) break
        const start = (seq - 1) * FILE_CHUNK_PAYLOAD_BYTES
        const plain = new Uint8Array(
          await file
            .slice(start, Math.min(start + FILE_CHUNK_PAYLOAD_BYTES, meta.size))
            .arrayBuffer(),
        )
        const payload = session.sealKey !== null ? await sealChunk(session.sealKey, plain) : plain
        const fileId = session.fileIdBytes ?? (await session.fileIdPromise)
        session.fileIdBytes = fileId
        session.host.send('file-chunk', buildFrame(fileId, seq, payload), session.record.peerId)
        session.lastSent = seq
        if (seq === meta.chunks && !session.fileEndSent) {
          session.fileEndSent = true
          session.host.send(
            'file-end',
            { id: meta.id } satisfies FileEndPayload,
            session.record.peerId,
          )
        }
      }
    } catch {
      // Slice/seal failure (not expected for real Files): fail the transfer
      // instead of leaving the receiver waiting on the stall.
      if (ACTIVE_STATES.has(session.record.state)) {
        transitionTerminal(session, 'failed', 'crypto', { notifyPeer: true })
      }
    } finally {
      session.pumping = false
    }
  })()
}

function buildFrame(fileId: Uint8Array, seq: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FILE_FRAME_HEADER_BYTES + payload.length)
  frame.set(fileId, 0)
  new DataView(frame.buffer).setUint32(FILE_ID_BYTES, seq, false)
  frame.set(payload, FILE_FRAME_HEADER_BYTES)
  return frame
}

// ---------------------------------------------------------------------------
// RECEIVER — accept/decline and the chunk pipeline
// ---------------------------------------------------------------------------

/**
 * RECEIVER consent (§12.4) — grants the first credit window; the ack
 * `{id, nextSeq: 1, grant: FILE_CREDIT_WINDOW}` IS the acceptance and
 * starts the flow. False for an unknown key, a non-offer record, or an
 * outgoing transfer (senders cannot accept their own offer).
 */
export async function acceptFileTransfer(transferKey: string): Promise<boolean> {
  const session = sessions.get(transferKey)
  if (session === undefined || session.role !== 'receiver') return false
  if (session.record.state !== 'offer') return false
  session.record.state = 'accepted'
  session.record.state = 'transferring'
  session.creditsOutstanding = FILE_CREDIT_WINDOW
  const fileId = session.fileIdBytes ?? (await session.fileIdPromise)
  session.fileIdBytes = fileId
  armStallTimer(session)
  session.host.send(
    'file-ack',
    { id: session.record.meta.id, nextSeq: 1, grant: FILE_CREDIT_WINDOW } satisfies FileAckPayload,
    session.record.peerId,
  )
  return true
}

/**
 * RECEIVER decline (§12.4 `rejected` branch) — answers the offer with an
 * explicit `file-abort` so the sender's UI can say "refused" instead of
 * waiting. False when the key does not point at a pending incoming offer.
 */
export function declineFileTransfer(transferKey: string): boolean {
  const session = sessions.get(transferKey)
  if (session === undefined || session.role !== 'receiver') return false
  if (session.record.state !== 'offer') return false
  session.record.state = 'rejected'
  clearStallTimer(session)
  session.host.send(
    'file-abort',
    { id: session.record.meta.id } satisfies FileAbortPayload,
    session.record.peerId,
  )
  sessions.delete(transferKey)
  for (const listener of abortListeners) {
    listener(session.record.roomId, session.record.peerId, session.record.meta.id)
  }
  return true
}

/**
 * Local cancel, either role, any active state — sends `file-abort` to the
 * peer (§12.4: "ambos con file-abort al otro lado"), discards the
 * receiver's partial buffers and leaves the record terminal. Sender
 * settled promises resolve 'aborted'.
 */
export function cancelFileTransfer(transferKey: string): boolean {
  const session = sessions.get(transferKey)
  if (session === undefined) return false
  transitionTerminal(session, 'aborted', null, { notifyPeer: true })
  return true
}

/**
 * Revokes the record's object URL and drops the record (the §12.4 explicit
 * card dismissal). Also the cleanup for aborted/failed records — they hold
 * no URL, so the call is just the map removal. False for unknown keys.
 */
export function revokeTransferUrl(transferKey: string): boolean {
  const record = transferRecords.get(transferKey)
  if (record === undefined) return false
  if (record.url !== null) {
    URL.revokeObjectURL(record.url)
    record.url = null
  }
  transferRecords.delete(transferKey)
  return true
}

/** Snapshot of the §12.4 `fileOffers` map for Phase 4 (live record objects). */
export function getFileTransfers(): Record<string, FileTransferRecord> {
  return Object.fromEntries(transferRecords)
}

/** One record by its `${peerId}:${id}` key, when present. */
export function getFileTransferRecord(transferKey: string): FileTransferRecord | undefined {
  return transferRecords.get(transferKey)
}

/**
 * Receiver chunk pipeline, run INSIDE the session's recvChain so GCM
 * decryptions settling out of order still store in wire order. Returns the
 * ack (if any) the chunk earned, or null when it was dropped/aborted.
 */
async function processChunk(
  session: TransferSession,
  seq: number,
  payload: Uint8Array,
): Promise<void> {
  const record = session.record
  const meta = record.meta
  if (record.state !== 'transferring') return

  // §12.4 — out-of-credit chunks are DISCARDED: the window is the
  // receiver's memory plan, an honest sender never exceeds it, and a
  // systematic violator only drives the stream into the 30 s stall.
  if (session.creditsOutstanding <= 0) return
  // Range + duplicate discipline: out of range or repeated → discarded.
  if (seq < 1 || seq > meta.chunks) return
  if (seq !== session.contiguousNext) return // duplicates AND gaps: drop

  let plain: Uint8Array
  if (meta.enc) {
    const opened = await openSealedChunk(session, payload)
    if (opened === null) {
      transitionTerminal(session, 'failed', 'crypto', { notifyPeer: true })
      return
    }
    plain = opened
  } else {
    plain = payload
  }

  // §12.4 — abort AT THE FIRST byte that would push the accumulator past
  // `size`, and per-seq length discipline: an honest sender's chunk N is
  // exactly FILE_CHUNK_PAYLOAD_BYTES (the last one the exact tail).
  const expected = expectedChunkLength(seq, meta)
  if (plain.length > expected || session.receivedBytes + plain.length > meta.size) {
    transitionTerminal(session, 'failed', 'size-limit', { notifyPeer: true })
    return
  }

  const parts = session.parts
  if (parts === null) return
  parts[seq - 1] = plain
  session.receivedBytes += plain.length
  session.contiguousNext = seq + 1
  session.creditsOutstanding -= 1
  record.transferred = seq
  armStallTimer(session) // fresh chunk = progress; restart the 30 s window
  emitProgress(session)

  if (session.contiguousNext === meta.chunks + 1) {
    if (session.receivedBytes !== meta.size) {
      // §12.4 — the sum of cleartext must be EXACTLY size: any deviation
      // → failed, and the sender is told so it does not stall out.
      transitionTerminal(session, 'failed', 'completeness', { notifyPeer: true })
      return
    }
    session.host.send(
      'file-ack',
      { id: meta.id, nextSeq: meta.chunks + 1, grant: 0 } satisfies FileAckPayload,
      record.peerId,
    )
    record.url = assembleReceiverBlob(session)
    transitionTerminal(session, 'done', null)
    return
  }
  if (session.creditsOutstanding === 0) {
    // Window consumed: re-grant the full window with the contiguous nextSeq.
    session.host.send(
      'file-ack',
      {
        id: meta.id,
        nextSeq: session.contiguousNext,
        grant: FILE_CREDIT_WINDOW,
      } satisfies FileAckPayload,
      record.peerId,
    )
    session.creditsOutstanding = FILE_CREDIT_WINDOW
  }
}

/**
 * Opens one sealed chunk (§12.4's one ambiguity resolved): the wire cannot
 * distinguish a password-room transfer from a DM transfer riding the same
 * swarm, so candidates are tried in order — the room key first, then the
 * DM key — and GCM authentication picks the right one (both can never
 * authenticate the same chunk). The winner is cached for the stream.
 * Null = no key opened this chunk (fail the transfer — never guess).
 */
async function openSealedChunk(
  session: TransferSession,
  sealed: Uint8Array,
): Promise<Uint8Array | null> {
  if (session.openKey !== null) {
    try {
      return await openChunk(session.openKey, sealed)
    } catch {
      return null
    }
  }
  const candidates: CryptoKey[] = []
  if (session.host.roomKey !== null) {
    try {
      candidates.push(await session.host.roomKey)
    } catch {
      // A rejected room-key derivation is no candidate; the DM key may
      // still be the right one.
    }
  }
  const dmKey = await session.host
    .resolveKey({ kind: 'dm', peerId: session.record.peerId })
    .catch(() => null)
  if (dmKey !== null) candidates.push(dmKey)
  for (const key of candidates) {
    try {
      const plain = await openChunk(key, sealed)
      session.openKey = key
      return plain
    } catch {
      // Try the next candidate; GCM failure on both → the stream is dead.
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Receive-path handlers (called from roomManager's action shims)
// ---------------------------------------------------------------------------

/**
 * `file-meta` receive path. The roomManager shim has already dropped muted
 * senders (pre-parse). Order tightens cost: pure validation
 * (`parseFileMeta`) → the FILE_OFFER_RATE_CAP rolling budget → the
 * MAX_TRANSFERS_PER_PEER cap, answered with an EXPLICIT `file-abort` so
 * the sender's UI can say "the peer is busy" (§12.4) → the duplicate-key
 * guard. Survivors become `offer` records and fire `onFileOffer` — no
 * other byte flows until acceptFileTransfer, no badge, no notification
 * (the card IS the notice, §12.4).
 */
export function handleFileMeta(host: FileTransferHost, raw: unknown, peerId: string): void {
  const meta = parseFileMeta(raw)
  if (meta === null) return
  if (!consumeOfferBudget(host.roomId, peerId)) return
  if (countActiveForPeer(peerId) >= MAX_TRANSFERS_PER_PEER) {
    host.send('file-abort', { id: meta.id } satisfies FileAbortPayload, peerId)
    return
  }
  const key = transferKeyOf(peerId, meta.id)
  if (transferRecords.has(key)) return
  const record: FileTransferRecord = {
    key,
    roomId: host.roomId,
    peerId,
    direction: 'receive',
    meta,
    state: 'offer',
    transferred: 0,
    url: null,
    failureReason: null,
  }
  transferRecords.set(key, record)
  const session: TransferSession = {
    record,
    role: 'receiver',
    host,
    fileIdPromise: computeFileId(meta.id),
    fileIdBytes: null,
    recvChain: Promise.resolve(),
    file: null,
    sealKey: null,
    lastSent: 0,
    ackedThrough: 0,
    fileEndSent: false,
    pumping: false,
    parts: new Array<Uint8Array | null>(meta.chunks).fill(null),
    receivedBytes: 0,
    contiguousNext: 1,
    creditsOutstanding: 0,
    openKey: null,
    stallTimer: null,
    settle: null,
    onProgress: null,
  }
  sessions.set(key, session)
  for (const listener of offerListeners) listener(host.roomId, peerId, meta)
}

/**
 * `file-chunk` receive path — pure transport gate (frame shape, prefix
 * match against THIS peer's active receiver transfers) and then the
 * per-session pipeline, serialized through recvChain. Anything that does
 * not correspond to a known, transferring transfer of this peer is
 * discarded whole and silently (§12.4 — Trystero cannot see directed
 * sends, so the receiver's own state is the router).
 *
 * Async (the prefix match resolves the session's fileId hash): the actual
 * chunk work is chained onto the session's recvChain — this function never
 * blocks the caller and never processes two chunks of one session
 * concurrently.
 */
export async function handleFileChunk(
  _host: FileTransferHost,
  data: unknown,
  peerId: string,
): Promise<void> {
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (bytes === null) return
  if (bytes.byteLength < FILE_FRAME_HEADER_BYTES + 1 || bytes.byteLength > FILE_FRAME_MAX_BYTES) {
    return
  }
  const prefix = bytes.subarray(0, FILE_ID_BYTES)
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    FILE_ID_BYTES,
    false,
  )
  const payload = bytes.subarray(FILE_FRAME_HEADER_BYTES)
  const session = await findReceiverSessionByPrefix(peerId, prefix)
  if (session === null) return
  // Serialize: decryptions settle out of order, chunks must store in wire
  // order (the sendChain/recoveredChain discipline, receive direction).
  session.recvChain = session.recvChain
    .then(() => processChunk(session, seq, payload))
    .catch(() => {
      // A throwing tail must never reject the chain (§7.3 silence).
    })
}

async function findReceiverSessionByPrefix(
  peerId: string,
  prefix: Uint8Array,
): Promise<TransferSession | null> {
  for (const session of sessions.values()) {
    if (session.role !== 'receiver' || session.record.peerId !== peerId) continue
    if (session.record.state !== 'transferring') continue
    let idBytes = session.fileIdBytes
    if (idBytes === null) {
      idBytes = await session.fileIdPromise
      session.fileIdBytes = idBytes
    }
    if (bytesEqual(idBytes, prefix)) return session
  }
  return null
}

/**
 * `file-ack` receive path (sender only) — the FIRST ack is the acceptance
 * (offer → accepted → transferring, the latter two in the same breath per
 * §12.4); every ack advances the contiguous acked-through mark and re-arms
 * the stall; `nextSeq === chunks + 1` is the final ack and completes the
 * transfer. Grant is shape-checked but pacing uses the constant: §12.4
 * fixes the receiver to grant the full window on every ack.
 */
export function handleFileAck(_host: FileTransferHost, raw: unknown, peerId: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return
  const session = sessions.get(transferKeyOf(peerId, candidate.id))
  if (session === undefined || session.role !== 'sender') return
  const meta = session.record.meta
  if (
    typeof candidate.nextSeq !== 'number' ||
    !Number.isInteger(candidate.nextSeq) ||
    candidate.nextSeq < 1 ||
    candidate.nextSeq > meta.chunks + 1
  ) {
    return
  }
  if (
    typeof candidate.grant !== 'number' ||
    !Number.isInteger(candidate.grant) ||
    candidate.grant < 0 ||
    candidate.grant > FILE_CREDIT_WINDOW
  ) {
    return
  }
  const record = session.record
  if (record.state === 'offer') record.state = 'accepted'
  if (record.state === 'accepted') {
    record.state = 'transferring'
    armStallTimer(session)
  }
  if (record.state !== 'transferring') return
  if (candidate.nextSeq > session.ackedThrough) {
    session.ackedThrough = candidate.nextSeq
    record.transferred = candidate.nextSeq - 1
    armStallTimer(session) // an ack IS progress
    emitProgress(session)
  }
  if (candidate.nextSeq === meta.chunks + 1) {
    // §12.4 — the final ack completes the sender regardless of grant.
    transitionTerminal(session, 'done', null)
    return
  }
  pumpSender(session)
}

/**
 * `file-end` receive path (receiver only) — the sender's "last chunk
 * dispatched". Arrives after every chunk (ordered reliable channels), so a
 * complete transfer is already `done` and this is a no-op; missing chunks
 * at this point mean a broken stream: fail fast (§12.4) instead of waiting
 * out the stall, and tell the sender.
 */
export function handleFileEnd(_host: FileTransferHost, raw: unknown, peerId: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return
  const session = sessions.get(transferKeyOf(peerId, candidate.id))
  if (session === undefined || session.role !== 'receiver') return
  if (session.record.state !== 'transferring') return
  if (session.contiguousNext === session.record.meta.chunks + 1) return
  transitionTerminal(session, 'failed', 'completeness', { notifyPeer: true })
}

/**
 * `file-abort` receive path — the peer cancelled, declined or died
 * mid-transfer: sender `offer` → `rejected` (§12.4: the offer rejection is
 * seen here), later states → `aborted`; the receiver releases its
 * accumulated buffers either way.
 */
export function handleFileAbort(_host: FileTransferHost, raw: unknown, peerId: string): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return
  const session = sessions.get(transferKeyOf(peerId, candidate.id))
  if (session === undefined) return
  if (session.record.state === 'offer') {
    transitionTerminal(session, 'rejected', null)
  } else {
    transitionTerminal(session, 'aborted', null)
  }
}

// ---------------------------------------------------------------------------
// Host registration and lifecycle hooks (wired by roomManager)
// ---------------------------------------------------------------------------

/** createConnection registers its host; the send path looks hosts up. */
export function registerFileHost(host: FileTransferHost): void {
  hosts.set(host.roomId, host)
}

export function unregisterFileHost(roomId: string): void {
  hosts.delete(roomId)
}

/**
 * peerLeave — §12.4: a reconnect mid-transfer FAILS it, no resume (offsets
 * and accumulators are per-connection memory). Offers die too; done
 * records keep their URLs (the transfer completed).
 */
export function onPeerGone(roomId: string, peerId: string): void {
  for (const session of [...sessions.values()]) {
    const record = session.record
    if (record.roomId === roomId && record.peerId === peerId && ACTIVE_STATES.has(record.state)) {
      transitionTerminal(session, 'failed', 'peer-drop')
    }
  }
}

/**
 * teardownConnection (leave, reconnectAll, panic via abortAllRooms) — the
 * room's host dies with the connection and every active transfer of the
 * room fails locally (no file-abort: the channels are going away and the
 * peers discover the drop on their own side).
 */
export function roomTornDown(roomId: string): void {
  unregisterFileHost(roomId)
  for (const key of [...offerTimes.keys()]) {
    if (key.startsWith(`${roomId}\u0000`)) offerTimes.delete(key)
  }
  for (const session of [...sessions.values()]) {
    if (session.record.roomId === roomId && ACTIVE_STATES.has(session.record.state)) {
      transitionTerminal(session, 'failed', 'room-gone')
    }
  }
}

/**
 * Mid-transfer mute (issue #95 × §12.4): muting a peer aborts its active
 * transfers on the spot — local discard plus `file-abort` to the other
 * side, whose content must stop accumulating immediately.
 */
export function abortActiveTransfersWithPeer(roomId: string, peerId: string): void {
  for (const session of [...sessions.values()]) {
    const record = session.record
    if (record.roomId === roomId && record.peerId === peerId && ACTIVE_STATES.has(record.state)) {
      transitionTerminal(session, 'aborted', null, { notifyPeer: true })
    }
  }
}

/**
 * RF-08 panic — silent teardown: stall timers cleared, every blob URL
 * revoked, all module state dropped. No seams fire (the app is about to
 * reload); roomManager's abortAllRooms has already failed the actives.
 */
export function abortAllFileTransfers(): void {
  for (const session of sessions.values()) {
    clearStallTimer(session)
    session.settle?.('failed')
  }
  sessions.clear()
  for (const record of transferRecords.values()) {
    if (record.url !== null) URL.revokeObjectURL(record.url)
  }
  transferRecords.clear()
  offerTimes.clear()
}

/**
 * RF-07 identity regeneration (the §12.2 seam, subscribed in roomManager) —
 * every live key relationship was announced under the OLD identity, so all
 * active transfers fail (with file-abort while the channels are still up)
 * and every URL — done cards included — is revoked (§12.4's revocation
 * list). The map empties: the user re-offers under the new identity.
 */
export function abortAllOnIdentityRegeneration(): void {
  for (const session of [...sessions.values()]) {
    if (ACTIVE_STATES.has(session.record.state)) {
      transitionTerminal(session, 'failed', 'identity-regenerated', { notifyPeer: true })
    } else {
      clearStallTimer(session)
      session.settle?.('failed')
      sessions.delete(session.record.key)
    }
  }
  for (const record of transferRecords.values()) {
    if (record.url !== null) {
      URL.revokeObjectURL(record.url)
      record.url = null
    }
  }
  transferRecords.clear()
  offerTimes.clear()
}

/** Rolling FILE_OFFER_RATE_CAP budget (the consumeRollingBudget discipline). */
function consumeOfferBudget(roomId: string, peerId: string): boolean {
  const bucketKey = `${roomId}\u0000${peerId}`
  const now = Date.now()
  const windowStart = now - FILE_OFFER_RATE_WINDOW_MS
  const recent = (offerTimes.get(bucketKey) ?? []).filter((ts) => ts > windowStart)
  if (recent.length >= FILE_OFFER_RATE_CAP) {
    offerTimes.set(bucketKey, recent)
    return false
  }
  recent.push(now)
  offerTimes.set(bucketKey, recent)
  return true
}

/** Test-only reset: drops every record, session, host, budget and listener. */
export function resetFileTransfersForTests(): void {
  for (const session of sessions.values()) {
    clearStallTimer(session)
    session.settle?.('failed')
  }
  sessions.clear()
  for (const record of transferRecords.values()) {
    if (record.url !== null) URL.revokeObjectURL(record.url)
  }
  transferRecords.clear()
  hosts.clear()
  offerTimes.clear()
  offerListeners.clear()
  progressListeners.clear()
  doneListeners.clear()
  abortListeners.clear()
  failedListeners.clear()
}
