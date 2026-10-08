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

/**
 * Issue #93 (spec §12.1) — envelope version of DMs sealed with
 * session-ephemeral ECDH keys. v1 envelopes cover chat, every control-plane
 * action and the legacy static-identity `dm`; v2 envelopes only ever carry
 * `kind: 'dm'`.
 */
export const DM_PROTOCOL_VERSION = 2

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
/** Issue #98 — reactions are batched like receipts, max 50 ids per action. */
export const MAX_REACT_BATCH = 50

/**
 * Issue #96 — inclusive bounds of the optional per-message `ttl`, in whole
 * seconds. Below 30 s the message would effectively self-destruct on mesh
 * latency alone (peers regularly take seconds to relay); above 1 h it stops
 * being a session-lived chat and starts being storage. The value rides the
 * envelope WITHOUT a version bump: old builds drop the unknown field
 * silently and keep the message for the session (the documented §7.3
 * degradation), so the sender must never assume the peer honors it.
 */
export const MIN_MESSAGE_TTL_S = 30
export const MAX_MESSAGE_TTL_S = 3600

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
  /**
   * Protocol version: 1 (chat and the control plane) or 2 — the only version
   * a `dm` may carry since phase 4 of issue #93 (spec §12.1); anything else
   * is silently ignored.
   */
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
  /**
   * Issue #96 — optional self-destruct timer in whole seconds
   * (MIN_MESSAGE_TTL_S..MAX_MESSAGE_TTL_S). Absent ⇒ session-lived (the
   * FIFO cap remains the only eviction). Ships at the current per-kind
   * version — no `v` bump; unknown to old builds, which ignore it.
   */
  ttl?: number
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

/**
 * Issue #98 — the reaction whitelist: the canonical, single source both the
 * UI quick-reaction bar and the wire validator must use. Anything outside it
 * is dropped whole (§7.3 silence) — a fixed set bounds the flood surface and
 * keeps reactions renderable everywhere (spec §9.5 cosmetic class, like
 * receipts and typing: no notifications, no unread, no persistence).
 */
export const REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '👎'] as const

/**
 * Issue #98 — an emoji reaction batch (§7.1): `ids` are the message ids the
 * reaction applies to (1..MAX_REACT_BATCH, dedup'd by `parseReact`), `emo`
 * is one of REACT_EMOJIS and `on` toggles (true = react, false = unreact).
 *
 * The optional `to` makes the payload DIRECTED (issue #98 decision): DM
 * reactions reuse this action on the room swarm, but a broadcast would leak
 * DM reaction metadata to the whole room — so the sender targets the peer
 * (like `dm`/`receipt`) and carries `to`; receivers drop foreign-directed
 * payloads, never relaying them (§7.3). Absent `to` = room-wide broadcast
 * (every peer maintains counts). Mixed builds: old peers ignore the whole
 * action (see the spike note at the `react` registration in roomManager).
 */
export type ReactPayload = {
  ids: string[]
  emo: string
  on: boolean
  /** Recipient peerId — only for directed (DM) reactions; absent = broadcast. */
  to?: string
}

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
 * Rules: `v` ∈ {1, 2} (anything else is silently discarded) with a
 * per-action gate — `kind: 'chat'` requires v1 (control-plane actions are
 * Envelope-less payloads, so chat is the only broadcast kind), while
 * `kind: 'dm'` requires v2 = DM_PROTOCOL_VERSION (issue #93 phase 4, spec
 * §12.1): DMs are sealed with session-ephemeral keys that only v2 peers
 * announce (`ephkeys`), so a v1 dm has no honest sender anymore and is
 * dropped. This is the accepted mixed-version degradation of §12.1, in
 * both directions: our v2 dms are silently dropped by v1 peers (old
 * builds), and we silently drop their v1 dms — the v2 sender additionally
 * surfaces an explicit legacy-peer state in the UI instead of relying on
 * the silence.
 *
 * Further rules: `id`, `from`, `nick`, `body` are non-empty
 * strings; `ts` a finite number; `kind` ∈ {chat, dm};
 * `to` required (non-empty) iff kind is 'dm'; `enc` defaults to false, and
 * the body is capped before any decode work: plaintext bodies at
 * MAX_PLAINTEXT_LENGTH (4000 chars), base64 ciphertext bodies at
 * MAX_ENCRYPTED_BODY_CHARS (issue #21). Issue #28 — `nick` never lands raw:
 * it passes through `sanitizeRemoteNick` (control/invisible characters
 * stripped, trimmed, capped at NICKNAME_MAX_LENGTH); when nothing legible
 * remains the envelope keeps the '' convention and the UI falls back to the
 * peerId-prefix display. Issue #96 — `ttl` is optional and additive (no `v`
 * bump): absent keeps the session-lived semantics; a present value must be
 * an integer within [MIN_MESSAGE_TTL_S, MAX_MESSAGE_TTL_S] seconds — any
 * other value (0, negative, out of range, non-integer, non-number)
 * invalidates the WHOLE envelope, like every other field violation.
 */
