import { beforeAll, describe, expect, it } from 'vitest'
import {
  CHUNK_IV_BYTES,
  CHUNK_SEAL_OVERHEAD_BYTES,
  CHUNK_TAG_BYTES,
  ChunkCipherError,
  openChunk,
  sealChunk,
} from '../src/lib/crypto/chunkCipher'
import { decryptRoomMessage, deriveRoomKey, encryptRoomMessage } from '../src/lib/crypto/roomKey'
import {
  base64ToBytes,
  bytesToBase64,
  clearDmKeyCache,
  decryptDm,
  encryptDm,
  getCachedDmKeyV2,
  type SealedPayload,
} from '../src/lib/crypto/dm'
import { generateEphemeralSession, type EphemeralSession } from '../src/lib/crypto/sessionEphemeral'

/**
 * Binary chunk sealing — spec §12.4 (issue #103, phase 2): the additive
 * BINARY sibling of the §9.2/§9.3 base64 message seal. One key (room or
 * DM) opens both shapes, the sealed payload is plaintext + 28 B exactly
 * (so the §12.4 16 356-byte plaintext slice lands at exactly 16 KiB), and
 * authentication failure is closed — a typed ChunkCipherError, never a
 * garbage plaintext.
 *
 * PBKDF2 budget: room-key derivation is ~600 000 iterations, so the suite
 * performs EXACTLY ONE deriveRoomKey (beforeAll) and reuses it across the
 * room-path and interop assertions. Everything else uses fast AES/HKDF
 * keys.
 */

// Invented long-lived identity fingerprints (same shape as dmV2.test.ts).
const ID_FP_A = 'E1F0 2A3B 4C5D 6E7F 8901 2345 6789 ABCD'
const ID_FP_B = '09ab 11cd 22ef 3301 4455 6677 8899 aabb'

/** Deterministic binary filler (covers every byte value incl. 0x00/0xFF). */
function bytesOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 7 + 13) % 256
  }
  return bytes
}

/** A fresh AES-GCM-256 key, extractable, fast — no KDF involved. */
async function freshAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>
}

/** Views a raw binary seal through the base64 SealedPayload shape (§9.2/§9.3). */
function asSealedPayload(sealed: Uint8Array): SealedPayload {
  return {
    iv: bytesToBase64(sealed.slice(0, CHUNK_IV_BYTES)),
    payload: bytesToBase64(sealed),
  }
}

describe('seal format constants (spec §12.4 arithmetic)', () => {
  it('pins IV + tag = 28 B, the §12.4 overhead of the binary seal', () => {
    expect(CHUNK_IV_BYTES).toBe(12)
    expect(CHUNK_TAG_BYTES).toBe(16)
    expect(CHUNK_SEAL_OVERHEAD_BYTES).toBe(28)
  })

  it('pins the §12.4 slice arithmetic: 16 KiB − 28 = 16 356 plaintext → 16 384 sealed', () => {
    const sealedPayloadCap = 16 * 1024
    expect(sealedPayloadCap - CHUNK_SEAL_OVERHEAD_BYTES).toBe(16_356)
    expect(16_356 + CHUNK_SEAL_OVERHEAD_BYTES).toBe(16_384)
  })
})

describe('sealChunk/openChunk round-trip (§12.4 seal-then-frame)', () => {
  let key: CryptoKey

  beforeAll(async () => {
    key = await freshAesKey()
  })

  it('round-trips byte-exact across the §12.4 sizes (1 B, 255 B, the 16 356 B slice, 16 KiB)', async () => {
    for (const length of [1, 255, 16_356, 16_384]) {
      const plaintext = bytesOf(length)
      await expect(openChunk(key, await sealChunk(key, plaintext))).resolves.toEqual(plaintext)
    }
  })

  it('seals with EXACTLY 28 bytes of overhead: 16 356 B of plaintext → 16 384 B sealed', async () => {
    // The pinned §12.4 case: the engine's maximum plaintext slice must land
    // the sealed payload exactly on the 16 KiB frame budget.
    const sealed = await sealChunk(key, bytesOf(16_356))
    expect(sealed.length).toBe(16_384)
    expect(sealed.length).toBe(16_356 + CHUNK_SEAL_OVERHEAD_BYTES)

    // And the overhead is fixed for every size (no padding, no base64).
    for (const length of [1, 255, 16_384]) {
      const other = await sealChunk(key, bytesOf(length))
      expect(other.length).toBe(length + CHUNK_SEAL_OVERHEAD_BYTES)
    }
  })

  it('uses a fresh random IV per chunk: two seals of the same plaintext differ', async () => {
    const plaintext = bytesOf(64)
    const first = await sealChunk(key, plaintext)
    const second = await sealChunk(key, plaintext)
    expect(second).not.toEqual(first)
    expect(second.slice(0, CHUNK_IV_BYTES)).not.toEqual(first.slice(0, CHUNK_IV_BYTES))
  })
})

