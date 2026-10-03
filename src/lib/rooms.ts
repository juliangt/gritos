/**
 * Room helpers shared by the sidebar/header (RF-02/RF-05). Kept out of
 * component files so they stay unit-testable and eslint react-refresh-clean.
 */

import { connectionStatusText, type Room } from '../stores/useAppStore'

/** Spec RF-02 / §10.1 — suggested rooms offered in the sidebar. */
export const SUGGESTED_ROOMS: readonly string[] = ['lobby', 'general', 'dev', 'random']

/** RF-02 — inline validation message for a non-normalizable room name. */
export const INVALID_ROOM_NAME_TEXT =
  'Solo minúsculas, números, guiones y guion bajo (1–32 caracteres)'

/**
 * RF-05 — placeholder stored/rendered when a room chat arrives encrypted
 * and cannot be opened (theoretical no-key/derivation-collision case): the
 * raw ciphertext must NEVER reach the feed as text.
 */
export const ENCRYPTED_MESSAGE_PLACEHOLDER = '🔒 mensaje cifrado'

/** RF-05 — one-line explanation shown under the encrypted-room password field. */
export const ENCRYPTED_ROOM_HINT = 'Quien no tenga la contraseña no encontrará esta sala.'

/** RF-05 — inline error when the encrypted-room toggle is on but the field is empty. */
export const EMPTY_ROOM_PASSWORD_TEXT = 'Escribe una contraseña para la sala cifrada'

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
    return `No se ha encontrado la sala #${room.name} con esa contraseña`
  }
  return connectionStatusText(room.status, room.peers.length)
}