export function parseEnvelope(raw: unknown): Envelope | null {
  if (!isPlainObject(raw)) return null
  const version = raw.v
  if (version !== PROTOCOL_VERSION && version !== DM_PROTOCOL_VERSION) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts)) return null
  if (typeof raw.from !== 'string' || raw.from.length === 0) return null
  if (typeof raw.nick !== 'string') return null
  // Issue #28 — the remote nick is sanitized at the boundary; an empty
  // result keeps the existing '' display-fallback convention.
  const nick = sanitizeRemoteNick(raw.nick)
  if (raw.kind !== 'chat' && raw.kind !== 'dm') return null

  const kind: EnvelopeKind = raw.kind
  // Per-action version gate: v2 is dm-only, and `dm` is v2-only (issue #93
  // phase 4, spec §12.1) — a v1 dm comes from an old build that cannot know
  // the session-ephemeral key the v2 derivation needs, so it is dropped
  // silently (§7.3), the mirror image of v1 peers dropping our v2 dms.
  if (kind === 'chat' && version !== PROTOCOL_VERSION) return null
  if (kind === 'dm' && version !== DM_PROTOCOL_VERSION) return null
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

  // Issue #96 — the per-message TTL: absent stays absent (session-lived);
  // present, it must be an integer inside the inclusive bounds — anything
  // else drops the WHOLE envelope (§7.3), never just the field, so a
  // half-valid message cannot degrade silently into a different lifetime
  // than the author asked for.
  let ttl: number | undefined
  if (raw.ttl !== undefined) {
    if (
      typeof raw.ttl !== 'number' ||
      !Number.isInteger(raw.ttl) ||
      raw.ttl < MIN_MESSAGE_TTL_S ||
      raw.ttl > MAX_MESSAGE_TTL_S
    ) {
      return null
    }
    ttl = raw.ttl
  }

  const envelope: Envelope = {
    // The normalized envelope carries the ACTUAL accepted version (1 or 2),
    // not a hardcoded 1: the DM receive path keys off it (v2 ⇒
    // session-ephemeral derivation, issue #93 / spec §12.1).
    v: version,
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
  if (ttl !== undefined) envelope.ttl = ttl
  return envelope
}

/**
 * Builds a valid outgoing envelope with fresh id/timestamp (§7.2). The
 * version defaults to PROTOCOL_VERSION; DM senders pass
 * DM_PROTOCOL_VERSION (issue #93 phase 4, spec §12.1 — session-ephemeral
 * E2EE). Issue #96 — senders may attach `ttl` (seconds); when absent the
 * field is left off the envelope entirely (the session-lived wire form is
 * byte-identical to pre-TTL builds). Deliberately NO kind-vs-version or
 * ttl-vs-bounds validation here — the parser is the single gate (§7.3); a
 * mis-versioned envelope (or an out-of-bounds ttl) would simply be ignored
 * — the ttl case dropped whole — by every receiving peer.
 */
export function createEnvelope(
  fields: Pick<Envelope, 'from' | 'nick' | 'kind' | 'body'> &
    Partial<Pick<Envelope, 'to' | 'enc' | 'iv' | 'v' | 'ttl'>>,
): Envelope {
  return {
    v: fields.v ?? PROTOCOL_VERSION,
    id: newMessageId(),
    ts: Date.now(),
    from: fields.from,
    nick: fields.nick,
    kind: fields.kind,
    enc: fields.enc ?? false,
    iv: fields.iv ?? null,
    body: fields.body,
    ...(fields.to !== undefined ? { to: fields.to } : {}),
    ...(fields.ttl !== undefined ? { ttl: fields.ttl } : {}),
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
export function isWithinFreshnessWindow(ts: number, now: number = Date.now()): boolean {
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
export function filterDmForSelf(envelope: Envelope, selfId: string): Envelope | null {
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

/**
 * Issue #98 — react payload validation (§7.1): `emo` must be on the
 * REACT_EMOJIS whitelist, `on` is required boolean, `to` (when present) a
 * non-empty string and `ids` an array of 1..MAX_REACT_BATCH non-empty
 * strings. Any violation drops the WHOLE payload silently (cosmetic class:
 * no system lines, no feedback — §7.3), never just the offending field, so
 * a half-valid batch cannot apply a fraction of what the sender claimed.
 *
 * Like `parseEnvelope` this returns a normalized copy: the ids are dedup'd
 * (first occurrence kept), so a duplicated id inside one batch can neither
 * double-count nor double-toggle on the receiving side. The raw array is
 * capped BEFORE dedup (> MAX_REACT_BATCH entries → null), mirroring the
 * receipt discipline: honest senders never pad, so only attacker input
 * loses ids to the cap.
 */
export function parseReact(raw: unknown): ReactPayload | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.emo !== 'string' || !(REACT_EMOJIS as readonly string[]).includes(raw.emo)) {
    return null
  }
  if (typeof raw.on !== 'boolean') return null
  if (raw.to !== undefined && (typeof raw.to !== 'string' || raw.to.length === 0)) return null
  const ids = raw.ids
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_REACT_BATCH) return null
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) return null
  const payload: ReactPayload = { ids: [...new Set(ids)], emo: raw.emo, on: raw.on }
  if (raw.to !== undefined) payload.to = raw.to
  return payload
}

/**
 * Issue #98 — dedup key for a react payload, fed through the receiving
 * connection's BoundedSeenIds (markSeen) so a replayed payload is dropped
 * before it can re-apply a toggle. The key is the payload CONTENT, not a
 * per-message id: an identical replay collapses onto one key, while the
 * inverse toggle (on:false after on:true, same ids/emo) keys differently
 * and still processes — content-keying is what keeps toggles working under
 * dedup. The `react:` prefix keeps these keys out of the envelope-id
 * namespace sharing the same bounded set (envelope ids are UUIDs).
 */
export function reactSeenKey(payload: ReactPayload): string {
  return `react:${JSON.stringify([payload.to ?? null, payload.on, payload.emo, payload.ids])}`
}
