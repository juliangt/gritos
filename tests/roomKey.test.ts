import { describe, expect, it } from 'vitest'
import {
  PBKDF2_ITERATIONS,
  ROOM_IV_BYTES,
  ROOM_SALT_PREFIX,
  decryptRoomMessage,
  deriveRoomKey,
  deriveRoomSalt,
  encryptRoomMessage,
} from '../src/lib/crypto/roomKey'
import {
  base64ToBytes,
  bytesToBase64,
  decryptDm,
  encryptDm,
  type SealedPayload,
} from '../src/lib/crypto/dm'
import { regenerateIdentity } from '../src/lib/crypto/identity'

/**
 * Password-room crypto — spec §9.3 (plan.md §6.1 roomKey row). Vectors
 * pinned against an independent reference (shasum -a 256):
 *   salt = SHA-256('gritos/room-salt/v1/' + name)
 */

async function hexToBytes(hex: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/** Two "fresh clients": each derives from scratch, nothing shared. */
function deriveTwice(password: string, name: string): Promise<[CryptoKey, CryptoKey]> {
  return Promise.all([deriveRoomKey(password, name), deriveRoomKey(password, name)])
}

describe('deriveRoomSalt (spec §9.3 step 1)', () => {
  it('matches the hardcoded reference vectors', async () => {
    await expect(deriveRoomSalt('lobby')).resolves.toEqual(
      await hexToBytes('d41626e2285eca2e98818f49ce852403157181425c4463f0871052d37f95f856'),
    )
    await expect(deriveRoomSalt('mi-sala')).resolves.toEqual(
      await hexToBytes('8588f4daf83ce20b1e59054188a02b843e09ea9f979514588b243c094f49b6ac'),
    )
  })

  it('is deterministic and 32 bytes long', async () => {
    const first = await deriveRoomSalt('sala')
    const second = await deriveRoomSalt('sala')
    expect(second).toEqual(first)
    expect(first).toHaveLength(32)
    expect(ROOM_SALT_PREFIX).toBe('gritos/room-salt/v1/')
  })

  it('differs for different names', async () => {
    expect(await deriveRoomSalt('sala')).not.toEqual(await deriveRoomSalt('salas'))
  })
})

describe('deriveRoomKey (spec §9.3 step 2)', () => {
  it('derives the SAME key in different clients for the same password+name', async () => {
    // The keys are non-extractable; equality is proven through AES-GCM: what
    // one client seals, the other opens.
    const [keyA, keyB] = await deriveTwice('contraseña-compartida', 'sala-secreta')
    const sealed = await encryptRoomMessage(keyA, 'hola sala')
    await expect(decryptRoomMessage(keyB, sealed)).resolves.toBe('hola sala')
  })

  it('derives a different key for a different password (decrypt fails)', async () => {
    const good = await deriveRoomKey('buena', 'sala')
    const bad = await deriveRoomKey('mala', 'sala')
    const sealed = await encryptRoomMessage(good, 'secreto')
    await expect(decryptRoomMessage(bad, sealed)).rejects.toThrowError()
  })

  it('derives a different salt and key for a different name', async () => {
    const saltA = await deriveRoomSalt('sala')
    const saltB = await deriveRoomSalt('otra')
    expect(saltB).not.toEqual(saltA)

    const [keyA, keyB] = await Promise.all([
      deriveRoomKey('misma-contraseña', 'sala'),
      deriveRoomKey('misma-contraseña', 'otra'),
    ])
    const sealed = await encryptRoomMessage(keyA, 'contenido')
    await expect(decryptRoomMessage(keyB, sealed)).rejects.toThrowError()
  })

  it('is case- and whitespace-sensitive in the password', async () => {
    const [keyA, keyB] = await Promise.all([
      deriveRoomKey('Contraseña', 'sala'),
      deriveRoomKey('contraseña', 'sala'),
    ])
    const sealed = await encryptRoomMessage(keyA, 'x')
    await expect(decryptRoomMessage(keyB, sealed)).rejects.toThrowError()
  })

  it('pins the spec parameters (600 000 iterations, 12-byte IV)', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000)
    expect(ROOM_IV_BYTES).toBe(12)
  })

  it('completes a full derivation well under a second on this machine', async () => {
    const start = performance.now()
    await deriveRoomKey('timing', 'sala')
    const elapsedMs = performance.now() - start
    // Plan §M4: measured < 1 s on desktop. Generous 3 s guard for slow CI.
    expect(elapsedMs).toBeLessThan(3_000)
    expect(elapsedMs).toBeLessThan(1_000)
  }, 10_000)
})

