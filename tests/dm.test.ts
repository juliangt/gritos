import { beforeEach, describe, expect, it } from 'vitest'
import {
  DM_IV_BYTES,
  DM_KEY_INFO,
  base64ToBytes,
  bytesToBase64,
  canonicalFingerprint,
  clearDmKeyCache,
  decryptDm,
  deriveDmKey,
  deriveDmSalt,
  encryptDm,
  getCachedDmKey,
  orderedFingerprints,
} from '../src/lib/crypto/dm'
import { MAX_PLAINTEXT_LENGTH } from '../src/lib/p2p/protocol'
import { sha256Hex } from '../src/lib/crypto/hashes'
import { computeFingerprint, exportRawPublicKey, generateSessionKeypair } from '../src/lib/crypto/identity'

interface Peer {
  keypair: CryptoKeyPair
  rawPublicKey: Uint8Array
  fingerprint: string
  id: string
}

async function makePeer(id: string): Promise<Peer> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  return { keypair, rawPublicKey, fingerprint: await computeFingerprint(rawPublicKey), id }
}

// Fixtures shared per test: A and B are the DM ends; C is the eavesdropping
// third peer with a different keypair and fingerprint.
let A: Peer
let B: Peer
let C: Peer

beforeEach(async () => {
  clearDmKeyCache()
  A = await makePeer('peer-a')
  B = await makePeer('peer-b')
  C = await makePeer('peer-c')
})

describe('DM key derivation (spec §9.2)', () => {
  it('derives the SAME key on both ends from mirrored inputs (A↔B)', async () => {
    // Each side uses its own private key, the peer's RAW public key, and the
    // two fingerprints in opposite argument order (§9.2 steps 2–3).
    const keyA = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const keyB = await deriveDmKey(B.keypair.privateKey, A.rawPublicKey, B.fingerprint, A.fingerprint)

    // The keys are non-extractable; equality is proven through AES-GCM:
    // what A seals, B opens, in both directions.
    const sealed = await encryptDm(keyA, 'hola margen')
    await expect(decryptDm(keyB, sealed)).resolves.toBe('hola margen')

    const reply = await encryptDm(keyB, 'hola origen')
    await expect(decryptDm(keyA, reply)).resolves.toBe('hola origen')
  })

  it('uses salt = SHA-256 of the ordered fingerprint pair and info gritos/dm/v1', async () => {
    // Ordering is symmetric: both ends hash the same concatenated pair.
    const saltAB = await deriveDmSalt(A.fingerprint, B.fingerprint)
    const saltBA = await deriveDmSalt(B.fingerprint, A.fingerprint)
    expect(saltAB).toEqual(saltBA)
    expect(saltAB).toHaveLength(32)

    expect(orderedFingerprints('BB', 'AA')).toEqual(['AA', 'BB'])
    expect(orderedFingerprints('aa', 'BB')).toEqual(['AA', 'BB']) // canonical: uppercase, no spaces
    expect(canonicalFingerprint('A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678')).toBe(
      'A31F09BC77D24E5A51C0FFEE12345678',
    )
    expect(DM_KEY_INFO).toBe('gritos/dm/v1')
  })

  it('hashes the 128-bit canonical fingerprints into the salt (issue #23)', async () => {
    // The salt is SHA-256 over the first 32 hex chars of each digest (the
    // displayed fingerprint), NOT the old 64-bit truncation: pinning it so a
    // format regression cannot sneak back in.
    const [first, second] = orderedFingerprints(
      (await sha256Hex(A.rawPublicKey)).slice(0, 32),
      (await sha256Hex(B.rawPublicKey)).slice(0, 32),
    )
    const manual = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(first + second)),
    )
    await expect(deriveDmSalt(A.fingerprint, B.fingerprint)).resolves.toEqual(manual)
  })

  it('derives the same key from fingerprints of different code-path origins', async () => {
    // A uses its locally computed fingerprint; B receives A's as an
    // announced display string that traveled through presence/storage (any
    // case, any whitespace). canonicalFingerprint normalizes both, so both
    // ends land on the same salt and the same AES key.
    const announced = canonicalFingerprint(A.fingerprint).toLowerCase()
    expect(announced).not.toBe(A.fingerprint) // genuinely a different string form

    const keyA = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const keyB = await deriveDmKey(B.keypair.privateKey, A.rawPublicKey, B.fingerprint, announced)

    const sealed = await encryptDm(keyA, 'mismos orígenes')
    await expect(decryptDm(keyB, sealed)).resolves.toBe('mismos orígenes')
  })

  it('derives different keys for different fingerprint pairs', async () => {
    // Salt differs (fpB vs fpC) → the AES key differs: sealed for A↔B is
    // garbage under the A↔C key (this is also the third-peer attack test).
    const keyAB = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const keyAC = await deriveDmKey(A.keypair.privateKey, C.rawPublicKey, A.fingerprint, C.fingerprint)
    const sealed = await encryptDm(keyAB, 'secreto')
    await expect(decryptDm(keyAC, sealed)).rejects.toThrowError()
  })
})

