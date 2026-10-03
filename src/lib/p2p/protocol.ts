/**
 * Application protocol — spec.md §7.
 *
 * M0 ships the typed surface: the Envelope (§7.2), the Trystero action
 * payloads (§7.1) and the protocol constants. Parsing, validation and
 * dedup land in M1 together with their unit tests.
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
export interface Envelope {
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
export interface PresencePayload {
  nick: string
  fp: string
}

/** §7.1 — raw ECDH P-256 public key, 65 bytes (spec §9.1). */
export type KeysPayload = Uint8Array

/** §7.1 — typing indicator. */
export interface TypingPayload {
  on: boolean
}

/** §7.1 — batched read receipts, max MAX_RECEIPT_BATCH ids. */
export interface ReceiptPayload {
  ids: string[]
}

/** §7.1 — latency probes; RTT = now − t on pong. */
export interface PingPayload {
  t: number
}
export interface PongPayload {
  t: number
}

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

/**
 * Records `id` and returns true when it had not been seen before.
 * M1: per-room dedup window (spec §7.3) — full-mesh delivery duplicates.
 */
export function markSeen(_seenIds: Set<string>, _id: string): boolean {
  throw new Error('not implemented: envelope dedup lands in M1 (spec §7.3)')
}

/**
 * Structural validation of an incoming envelope: protocol version, shape
 * and size limits. M1 (spec §7.3).
 */
export function isValidEnvelope(_value: unknown): _value is Envelope {
  throw new Error('not implemented: envelope validation lands in M1 (spec §7.3)')
}

/**
 * True when a `dm` envelope is addressed to us; foreign `to` values are
 * discarded, never relayed (§7.3 — no relay in v1). M1.
 */
export function isDmForMe(_envelope: Envelope, _selfId: string): boolean {
  throw new Error('not implemented: DM filtering lands in M1 (spec §7.3)')
}
