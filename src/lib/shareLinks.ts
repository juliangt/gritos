/**
 * Room share deep links (issue #41): the URL hash carries ONLY the room
 * name — `#sala=<encoded-name>` — never the password (RF-05: whoever opens
 * a link to a password room must enter it through the regular join flow).
 * Pure helpers, testable without a network; `parseRoomHash` reuses the exact
 * join-validation rules (RF-02 normalization) so a link can never smuggle a
 * room name the join popover would reject.
 */

import { normalizeRoomName } from './p2p/roomManager'

/** Hash parameter identifying a room deep link: `#sala=<name>`. */
export const ROOM_HASH_PARAM = 'sala='

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
 * Builds the shareable link of a room: origin + path + `#sala=<encoded>`.
 * Only the hash routes the app, so the relative-base build (issue #40)
 * keeps working on any static host. The password is deliberately not part
 * of the signature.
 */
export function buildRoomLink(roomName: string): string {
  return `${window.location.origin}${window.location.pathname}#sala=${encodeURIComponent(roomName)}`
}

/**
 * Consumes a deep link: drops the hash while keeping the path and the
 * query (the `?debug` flag survives) so a reload never re-triggers the
 * join. No-op without a hash.
 */
export function clearRoomHash(): void {
  if (window.location.hash === '') return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}
