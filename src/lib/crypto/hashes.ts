/**
 * Hashing helpers — spec.md §9.4 (roomId derivation) and §9.1 (fingerprint
 * base). Implementations land in M1 together with their test vectors;
 * `newMessageId` is already real (spec §7.2 mandates crypto.randomUUID()).
 */

/** Envelope ids — spec §7.2. Node 22 and all evergreen browsers ship this. */
export function newMessageId(): string {
  return crypto.randomUUID()
}

/**
 * hex(SHA-256)[0..31] of 'gritos/room/v1/' + name [+ '\u0000' + password].
 * With a password the room becomes undiscoverable in the tracker (RF-05).
 */
export async function deriveRoomId(
  _name: string,
  _password?: string,
): Promise<string> {
  throw new Error('not implemented: roomId derivation lands in M1 (spec §9.4)')
}

/** SHA-256 → lowercase hex; fingerprint base (§9.1) and general helper. */
export async function sha256Hex(_input: string | Uint8Array): Promise<string> {
  throw new Error('not implemented: lands in M1/M3 (spec §9.1, §9.4)')
}
