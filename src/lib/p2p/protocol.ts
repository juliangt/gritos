import { newMessageId } from '../crypto/hashes'
import { sanitizeRemoteNick } from '../nickname'

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
/**
 * Issue #21 — cap on the `body` of an encrypted envelope (`enc: true`),
 * enforced in `parseEnvelope` BEFORE any base64 decode or GCM work. Only
 * plaintext bodies used to be capped, so an enc body of transport-maximum
 * size ("ciphertext bomb") paid a full `atob` + AES-GCM tag verification
 * per message that the failing tag then discarded — CPU/memory
 * amplification under a flood. The math for an honest message: a
 * 4000-char plaintext of 1-byte UTF-8 chars seals to 4000 B ciphertext +
 * 16 B GCM tag, plus the 12 B IV → 4028 B → 5372 base64 chars; the cap
 * keeps 16 384 (2^14) chars ≈ 3× that worst case, so it only bites on
 * attacker input. (Degenerate multi-byte plaintexts — 4000 emoji encode to
 * 16 KB and seal to ~21 372 base64 chars — exceed it and are dropped too:
 * a deliberate trade-off, ordinary text never comes near.) At the cap a
 * body still decodes to ≤ 12 KB of ciphertext, bounding each decode+verify
 * to a fraction of the transport maximum.
 */
export const MAX_ENCRYPTED_BODY_CHARS = 16_384
/** Receipts are batched, max 50 ids per action (§7.1). */
export const MAX_RECEIPT_BATCH = 50

/**
 * Issue #19 — maximum age of an incoming envelope relative to the local
 * clock. Dedup state is memory-only and resets on every reload, rejoin or
 * (for DMs) connection churn, so a captured envelope replayed later passes
 * dedup again and resurfaces as a freshly received message — and the UI
 * renders only HH:MM, hiding the age. That lets an attacker re-inject old
 * conversation fragments ("send me X" → "ok, here is the code") to
 * fabricate context: a social-engineering replay. Five minutes bounds any
 * replay to a short live window while tolerating normal mesh latency.
 */
export const MAX_ENVELOPE_AGE_MS = 300_000

/**
 * Issue #19 — how far into the future an envelope's `ts` may sit relative
 * to the local clock before it is discarded. Peer clocks are not
 * synchronized: a small tolerance keeps honest messages from being dropped,
 * while far-future stamps (which would stay "fresh" for hours, defeating
 * the age bound above) are rejected.
 */
export const MAX_CLOCK_SKEW_MS = 90_000

/**
 * Issue #20 — maximum entries of a dedup window (per-connection chat ids and
 * the session-wide DM set). `markSeen`/`shouldProcess` only ever grow their
 * set, and every parseable envelope consumes an id, so an unbounded set lets
 * a malicious peer flood protocol-compliant envelopes with random ids and
 * exhaust the tab's memory over a long-lived session. At the cap the OLDEST
 * entry is evicted (FIFO), so dedup stays effective for any practical
 * duplicate window while memory stays bounded.
 */
export const SEEN_IDS_CAP = 10_000

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
  /** Author nickname at send time; inbound ones arrive sanitized (issue #28). */
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

