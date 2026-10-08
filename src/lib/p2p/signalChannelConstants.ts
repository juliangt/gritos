/**
 * Issue #105 (spec §12.5) — the global DM signaling channel ("canal
 * global"): a dedicated, well-known Trystero swarm where peers who opted in
 * can be knocked BY IDENTITY FINGERPRINT; an accepted knock opens an E2EE
 * DM backed by that same swarm.
 *
 * This module is the SINGLE home of the signal-swarm contract's constants
 * and pure payload validators — deliberately NO swarm logic: joining,
 * leaving, the presence LRU and the knock rate window belong to Phase 2's
 * `lib/p2p/signalChannel.ts`. It is kept separate from `protocol.ts` (the
 * spec §7 ROOM-swarm protocol) on purpose: the signal swarm is its own wire
 * surface, and the Phase 3 contact flow must consume
 * `SIGNAL_ROOM_NAME`/`deriveSignalRoomId` without importing the envelope
 * machinery. The well-known name lives HERE and nowhere else — a typo in a
 * second definition would fork the swarm silently.
 */

import { canonicalFingerprint } from '../crypto/dm'
import { deriveRoomId } from '../crypto/hashes'
import { REMOTE_NICK_INVISIBLE_PATTERN, sanitizeRemoteNick } from '../nickname'
import { isValidFingerprint } from '../validateSettings'

/**
 * Spec §12.5 — the well-known room name the signal swarm derives from.
 * Unreachable through the join UI: the RF-02 room-name charset
 * (`[a-z0-9_-]`) excludes '/', so only the signal channel manager ever
 * joins it. Only builds sharing the same VITE_TRYSTERO_APP_ID (issue #90,
 * spec §9.4) can ever discover it — the appId is the peer-discovery
 * namespace.
 */
export const SIGNAL_ROOM_NAME = '_gritos/senal/v1'

/**
 * The signal swarm's roomId (spec §9.4/§12.5): hex(SHA-256)[0..31] of
 * ROOM_HASH_PREFIX + SIGNAL_ROOM_NAME, derived exactly like any room.
 * Async like `deriveRoomId` (Web Crypto). Deterministic per build; the
 * same-appId scoping of the swarm comes from Trystero's config, not from
 * this hash.
 */
export function deriveSignalRoomId(): Promise<string> {
  return deriveRoomId(SIGNAL_ROOM_NAME)
}

/** Spec §12.5 — the optional knock note cap, in raw characters. */
export const NOTE_MAX_LENGTH = 140

/**
 * Spec §12.5 — presence-list cap; Phase 2 evicts the least-recently-seen
 * entry past it (LRU). Engine state, never a browsable UI directory.
 */
export const MAX_SIGNAL_PRESENCE = 100

/**
 * Spec §12.5 — knocks RECEIVED per peer per minute; the excess is silently
 * discarded (same mitigation class as FILE_OFFER_RATE_CAP, spec §12.4).
 */
export const KNOCK_RATE_CAP = 5

/**
 * Spec §12.5 — a knock (the door): directed at the destination peer. There
 * is NO content field: the optional note (≤ NOTE_MAX_LENGTH) is everything
 * a knock can say. `type` is a fixed literal so the payload is
 * self-describing on the wire.
 */
export type KnockPayload = {
  type: 'knock'
  /** The knocker's identity fingerprint (canonical) + display nick. */
  from: { fp: string; nick: string }
  note?: string
}

/**
 * Spec §12.5 — signal-swarm presence (the mold of the room `presence`
 * action, §7.1): broadcast on join and on nickname change.
 */
export type WhoamiPayload = { nick: string; fp: string }

/**
 * Spec §12.5 — the directed response to a knock: `accept` is the consent
 * and `fp` is the fingerprint of the knock being acknowledged (the
 * knocker's, echoed from `from.fp`) — a knocker awaiting several acks
 * matches its own by fingerprint.
 */
export type KnockAckPayload = { accept: boolean; fp: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Strips the issue #28 control/invisible class from a knock note and trims
 * it. The result may be empty — an empty note is treated as absent (the
 * field is optional and carries no protocol semantics).
 */
function sanitizeNote(note: string): string {
  return note.replace(REMOTE_NICK_INVISIBLE_PATTERN, '').trim()
}

/**
 * Issue #105 (spec §12.5) — `knock` payload validation, the
 * parseReact/parseHistReq discipline: ANY violation drops the WHOLE payload
 * silently (§7.3), never just the offending field.
 *
 * Rules: `type` must be the exact literal 'knock'; `from.fp` must satisfy
 * the canonical fingerprint rule (issue #95: canonicalFingerprint → exactly
 * 32 hex; stored CANONICAL, both the spaced display form and either hex
 * case are accepted) and `from.nick` must survive sanitizeRemoteNick with
 * something legible — the nick IS the consent card («@nick quiere abrir un
 * DM contigo»), no peerId-prefix fallback exists on the signal swarm (same
 * reasoning as file-meta's `name`, spec §12.4). `note`, when present, must
 * be a string of at most NOTE_MAX_LENGTH RAW characters — oversize is
 * attacker input (honest senders never pad) and drops the whole knock —
 * then is sanitized with the #28 class; a note sanitizing to empty is
 * treated as absent. Unknown extra fields never survive (normalized copy).
 */
export function parseKnock(raw: unknown): KnockPayload | null {
  if (!isPlainObject(raw)) return null
  if (raw.type !== 'knock') return null
  if (!isPlainObject(raw.from)) return null
  if (!isValidFingerprint(raw.from.fp)) return null
  const nick = typeof raw.from.nick === 'string' ? sanitizeRemoteNick(raw.from.nick) : null
  if (nick === null) return null
  const payload: KnockPayload = {
    type: 'knock',
    from: { fp: canonicalFingerprint(raw.from.fp), nick },
  }
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length > NOTE_MAX_LENGTH) return null
    const note = sanitizeNote(raw.note)
    if (note !== '') payload.note = note
  }
  return payload
}

/**
 * Issue #105 (spec §12.5) — `whoami` payload validation: the same canonical
 * `fp` rule and legible-`nick` rule as parseKnock. The presence list keeps
 * no peerId-prefix fallback rows (it is not a room member list: it is the
 * minimum state for resolving knocks and keys), so a nickless whoami is
 * dropped whole.
 */
export function parseWhoami(raw: unknown): WhoamiPayload | null {
  if (!isPlainObject(raw)) return null
  if (!isValidFingerprint(raw.fp)) return null
  const nick = typeof raw.nick === 'string' ? sanitizeRemoteNick(raw.nick) : null
  if (nick === null) return null
  return { nick, fp: canonicalFingerprint(raw.fp) }
}

/**
 * Issue #105 (spec §12.5) — `knock-ack` payload validation: `accept` is a
 * REQUIRED boolean with no default (it governs opening the channel) and
 * `fp` must be the canonical fingerprint of the knock being acknowledged.
 * An ack matching none of the local pending knocks is discarded by the
 * Phase 2 manager, not here.
 */
export function parseKnockAck(raw: unknown): KnockAckPayload | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.accept !== 'boolean') return null
  if (!isValidFingerprint(raw.fp)) return null
  return { accept: raw.accept, fp: canonicalFingerprint(raw.fp) }
}
