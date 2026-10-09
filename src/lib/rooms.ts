/**
 * Room helpers shared by the sidebar/header (RF-02/RF-05). Kept out of
 * component files so they stay unit-testable and eslint react-refresh-clean.
 */

import { connectionStatusText, type Room } from '../stores/useAppStore'

/** Spec RF-02 / §10.1 — suggested rooms offered in the sidebar. */
export const SUGGESTED_ROOMS: readonly string[] = ['lobby', 'general', 'dev', 'random']

/** RF-02 — inline validation message for a non-normalizable room name. */
export const INVALID_ROOM_NAME_TEXT =
  'Only lowercase letters, numbers, hyphens and underscores (1–32 characters)'

/**
 * RF-05 — placeholder stored/rendered when a room chat arrives encrypted
 * and cannot be opened (theoretical no-key/derivation-collision case): the
 * raw ciphertext must NEVER reach the feed as text.
 */
export const ENCRYPTED_MESSAGE_PLACEHOLDER = '🔒 encrypted message'

/**
 * RF-05 — one-line explanation shown under the encrypted-room password field.
 * Issue #31 — the second sentence makes the recents behavior explicit: the
 * name of a password room is never saved in this browser (session-only).
 */
export const ENCRYPTED_ROOM_HINT =
  'Whoever lacks the password will not find this room. Its name is never saved in this browser.'

/** RF-05 — inline error when the encrypted-room toggle is on but the field is empty. */
export const EMPTY_ROOM_PASSWORD_TEXT = 'Write a password for the encrypted room'

/**
 * RNF-07 — text of the non-blocking banner shown at the top of the chat
 * area while any active room sits in the `error` state (§10.3 wording).
 */
export const NETWORK_ERROR_BANNER_TEXT =
  'No tracker access — check your connection or configure alternative trackers'

/**
 * Issue #125 — subtle line under the header status while a room latched the
 * peerless hint: the §10.3 heuristic expired over REACHABLE trackers with
 * zero peers, so the room stays `searching` (an empty room is not a broken
 * network) and this says so without the error banner's wording.
 */
export const PEERLESS_ROOM_HINT_TEXT = 'Still waiting for peers — the room may be empty'

/**
 * Issue #43 — text of the non-blocking banner shown at the top of the chat
 * area when the page runs outside a secure context (plain HTTP on a LAN IP):
 * Web Crypto and WebRTC are unavailable, so the #lobby auto-join is skipped
 * up front instead of rejecting silently. The '(insecure context)' phrasing
 * matches the onboarding error.
 */
export const INSECURE_CONTEXT_BANNER_TEXT =
  'Could not connect — WebRTC and encryption require HTTPS or localhost (insecure context). See the README for serving the app over HTTPS.'

/**
 * §10.3/RF-05 — header status text. A password room that exhausted the
 * error heuristic without finding any peer shows the single not-found
 * message (wrong password and nonexistent room are indistinguishable by
 * design, so one wording covers both). Every other state keeps the exact
 * §10.3 texts.
 */
export function roomStatusText(
  room: Pick<Room, 'hasPassword' | 'status' | 'name' | 'peers'>,
): string {
  if (room.hasPassword && room.status === 'error') {
    return `Room #${room.name} not found with that password`
  }
  return connectionStatusText(room.status, room.peers.length)
}