describe('openChunk fails closed (§12.4 typed refusal)', () => {
  let key: CryptoKey
  let otherKey: CryptoKey

  beforeAll(async () => {
    key = await freshAesKey()
    otherKey = await freshAesKey()
  })

  it('rejects a tampered GCM tag with ChunkCipherError (authentication)', async () => {
    const sealed = await sealChunk(key, bytesOf(100))
    sealed[sealed.length - 1] ^= 0x01
    try {
      await openChunk(key, sealed)
      expect.unreachable('openChunk must not resolve on a tampered tag')
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkCipherError)
      expect((error as ChunkCipherError).reason).toBe('authentication')
      expect((error as Error).cause).toBeInstanceOf(Error)
      expect(((error as Error).cause as Error).name).toBe('OperationError')
    }
  })

  it('rejects a tampered ciphertext byte with ChunkCipherError (authentication)', async () => {
    const sealed = await sealChunk(key, bytesOf(100))
    sealed[CHUNK_IV_BYTES] ^= 0x80
    await expect(openChunk(key, sealed)).rejects.toBeInstanceOf(ChunkCipherError)
  })

  it('rejects a wrong key with an AUTHENTICATION failure, never garbage plaintext', async () => {
    const sealed = await sealChunk(key, bytesOf(100))
    try {
      await openChunk(otherKey, sealed)
      expect.unreachable('openChunk must not resolve under a wrong key')
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkCipherError)
      expect((error as ChunkCipherError).reason).toBe('authentication')
    }
  })

  it('rejects input shorter than IV + tag as MALFORMED, before any crypto work', async () => {
    for (const length of [0, 1, CHUNK_IV_BYTES, CHUNK_SEAL_OVERHEAD_BYTES - 1]) {
      try {
        await openChunk(key, bytesOf(length))
        expect.unreachable(`openChunk must reject a ${length}-byte frame`)
      } catch (error) {
        expect(error).toBeInstanceOf(ChunkCipherError)
        expect((error as ChunkCipherError).reason).toBe('malformed')
      }
    }
  })
})

describe('room-key path (§9.3 key through the §12.4 binary seal)', () => {
  // ONE PBKDF2 derivation for the whole suite — every assertion below
  // reuses this key.
  let roomKey: CryptoKey

  beforeAll(async () => {
    roomKey = await deriveRoomKey('piedra-papel', 'sala-chunks')
  })

  it('round-trips binary plaintext (non-UTF-8 bytes included) with the room key', async () => {
    const plaintext = Uint8Array.from([0x00, 0x01, 0xff, 0x80, 0x7f, 0xfe])
    const sealed = await sealChunk(roomKey, plaintext)
    expect(sealed.length).toBe(plaintext.length + CHUNK_SEAL_OVERHEAD_BYTES)
    await expect(openChunk(roomKey, sealed)).resolves.toEqual(plaintext)
  })

  it('interop: the SAME room key opens the binary seal through the base64 helpers', async () => {
    const text = 'sellado binario, abierto en base64'
    const sealed = await sealChunk(roomKey, new TextEncoder().encode(text))
    // The binary blob IS base64(IV ‖ ct) before the encoding: the message
    // helpers accept it verbatim as a SealedPayload.
    await expect(decryptRoomMessage(roomKey, asSealedPayload(sealed))).resolves.toBe(text)
    await expect(decryptDm(roomKey, asSealedPayload(sealed))).resolves.toBe(text)
  })

  it('interop: the SAME room key opens the base64 seal through the binary opener', async () => {
    const text = 'sellado base64, abierto en binario — 🙈 utf-8 ✓'
    const sealed = await encryptRoomMessage(roomKey, text)
    const opened = await openChunk(roomKey, base64ToBytes(sealed.payload))
    expect(new TextDecoder().decode(opened)).toBe(text)
  })
})

describe('DM-key path (§9.2 v2 key through the §12.4 binary seal)', () => {
  let sessionA: EphemeralSession
  let sessionB: EphemeralSession
  let sessionE: EphemeralSession
  let dmKeyAB: CryptoKey
  let dmKeyAE: CryptoKey

  beforeAll(async () => {
    clearDmKeyCache()
    sessionA = await generateEphemeralSession()
    sessionB = await generateEphemeralSession()
    sessionE = await generateEphemeralSession()
    // A↔B is the honest pair; A↔E shares endpoint A but a DIFFERENT peer
    // ephemeral — the cross-pair key that must fail authentication.
    dmKeyAB = await getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    dmKeyAE = await getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionE.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionE.fingerprint,
    )
  })

  it('round-trips binary plaintext with the cached v2 DM key', async () => {
    const plaintext = Uint8Array.from([0xde, 0xad, 0x00, 0xbe, 0xef, 0x01])
    const sealed = await sealChunk(dmKeyAB, plaintext)
    expect(sealed.length).toBe(plaintext.length + CHUNK_SEAL_OVERHEAD_BYTES)
    await expect(openChunk(dmKeyAB, sealed)).resolves.toEqual(plaintext)
  })

  it('a cross-pair DM key fails authentication (not garbage)', async () => {
    const sealed = await sealChunk(dmKeyAB, bytesOf(64))
    try {
      await openChunk(dmKeyAE, sealed)
      expect.unreachable('openChunk must not resolve under a cross-pair key')
    } catch (error) {
      expect(error).toBeInstanceOf(ChunkCipherError)
      expect((error as ChunkCipherError).reason).toBe('authentication')
    }
  })

  it('interop: the SAME DM key opens both shapes (base64 helpers and binary opener)', async () => {
    const text = 'clave dm v2, dos formatos'
    const sealedBinary = await sealChunk(dmKeyAB, new TextEncoder().encode(text))
    await expect(decryptDm(dmKeyAB, asSealedPayload(sealedBinary))).resolves.toBe(text)

    const sealedText = await encryptDm(dmKeyAB, text)
    const opened = await openChunk(dmKeyAB, base64ToBytes(sealedText.payload))
    expect(new TextDecoder().decode(opened)).toBe(text)
  })
})
