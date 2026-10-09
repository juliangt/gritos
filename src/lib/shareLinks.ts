/**
 * Room share deep links (issue #41): the URL hash carries ONLY the room
 * name — `#room=<encoded-name>` — never the password (RF-05: whoever opens
 * a link to a password room must enter it through the regular join flow).
 * Pure helpers, testable without a network; `parseRoomHash` reuses the exact
 * join-validation rules (RF-02 normalization) so a link can never smuggle a
 * room name the join popover would reject. English hash params per issue
 * #121 (clean break, the slash-command precedent).
 */

import { canonicalFingerprint } from './crypto/dm'
import { normalizeRoomName } from './p2p/roomManager'
import { isValidFingerprint } from './validateSettings'

/** Hash parameter identifying a room deep link: `#room=<name>`. */
export const ROOM_HASH_PARAM = 'room='

/** Issue #105 (spec §12.5) — hash parameter of a contact deep link. */
export const CONTACT_HASH_PARAM = 'contact='

/**
 * Parses a raw URL hash (`window.location.hash`, leading '#' optional) into
 * the requested room name. Returns null when the hash carries no usable
 * room: missing/foreign hash, empty value, malformed percent-encoding, or a
 * decoded name that fails the join validation rules (RF-02 normalization
 * applies first, so 'Mi%20Sala' lands as 'mi-sala').
 */
export function parseRoomHash(hash: string | null | undefined): string | null {
  if (hash === null || hash === undefined) return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith(ROOM_HASH_PARAM)) return null
  const encoded = raw.slice(ROOM_HASH_PARAM.length)
  if (encoded === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  return normalizeRoomName(decoded)
}

/**
 * Builds the shareable link of a room: origin + path + `#room=<encoded>`.
 * Only the hash routes the app, so the relative-base build (issue #40)
 * keeps working on any static host. The password is deliberately not part
 * of the signature.
 */
export function buildRoomLink(roomName: string): string {
  return `${window.location.origin}${window.location.pathname}#room=${encodeURIComponent(roomName)}`
}

/**
 * Consumes a deep link: drops the hash while keeping the path and the
 * query (the `?debug` flag survives) so a reload never re-triggers the
 * join. No-op without a hash. Shared by both hash params (`#room=`,
 * `#contact=`): only the value changes, the consumption discipline is
 * the same.
 */
export function clearRoomHash(): void {
  if (window.location.hash === '') return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

// ---------------------------------------------------------------------------
// Issue #105 phase 3 (spec §12.5) — the contact deep link: the hash carries
// ONLY the identity fingerprint (`#contact=<fp>`), never a nickname or any
// secret. Same discipline as `#room=`: leading '#' optional, percent-decoding
// tolerated, and the value must canonicalize to exactly 32 hex chars (the
// issue #95 rule — spaced display forms and either hex case are accepted);
// anything else routes nothing.
// ---------------------------------------------------------------------------

/**
 * Parses a raw URL hash (`window.location.hash`, leading '#' optional) into
 * the CANONICAL fingerprint a contact link carries. Returns null when the
 * hash carries no usable fingerprint: missing/foreign hash, empty value,
 * malformed percent-encoding, or a value that does not canonicalize to
 * 32 hex — an invalid fp is ignored, never surfaced as an error.
 */
export function parseContactHash(hash: string | null | undefined): string | null {
  if (hash === null || hash === undefined) return null
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith(CONTACT_HASH_PARAM)) return null
  const encoded = raw.slice(CONTACT_HASH_PARAM.length)
  if (encoded === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  if (!isValidFingerprint(decoded)) return null
  return canonicalFingerprint(decoded)
}

/**
 * Builds the shareable contact link of a fingerprint: origin + path +
 * `#contact=<canonical-fp>`. The canonical (compact, uppercase) form is
 * what travels — recipients pasting it back hit the same validation the
 * knock flow applies. Only the hash routes the app, so the relative-base
 * build (issue #40) keeps working on any static host.
 */
export function buildContactLink(fingerprint: string): string {
  const canonical = canonicalFingerprint(fingerprint)
  return `${window.location.origin}${window.location.pathname}#contact=${encodeURIComponent(canonical)}`
}