describe('encrypt/decrypt roundtrip (§9.2 step 4)', () => {
  it('roundtrips plaintext through base64(IV ‖ ciphertext)', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const text = '¡hola **mundo**! — utf-8 ✓ emoji 🙈'
    const sealed = await encryptDm(key, text)

    // Wire shape: base64 payload of IV ‖ ct, plus the §7.2 iv field.
    const blob = base64ToBytes(sealed.payload)
    expect(blob.length).toBeGreaterThan(DM_IV_BYTES)
    expect(base64ToBytes(sealed.iv)).toHaveLength(DM_IV_BYTES)
    expect(sealed.iv).toBe(bytesToBase64(blob.slice(0, DM_IV_BYTES)))

    await expect(decryptDm(key, sealed)).resolves.toBe(text)
  })

  it('uses a fresh random IV per message', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const first = await encryptDm(key, 'mismo texto')
    const second = await encryptDm(key, 'mismo texto')
    expect(first.iv).not.toBe(second.iv)
    expect(first.payload).not.toBe(second.payload)
  })

  it('rejects plaintext above the 4000-char protocol limit (§7.3)', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    await expect(encryptDm(key, 'a'.repeat(MAX_PLAINTEXT_LENGTH))).resolves.toBeDefined()
    await expect(encryptDm(key, 'a'.repeat(MAX_PLAINTEXT_LENGTH + 1))).rejects.toThrowError(
      RangeError,
    )
  })
})

describe('tamper resistance (GCM tag)', () => {
  it('fails with OperationError when a ciphertext byte is flipped', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const sealed = await encryptDm(key, 'integridad')

    // Flip one byte INSIDE the ciphertext portion (after the 12-byte IV).
    const blob = base64ToBytes(sealed.payload)
    blob[blob.length - 1] ^= 0x01
    const tampered = { iv: sealed.iv, payload: bytesToBase64(blob) }

    let reason: unknown
    try {
      await decryptDm(key, tampered)
    } catch (error) {
      reason = error
    }
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).name).toBe('OperationError')
    await expect(decryptDm(key, tampered)).rejects.toThrowError()
  })

  it('fails when the IV portion is flipped', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const sealed = await encryptDm(key, 'otra')
    const blob = base64ToBytes(sealed.payload)
    blob[0] ^= 0xff
    await expect(
      decryptDm(key, { iv: sealed.iv, payload: bytesToBase64(blob) }),
    ).rejects.toThrowError()
  })

  it('rejects payloads too short to carry an IV', async () => {
    const key = await deriveDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    await expect(decryptDm(key, { iv: '', payload: bytesToBase64(new Uint8Array(8)) })).rejects.toThrowError()
  })
})

describe('per-session key cache (§9.2 step 5)', () => {
  it('returns the same cached key per fingerprint pair until cleared', async () => {
    const first = await getCachedDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    const second = await getCachedDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    expect(second).toBe(first)

    clearDmKeyCache()
    const regenerated = await getCachedDmKey(A.keypair.privateKey, B.rawPublicKey, A.fingerprint, B.fingerprint)
    expect(regenerated).not.toBe(first)
  })
})
