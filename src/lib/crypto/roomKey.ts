import {
  DM_IV_BYTES,
  decryptDm,
  encryptDm,
  type SealedPayload,
} from './dm'

/**
 * Password-protected rooms — spec.md §9.3:
 *
 * 1. `salt = SHA-256('gritos/room-salt/v1/' + normalizedName)` —
 *    deterministic and public by design (it only prevents per-room rainbow
 *    tables; it is not secret).
 * 2. `roomKey = PBKDF2-SHA256(password, salt, 600 000 iterations, 32 B)`
 *    → non-extractable AES-GCM-256 key. A pure function of (password,
 *    name): independent of the identity — regenerating the identity never
 *    changes room keys (RF-05).
 * 3. Message sealing is IDENTICAL to the DM format (§9.3 step 3 = §9.2
 *    step 4): random 12-byte IV per message, wire blob
 *    `base64(IV ‖ ciphertext)`, Envelope `iv` = base64 of the IV alone.
 *    The sealing helpers of `dm.ts` are reused verbatim so chat and DM
 *    ciphertexts keep the exact same shape on the wire.
 * 4. The password and the derived key live only in session memory
 *    (`roomManager`); they are never persisted — after a reload the user
 *    re-enters the password (RF-05).
 *
 * Everything runs on Web Crypto (`crypto.subtle`); no hand-rolled
 * primitives.
 */

/** §9.3 step 1 — deterministic, public salt domain separator. */
export const ROOM_SALT_PREFIX = 'gritos/room-salt/v1/'

/**
 * §9.3 step 2 — PBKDF2 work factor. Fixed by the spec (≥ 600 000); both
 * ends must agree to derive the same key.
 */
export const PBKDF2_ITERATIONS = 600_000

/** AES-GCM nonce length in bytes — identical to the DM wire format. */
export const ROOM_IV_BYTES = DM_IV_BYTES

const textEncoder = new TextEncoder()

/**
 * §9.3 step 1 — `SHA-256('gritos/room-salt/v1/' + name)` as 32 raw bytes.
 * Deterministic: the same name always yields the same public salt.
 */
export async function deriveRoomSalt(roomName: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(ROOM_SALT_PREFIX + roomName),
  )
  return new Uint8Array(digest)
}

/**
 * §9.3 step 2 — derives the room key with PBKDF2-SHA256 (600 000
 * iterations, the room salt, 32 bytes) → non-extractable AES-GCM-256
 * `CryptoKey` usable for encrypt/decrypt. Depends only on the password and
 * the room name — never on the identity (RF-05 identity-regeneration
 * invariance).
 */
export async function deriveRoomKey(
  password: string,
  roomName: string,
): Promise<CryptoKey> {
  const salt = await deriveRoomSalt(roomName)
  const baseKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * §9.3 step 3 — seals a room message exactly like a DM: random 12-byte IV,
 * AES-GCM-256, `{iv: base64(IV), payload: base64(IV ‖ ct)}`. Plaintext
 * above the protocol limit (4000 chars, §7.3) is rejected before any crypto
 * work. Reuses `encryptDm` verbatim so both wire formats cannot drift.
 */
export async function encryptRoomMessage(
  key: CryptoKey,
  plaintext: string,
): Promise<SealedPayload> {
  return encryptDm(key, plaintext)
}

/**
 * Opens a sealed room message (§9.3 step 3): splits the 12-byte IV from the
 * blob, verifies the Envelope `iv` field matches it and checks the GCM tag.
 * Tampered or wrong-key ciphertexts reject (OperationError); malformed
 * payloads throw RangeError. Reuses `decryptDm` verbatim.
 */
export async function decryptRoomMessage(
  key: CryptoKey,
  payload: SealedPayload,
): Promise<string> {
  return decryptDm(key, payload)
}
