import { describe, expect, it } from 'vitest'
import {
  computeFingerprint,
  createSessionIdentity,
  exportIdentityJwks,
  exportRawPublicKey,
  formatFingerprint,
  generateSessionKeypair,
  hasIdentityJwks,
  importIdentityKeypair,
  regenerateIdentity,
} from '../src/lib/crypto/identity'
import { sha256Hex } from '../src/lib/crypto/hashes'

const FP_FORMAT = /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/

describe('identity keypair (spec §9.1)', () => {
  it('generates an extractable ECDH P-256 pair', async () => {
    const keypair = await generateSessionKeypair()
    expect(keypair.publicKey.algorithm).toMatchObject({ name: 'ECDH' })
    expect(keypair.privateKey.algorithm).toMatchObject({
      name: 'ECDH',
      namedCurve: 'P-256',
    })
    expect(keypair.publicKey.extractable).toBe(true)
    // WebCrypto: ECDH public keys carry no usages; the private key derives.
    expect(keypair.publicKey.usages).toEqual([])
    expect(keypair.privateKey.usages).toContain('deriveKey')
    expect(keypair.privateKey.usages).toContain('deriveBits')
  })

  it('exports the public key in raw form: 65 bytes starting with 0x04', async () => {
    const keypair = await generateSessionKeypair()
    const raw = await exportRawPublicKey(keypair.publicKey)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.byteLength).toBe(65)
    expect(raw[0]).toBe(0x04)
  })

  it('is usable without DOM: runs in the node test environment', async () => {
    // This file runs with the vitest node environment; the module only needs
    // the global Web Crypto (crypto.subtle), never window/document.
    const identity = await createSessionIdentity('zorro-bravo')
    expect(identity.identity.nickname).toBe('zorro-bravo')
    expect(typeof identity.identity.createdAt).toBe('number')
    expect(identity.rawPublicKey.byteLength).toBe(65)
  })
})

describe('fingerprint (spec §9.1, issue #23: 128 bits)', () => {
  it('formats the first 32 hex chars as 8 uppercase groups of 4', () => {
    expect(formatFingerprint('a31f09bc77d24e5a51c0ffee12345678')).toBe(
      'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678',
    )
    expect(formatFingerprint('')).toBe('')
    expect(formatFingerprint('abc')).toBe('ABC')
  })

  it('accepts a full 64-hex digest and ignores everything past 128 bits', () => {
    const fullDigest = 'a31f09bc77d24e5a51c0ffee12345678' + '99'.repeat(16)
    expect(fullDigest).toHaveLength(64)
    expect(formatFingerprint(fullDigest)).toBe('A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678')
  })

  it('matches the required format regex for real keys', async () => {
    const keypair = await generateSessionKeypair()
    const raw = await exportRawPublicKey(keypair.publicKey)
    const fingerprint = await computeFingerprint(raw)
    expect(fingerprint).toMatch(FP_FORMAT)
    expect(fingerprint).toHaveLength(39) // 32 hex + 7 spaces
  })

  it('is stable for the same key and equals the manual SHA-256', async () => {
    const keypair = await generateSessionKeypair()
    const raw = await exportRawPublicKey(keypair.publicKey)
    const a = await computeFingerprint(raw)
    const b = await computeFingerprint(raw)
    expect(a).toBe(b)

    const manual = (await sha256Hex(raw)).slice(0, 32).toUpperCase()
    expect(a).toBe(manual.replace(/(.{4})(?=.)/g, '$1 '))
  })

  it('differs between different keys', async () => {
    const rawA = await exportRawPublicKey((await generateSessionKeypair()).publicKey)
    const rawB = await exportRawPublicKey((await generateSessionKeypair()).publicKey)
    expect(await computeFingerprint(rawA)).not.toBe(await computeFingerprint(rawB))
  })
})

describe('createSessionIdentity', () => {
  it('returns a coherent identity bundle', async () => {
    const session = await createSessionIdentity('luna-cauta')
    expect(session.identity.fingerprint).toMatch(FP_FORMAT)
    expect(await computeFingerprint(session.rawPublicKey)).toBe(
      session.identity.fingerprint,
    )
    // The keypair can derive bits (ECDH) — M3 builds on this.
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: session.keypair.publicKey,
      },
      session.keypair.privateKey,
      256,
    )
    expect(bits.byteLength).toBe(32)
  })
})

describe('JWK export/import roundtrip (spec §8.2 + §9.1)', () => {
  it('re-imports the persisted JWK pair into the identical keypair', async () => {
    const keypair = await generateSessionKeypair()
    const rawBefore = await exportRawPublicKey(keypair.publicKey)
    const { pubJwk, privJwk } = await exportIdentityJwks(keypair)

    expect(pubJwk.kty).toBe('EC')
    expect(pubJwk.crv).toBe('P-256')

    const restored = await importIdentityKeypair(pubJwk, privJwk)
    const rawAfter = await exportRawPublicKey(restored.publicKey)
    expect(rawAfter).toEqual(rawBefore)

    // The restored pair performs the same ECDH: identical derived bits.
    const bitsBefore = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: keypair.publicKey },
      keypair.privateKey,
      256,
    )
    const bitsAfter = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: restored.publicKey },
      restored.privateKey,
      256,
    )
    expect(new Uint8Array(bitsAfter)).toEqual(new Uint8Array(bitsBefore))

    // The fingerprint from the restored key matches the original.
    expect(await computeFingerprint(rawAfter)).toBe(await computeFingerprint(rawBefore))
  })

  it('flags records with and without the JWK pair', () => {
    expect(hasIdentityJwks({ pubJwk: { kty: 'EC' }, privJwk: { kty: 'EC' } })).toBe(true)
    expect(
      hasIdentityJwks({ nickname: 'x', fingerprint: 'fp', createdAt: 1 }),
    ).toBe(false)
    expect(hasIdentityJwks(null)).toBe(false)
  })
})

describe('regenerateIdentity (RF-07 API, M3)', () => {
  it('creates a different fingerprint and a fresh usable keypair', async () => {
    const first = await createSessionIdentity('zorro-bravo')
    const second = await regenerateIdentity('zorro-bravo')

    expect(second.identity.nickname).toBe('zorro-bravo')
    expect(second.identity.fingerprint).toMatch(FP_FORMAT)
    expect(second.identity.fingerprint).not.toBe(first.identity.fingerprint)
    expect(second.rawPublicKey).not.toEqual(first.rawPublicKey)
    expect(second.identity.createdAt).toBeGreaterThanOrEqual(first.identity.createdAt)

    // The regenerated keypair is a working ECDH pair.
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: second.keypair.publicKey },
      second.keypair.privateKey,
      256,
    )
    expect(bits.byteLength).toBe(32)
  })
})
