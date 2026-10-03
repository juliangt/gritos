/**
 * Hashing helpers — spec.md §9.4 (roomId derivation) and §9.1 (fingerprint
 * base). Everything goes through Web Crypto (`crypto.subtle`), which Node 22
 * ships globally, so the module is testable without DOM or network.
 */

/** Spec §9.4 — constant derivation domain prefix. */
export const ROOM_HASH_PREFIX = 'gritos/room/v1/'

/** Derived roomId length: hex(SHA-256)[0..31] → 32 lowercase hex chars. */
export const ROOM_ID_LENGTH = 32

const textEncoder = new TextEncoder()

/** Envelope ids — spec §7.2. Node 22 and all evergreen browsers ship this. */
export function newMessageId(): string {
  return crypto.randomUUID()
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** SHA-256 → lowercase hex; fingerprint base (§9.1) and general helper. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === 'string' ? textEncoder.encode(input) : (input as Uint8Array)
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return toHex(new Uint8Array(digest))
}

/**
 * hex(SHA-256)[0..31] of 'gritos/room/v1/' + name [+ '\u0000' + password]
 * (spec §9.4). The password path mixes bytes directly, so the NUL separator
 * never collides with UTF-8 text. With a password the room becomes
 * undiscoverable in the tracker (RF-05): the name-only hash yields a
 * different namespace.
 */
export async function deriveRoomId(
  name: string,
  password?: string,
): Promise<string> {
  const chunks: Uint8Array[] = [textEncoder.encode(ROOM_HASH_PREFIX + name)]
  if (password !== undefined) {
    chunks.push(Uint8Array.of(0x00), textEncoder.encode(password))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const input = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    input.set(chunk, offset)
    offset += chunk.length
  }
  return (await sha256Hex(input)).slice(0, ROOM_ID_LENGTH)
}
