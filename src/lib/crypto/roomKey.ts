import type { SealedPayload } from './dm'

/**
 * Password-protected rooms — spec.md §9.3: deterministic public salt from
 * the normalized room name, PBKDF2-SHA256 with ≥600k iterations →
 * AES-GCM-256, random 12-byte IV per message. The password lives only in
 * session memory and is never persisted. Implementation lands in M4.
 */

export const PBKDF2_ITERATIONS = 600_000

/**
 * salt = SHA-256('gritos/room-salt/v1/' + normalized name) — deterministic
 * and public by design (§9.3 step 1).
 */
export async function deriveRoomSalt(_roomName: string): Promise<Uint8Array> {
  throw new Error('not implemented: room-key crypto lands in M4 (spec §9.3)')
}

export async function deriveRoomKey(
  _roomName: string,
  _password: string,
): Promise<CryptoKey> {
  throw new Error('not implemented: room-key crypto lands in M4 (spec §9.3)')
}

export async function encryptRoomMessage(
  _key: CryptoKey,
  _plaintext: string,
): Promise<SealedPayload> {
  throw new Error('not implemented: room-key crypto lands in M4 (spec §9.3)')
}

export async function decryptRoomMessage(
  _key: CryptoKey,
  _payload: SealedPayload,
): Promise<string> {
  throw new Error('not implemented: room-key crypto lands in M4 (spec §9.3)')
}