// ---------------------------------------------------------------------------
// Validation / dedup helpers (§7.3)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Minimal dedup-set surface shared by a plain `Set<string>` and the bounded
 * `BoundedSeenIds` (issue #20) — everything `markSeen`/`shouldProcess` need.
 */
export type SeenIdSet = {
  has(id: string): boolean
  add(id: string): unknown
}

/**
 * Issue #20 — a dedup set that never grows beyond `cap` entries. Backed by a
 * `Map` used as an ordered set (insertion order tracked); adding past the cap
 * evicts the OLDEST entry (FIFO), so a flood of unique ids only shrinks the
 * dedup window instead of exhausting memory. Accepted semantics: an evicted
 * id re-seen later is treated as unseen again (a replayed copy may surface
 * once more) — the freshness window (issue #19) still bounds any such
 * resurfacing to a 5-minute replay.
 */
export class BoundedSeenIds {
  private readonly entries = new Map<string, true>()
  readonly cap: number

  constructor(cap: number = SEEN_IDS_CAP) {
    this.cap = cap
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Records `id`; true only when it had not been seen before. */
  add(id: string): boolean {
    if (this.entries.has(id)) return false
    this.entries.set(id, true)
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
    return true
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Structural validation of an incoming envelope (§7.2 + §7.3): protocol
 * version, required fields, shape and size limits. Returns a normalized
 * copy containing only the known fields; null when the payload must be
 * silently discarded.
 *
 * Rules: `v` must be exactly 1; `id`, `from`, `nick`, `body` are non-empty
 * strings; `ts` a finite number; `kind` ∈ {chat, dm};
 * `to` required (non-empty) iff kind is 'dm'; `enc` defaults to false, and
 * the body is capped before any decode work: plaintext bodies at
 * MAX_PLAINTEXT_LENGTH (4000 chars), base64 ciphertext bodies at
 * MAX_ENCRYPTED_BODY_CHARS (issue #21). Issue #28 — `nick` never lands raw:
 * it passes through `sanitizeRemoteNick` (control/invisible characters
 * stripped, trimmed, capped at NICKNAME_MAX_LENGTH); when nothing legible
 * remains the envelope keeps the '' convention and the UI falls back to the
 * peerId-prefix display.
 */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isPlainObject(raw)) return null
  if (raw.v !== PROTOCOL_VERSION) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null
  if (typeof raw.from !== 'string' || raw.from.length === 0) return null
  if (typeof raw.nick !== 'string') return null
  // Issue #28 — the remote nick is sanitized at the boundary; an empty
  // result keeps the existing '' display-fallback convention.
  const nick = sanitizeRemoteNick(raw.nick)
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
  if (enc) {
    // Issue #21 — ciphertext bombs die here, before any atob/GCM work.
    if (raw.body.length > MAX_ENCRYPTED_BODY_CHARS) return null
  } else if (raw.body.length > MAX_PLAINTEXT_LENGTH) {
    return null
  }

  const envelope: Envelope = {
    v: PROTOCOL_VERSION,
    id: raw.id,
    ts: raw.ts,
    from: raw.from,
    nick: nick ?? '',
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
 * Issue #20: the window may be a plain Set or a bounded BoundedSeenIds;
 * both grow only here, and the bounded one evicts its oldest entry at cap.
 */
export function markSeen(seenIds: SeenIdSet, id: string): boolean {
  if (seenIds.has(id)) return false
  seenIds.add(id)
  return true
}

/**
 * Issue #19 — true when `ts` falls inside the acceptable window around
 * `now`: no older than MAX_ENVELOPE_AGE_MS and no further than
 * MAX_CLOCK_SKEW_MS in the future. Enforced by `shouldProcess` in both
 * receive paths (chat and DM), before any dedup or store effect.
 */
export function isWithinFreshnessWindow(
  ts: number,
  now: number = Date.now(),
): boolean {
  const delta = now - ts
  return delta <= MAX_ENVELOPE_AGE_MS && delta >= -MAX_CLOCK_SKEW_MS
}

/**
 * Validation first (freshness, issue #19 — `parseEnvelope` did the
 * structural part), then dedup: true only for first-seen, in-window
 * envelopes. Freshness runs BEFORE `markSeen` so a stale or future-dated
 * envelope has zero side effects: no feed message, no receipt, and it does
 * not even consume its id in the dedup set.
 */
export function shouldProcess(envelope: Envelope, seenIds: SeenIdSet): boolean {
  if (!isWithinFreshnessWindow(envelope.ts)) return false
  return markSeen(seenIds, envelope.id)
}

/** True when a payload of `sizeBytes` must be discarded (§7.3: > 64 KB). */
export function isOversized(sizeBytes: number): boolean {
  return sizeBytes > MAX_PAYLOAD_BYTES
}

/**
 * True when a `dm` envelope is addressed to us; foreign `to` values are
 * discarded, never relayed (§7.3 — no relay in v1). Since issue #18 sends
 * are already directed at the recipient, this filter is defense in depth:
 * peers running older builds may still broadcast their DM envelopes.
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
