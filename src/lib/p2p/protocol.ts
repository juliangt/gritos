import { newMessageId } from '../crypto/hashes'

/**
 * Application protocol — spec.md §7.
 *
 * The Envelope (§7.2), the Trystero action payloads (§7.1), the protocol
 * constants and the pure validation/dedup helpers that gate everything the
 * room manager feeds into the store. Payload types are `type` aliases (not
 * interfaces) so they satisfy Trystero's `DataPayload` constraint
 * (JSON-value index signature).
 */

export const PROTOCOL_VERSION = 1

/** Max plaintext body length in characters (RF-03). */
export const MAX_PLAINTEXT_LENGTH = 4000
/** Binary payloads above this size are discarded (§7.3). */
export const MAX_PAYLOAD_BYTES = 64 * 1024
/** Receipts are batched, max 50 ids per action (§7.1). */
export const MAX_RECEIPT_BATCH = 50

export type EnvelopeKind = 'chat' | 'dm'

/**
 * Message envelope — spec §7.2. Unknown extra fields must be ignored;
 * only `v` is discriminating (§7.3).
 */
export type Envelope = {
  /** Protocol version; anything other than 1 is silently ignored. */
  v: number
  /** crypto.randomUUID() — dedup key (§7.3). */
  id: string
  /** Author's Date.now(). */
  ts: number
  /** Author's Trystero peerId. */
  from: string
  /** Author nickname at send time. */
  nick: string
  kind: EnvelopeKind
  /** Recipient peerId — only when kind is 'dm'. */
  to?: string
  /** true when body carries base64 ciphertext. */
  enc: boolean
  /** base64 of the 12-byte IV when enc. */
  iv: string | null
  /** Plaintext | base64(ciphertext); ≤ 4000 chars in plaintext. */
  body: string
}

/** §7.1 — announce nickname + fingerprint. */
export type PresencePayload = { nick: string; fp: string }

/** §7.1 — raw ECDH P-256 public key, 65 bytes (spec §9.1). */
export type KeysPayload = Uint8Array

/**
 * §7.1 — typing indicator. M3 additive optional field `dm` (§7.3: unknown
 * fields are ignored): when true the signal refers to the direct-message
 * channel with the receiving peer and is sent directed; absent/false keeps
 * the room-wide meaning.
 */
export type TypingPayload = { on: boolean; dm?: boolean }

/** §7.1 — batched read receipts, max MAX_RECEIPT_BATCH ids. */
export type ReceiptPayload = { ids: string[] }

/** §7.1 — latency probes; RTT = now − t on pong. */
export type PingPayload = { t: number }
export type PongPayload = { t: number }

/** §7.1 — room messages travel as a JSON Envelope. */
export type ChatPayload = Envelope
/** §7.1 — DMs are always encrypted Envelopes; non-recipients discard. */
export type DmPayload = Envelope

/** Trystero action names registered per room — spec §7.1. */
export type ActionName =
  | 'presence'
  | 'keys'
  | 'chat'
  | 'dm'
  | 'typing'
  | 'receipt'
  | 'ping'
  | 'pong'

export const ACTION_NAMES: readonly ActionName[] = [
  'presence',
  'keys',
  'chat',
  'dm',
  'typing',
  'receipt',
  'ping',
  'pong',
] as const

// ---------------------------------------------------------------------------
// Validation / dedup helpers (§7.3)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural validation of an incoming envelope (§7.2 + §7.3): protocol
 * version, required fields, shape and size limits. Returns a normalized
 * copy containing only the known fields; null when the payload must be
 * silently discarded.
 *
 * Rules: `v` must be exactly 1; `id`, `from`, `nick`, `body` are non-empty
 * strings (nick may be empty); `ts` a finite number; `kind` ∈ {chat, dm};
 * `to` required (non-empty) iff kind is 'dm'; `enc` defaults to false and
 * when false the plaintext body is capped at MAX_PLAINTEXT_LENGTH.
 */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isPlainObject(raw)) return null
  if (raw.v !== PROTOCOL_VERSION) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null
  if (typeof raw.from !== 'string' || raw.from.length === 0) return null
  if (typeof raw.nick !== 'string') return null
  if (raw.kind !== 'chat' && raw.kind !== 'dm') return null

  const kind: EnvelopeKind = raw.kind
  const isDm = kind === 'dm'
  let to: string | undefined
  if (isDm) {
    if (typeof raw.to !== 'string' || raw.to.length === 0) return null
    to = raw.to
  }

  const enc = raw.enc ?? false
  if (typeof enc !== 'boolean') return null
  const iv = raw.iv ?? null
  if (iv !== null && typeof iv !== 'string') return null
  if (typeof raw.body !== 'string') return null
  if (!enc && raw.body.length > MAX_PLAINTEXT_LENGTH) return null

  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: raw.id,
    ts: raw.ts,
    from: raw.from,
    nick: raw.nick,
    kind,
    enc,
    iv,
    body: raw.body,
  }
  if (isDm) envelope.to = to
  return envelope
}

/** Builds a valid outgoing envelope with fresh id/timestamp (§7.2). */
export function createEnvelope(
  fields: Pick<Envelope, 'from' | 'nick' | 'kind' | 'body'> &
    Partial<Pick<Envelope, 'to' | 'enc' | 'iv'>>,
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    id: newMessageId(),
    ts: Date.now(),
    from: fields.from,
    nick: fields.nick,
    kind: fields.kind,
    enc: fields.enc ?? false,
    iv: fields.iv ?? null,
    body: fields.body,
    ...(fields.to !== undefined ? { to: fields.to } : {}),
  }
}

/**
 * Records `id` and returns true when it had not been seen before.
 * Per-room dedup window (spec §7.3) — full-mesh delivery duplicates.
 */
export function markSeen(seenIds: Set<string>, id: string): boolean {
  if (seenIds.has(id)) return false
  seenIds.add(id)
  return true
}

/** Validation first, then dedup: true only for first-seen valid envelopes. */
export function shouldProcess(envelope: Envelope, seenIds: Set<string>): boolean {
  return markSeen(seenIds, envelope.id)
}

/** True when a payload of `sizeBytes` must be discarded (§7.3: > 64 KB). */
export function isOversized(sizeBytes: number): boolean {
  return sizeBytes > MAX_PAYLOAD_BYTES
}

/**
 * True when a `dm` envelope is addressed to us; foreign `to` values are
 * discarded, never relayed (§7.3 — no relay in v1).
 */
export function filterDmForSelf(
  envelope: Envelope,
  selfId: string,
): Envelope | null {
  return envelope.to === selfId ? envelope : null
}

/**
 * Receipt validation (§7.1): an `ids` array of 1..MAX_RECEIPT_BATCH
 * non-empty strings. Anything else is discarded.
 */
export function validateReceipt(payload: unknown): payload is ReceiptPayload {
  if (!isPlainObject(payload)) return false
  const ids = payload.ids
  if (!Array.isArray(ids)) return false
  if (ids.length === 0 || ids.length > MAX_RECEIPT_BATCH) return false
  return ids.every((id) => typeof id === 'string' && id.length > 0)
}
