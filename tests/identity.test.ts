import { describe, expect, it } from 'vitest'
import {
  computeFingerprint,
  createSessionIdentity,
  exportRawPublicKey,
  formatFingerprint,
  generateSessionKeypair,
} from '../src/lib/crypto/identity'
import { sha256Hex } from '../src/lib/crypto/hashes'

const FP_FORMAT = /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/

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

describe('fingerprint (spec §9.1)', () => {
  it('formats the digest as 4 uppercase groups of 4 hex chars', () => {
    expect(formatFingerprint('a31f09bc77d24e5a99')).toBe('A31F 09BC 77D2 4E5A')
    expect(formatFingerprint('')).toBe('')
    expect(formatFingerprint('abc')).toBe('ABC')
  })

  it('matches the required format regex for real keys', async () => {
    const keypair = await generateSessionKeypair()
    const raw = await exportRawPublicKey(keypair.publicKey)
    const fingerprint = await computeFingerprint(raw)
    expect(fingerprint).toMatch(FP_FORMAT)
    expect(fingerprint).toHaveLength(19) // 16 hex + 3 spaces
  })

  it('is stable for the same key and equals the manual SHA-256', async () => {
    const keypair = await generateSessionKeypair()
    const raw = await exportRawPublicKey(keypair.publicKey)
    const a = await computeFingerprint(raw)
    const b = await computeFingerprint(raw)
    expect(a).toBe(b)

    const manual = (await sha256Hex(raw)).slice(0, 16).toUpperCase()
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
