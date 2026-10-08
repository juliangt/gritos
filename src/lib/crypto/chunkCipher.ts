/**
 * Binary chunk sealing for P2P file transfer — spec.md §12.4 (issue #103,
 * phase 2), the ADDITIVE BINARY SIBLING of the §9.2/§9.3 message seal.
 *
 * File chunks are sealed with the SAME AES-GCM-256 `CryptoKey`s as chat and
 * DM messages (password rooms: the §9.3 room key; DMs: the §9.2 v2 DM key),
 * so a file inherits exactly the confidentiality of the conversation it is
 * sent in — no extra salt, no new key material (§12.4 «sin sal adicional»).
 * The ONLY difference from `encryptDm`/`encryptRoomMessage` is the wire
 * shape: those transmit `base64(IV ‖ ct)` (a ~34% size inflation that is
 * fine for ≤ 4000-char texts), while chunks travel as RAW BYTES —
 * `bytes(IV ‖ ct)` — because the §12.4 frame budget is byte-exact: the
 * plaintext slice is `FILE_CHUNK_PAYLOAD_BYTES = 16 356` (16 KiB − 28), so
 * the sealed payload lands at exactly 16 KiB (12 B IV + 16 B GCM tag of
 * overhead). These helpers never base64. The text formats keep their own
 * helpers untouched; the interop tests pin that ONE key opens BOTH shapes,
 * so the formats cannot silently drift.
 *
 * Fresh random 12-byte IV per chunk, exactly like per-message: with ≤ 1 283
 * chunks per transfer (20 MB cap) and ≤ 3 concurrent transfers per peer,
 * the collision odds of a 96-bit IV are the same negligible order as chat
 * messages' (§12.4).
 *
 * Failure is closed: `openChunk` only ever returns bytes that passed GCM
 * authentication — tampered or wrong-key input rejects with a
 * `ChunkCipherError` ('authentication'), and input shorter than IV + tag
 * rejects with `ChunkCipherError` ('malformed') BEFORE any crypto work.
 * A garbage plaintext is impossible by construction (Web Crypto GCM either
 * authenticates or throws).
 *
 * NOT this module's job: the 16 356-byte slice discipline and the frame
 * layout (`8 B fileId ‖ uint32 BE seq ‖ payload`) belong to the Phase 3
 * engine (`lib/p2p/fileTransfer.ts`). A plaintext larger than the slice
 * seals fine here — the engine is the one that must slice before sealing.
 *
 * Everything runs on Web Crypto (`crypto.subtle`); no hand-rolled
 * primitives.
 */

/** AES-GCM nonce length in bytes — identical to the §9.2/§9.3 message formats. */
export const CHUNK_IV_BYTES = 12

/** AES-GCM authentication tag length in bytes (Web Crypto default). */
export const CHUNK_TAG_BYTES = 16

/**
 * Fixed per-chunk overhead of the binary seal: IV + GCM tag. §12.4 pins the
 * plaintext slice at 16 KiB − 28 = 16 356 B so a sealed chunk is exactly
 * 16 KiB regardless of the encryption mode.
 */
export const CHUNK_SEAL_OVERHEAD_BYTES = CHUNK_IV_BYTES + CHUNK_TAG_BYTES

/** Why `openChunk` refused a sealed chunk. */
export type ChunkCipherErrorReason =
  | 'malformed' // shorter than IV + tag: not a sealed chunk at all
  | 'authentication' // GCM tag failed: tampered, corrupted or wrong key

/**
 * Typed refusal of `openChunk`. GCM failure NEVER yields plaintext: `reason`
 * tells a corrupted/tampered/wrong-key stream ('authentication') apart from
 * a frame that is not a sealed chunk at all ('malformed'), and `cause`
 * keeps the underlying WebCrypto rejection (OperationError).
 */
export class ChunkCipherError extends Error {
  readonly reason: ChunkCipherErrorReason

  constructor(reason: ChunkCipherErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ChunkCipherError'
    this.reason = reason
  }
}

/**
 * Seals one file chunk: random 12-byte IV, AES-GCM-256 with the conversation
 * key (room key or DM key — both are plain AES-GCM `CryptoKey`s), output =
 * `IV ‖ ciphertext+tag` as RAW BYTES (no base64, §12.4). Exactly
 * `CHUNK_SEAL_OVERHEAD_BYTES` (28) bytes longer than `plaintext`.
 */
export async function sealChunk(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(CHUNK_IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource),
  )
  const sealed = new Uint8Array(CHUNK_IV_BYTES + ciphertext.length)
  sealed.set(iv)
  sealed.set(ciphertext, CHUNK_IV_BYTES)
  return sealed
}

/**
 * Opens a sealed chunk: splits the 12-byte IV from the blob and verifies the
 * GCM tag. Tampered, corrupted or wrong-key input rejects with
 * `ChunkCipherError` ('authentication', the WebCrypto OperationError as
 * `cause`) — a garbage plaintext is never returned. Input shorter than
 * IV + tag rejects with `ChunkCipherError` ('malformed') before any crypto
 * work, mirroring the decryptDm malformed-payload gate.
 */
export async function openChunk(key: CryptoKey, sealedChunk: Uint8Array): Promise<Uint8Array> {
  if (sealedChunk.length < CHUNK_SEAL_OVERHEAD_BYTES) {
    throw new ChunkCipherError(
      'malformed',
      `The sealed chunk is ${sealedChunk.length} B; the minimum is ${CHUNK_SEAL_OVERHEAD_BYTES} B (IV + tag)`,
    )
  }
  const iv = sealedChunk.slice(0, CHUNK_IV_BYTES)
  const ciphertext = sealedChunk.slice(CHUNK_IV_BYTES)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext as BufferSource,
    )
    return new Uint8Array(plaintext)
  } catch (error) {
    throw new ChunkCipherError(
      'authentication',
      'The chunk does not authenticate with this key (invalid GCM tag)',
      { cause: error },
    )
  }
}