describe('encrypt/decrypt roundtrip (spec §9.3 step 3)', () => {
  it('roundtrips plaintext through base64(IV ‖ ciphertext)', async () => {
    const key = await deriveRoomKey('pw', 'sala')
    const text = '¡hola **sala**! — utf-8 ✓ emoji 🙈'
    const sealed = await encryptRoomMessage(key, text)

    // Wire shape identical to the DM format: base64 blob of IV ‖ ct plus the
    // §7.2 iv field carrying the same IV on its own.
    const blob = base64ToBytes(sealed.payload)
    expect(blob.length).toBeGreaterThan(ROOM_IV_BYTES)
    expect(base64ToBytes(sealed.iv)).toHaveLength(ROOM_IV_BYTES)
    expect(sealed.iv).toBe(bytesToBase64(blob.slice(0, ROOM_IV_BYTES)))

    await expect(decryptRoomMessage(key, sealed)).resolves.toBe(text)
  })

  it('is wire-compatible with the DM format (same helpers, same shape)', async () => {
    const key = await deriveRoomKey('pw', 'sala')
    const roomSealed = await encryptRoomMessage(key, 'mismo formato')
    // A room payload decrypts through the DM helper and vice versa.
    await expect(decryptDm(key, roomSealed)).resolves.toBe('mismo formato')
    const dmSealed = await encryptDm(key, 'y al revés')
    await expect(decryptRoomMessage(key, dmSealed as SealedPayload)).resolves.toBe('y al revés')
  })

  it('uses a fresh random IV per message', async () => {
    const key = await deriveRoomKey('pw', 'sala')
    const first = await encryptRoomMessage(key, 'mismo texto')
    const second = await encryptRoomMessage(key, 'mismo texto')
    expect(first.iv).not.toBe(second.iv)
    expect(first.payload).not.toBe(second.payload)
  })

  it('rejects tampered ciphertext (GCM tag)', async () => {
    const key = await deriveRoomKey('pw', 'sala')
    const sealed = await encryptRoomMessage(key, 'integridad')
    const blob = base64ToBytes(sealed.payload)
    blob[blob.length - 1] ^= 0x01
    let reason: unknown
    try {
      await decryptRoomMessage(key, { iv: sealed.iv, payload: bytesToBase64(blob) })
    } catch (error) {
      reason = error
    }
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).name).toBe('OperationError')
  })

  it('rejects an Envelope iv inconsistent with the payload blob', async () => {
    const key = await deriveRoomKey('pw', 'sala')
    const sealed = await encryptRoomMessage(key, 'iv check')
    await expect(
      decryptRoomMessage(key, { iv: bytesToBase64(new Uint8Array(12).fill(1)), payload: sealed.payload }),
    ).rejects.toThrowError()
  })
})

describe('identity-regeneration invariance (RF-05)', () => {
  it('room keys are a function of name+password only: regenerating the identity changes nothing', async () => {
    const keyBefore = await deriveRoomKey('pw-de-sala', 'sala-estable')
    const sealedBefore = await encryptRoomMessage(keyBefore, 'sobrevive a la regeneración')

    // Regenerate the cryptographic identity (new ECDH keypair + fingerprint).
    const regenerated = await regenerateIdentity('nuevo-apodo')
    expect(regenerated.identity.fingerprint).not.toBe('')

    const keyAfter = await deriveRoomKey('pw-de-sala', 'sala-estable')
    // Same key material: the pre-regeneration message still opens, and a
    // post-regeneration seal is identical in shape.
    await expect(decryptRoomMessage(keyAfter, sealedBefore)).resolves.toBe(
      'sobrevive a la regeneración',
    )
    const sealedAfter = await encryptRoomMessage(keyAfter, 'tras regenerar')
    await expect(decryptRoomMessage(keyBefore, sealedAfter)).resolves.toBe('tras regenerar')
  })
})
