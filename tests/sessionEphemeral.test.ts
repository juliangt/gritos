import { beforeEach, describe, expect, it } from 'vitest'
import {
  ensureEphemeralSession,
  generateEphemeralSession,
  getEphemeralSession,
  setEphemeralSession,
} from '../src/lib/crypto/sessionEphemeral'
import { computeFingerprint } from '../src/lib/crypto/identity'

// Same format the identity fingerprint uses (spec §9.1, issue #23): 32 hex
// chars in 8 uppercase groups of 4 — see tests/identity.test.ts.
const FP_FORMAT = /^[0-9A-F]{4}( [0-9A-F]{4}){7}$/

beforeEach(() => {
  setEphemeralSession(null)
})

describe('generateEphemeralSession (spec §12.1, issue #93)', () => {
  it('returns a 65-byte raw public key and a fingerprint in the identity format', async () => {
    const session = await generateEphemeralSession()

    expect(session.rawPublicKey).toBeInstanceOf(Uint8Array)
    expect(session.rawPublicKey.byteLength).toBe(65)
    expect(session.rawPublicKey[0]).toBe(0x04)

    expect(session.fingerprint).toMatch(FP_FORMAT)
    expect(session.fingerprint).toHaveLength(39) // 32 hex + 7 spaces
    expect(session.fingerprint.replace(/\s+/g, '')).toMatch(/^[0-9A-F]{32}$/)
    // Announced value and crypto material never drift: recomputed from the raw key.
    expect(await computeFingerprint(session.rawPublicKey)).toBe(session.fingerprint)
  })

  it('uses the same keypair shape as the identity key (§9.1)', async () => {
    const session = await generateEphemeralSession()
    expect(session.keypair.publicKey.algorithm).toMatchObject({ name: 'ECDH' })
    expect(session.keypair.privateKey.algorithm).toMatchObject({
      name: 'ECDH',
      namedCurve: 'P-256',
    })
    expect(session.keypair.publicKey.extractable).toBe(true)
    // WebCrypto: ECDH public keys carry no usages; the private key derives.
    expect(session.keypair.publicKey.usages).toEqual([])
    expect(session.keypair.privateKey.usages).toContain('deriveKey')
    expect(session.keypair.privateKey.usages).toContain('deriveBits')
  })

  it('generates different keys and fingerprints on every call', async () => {
    const a = await generateEphemeralSession()
    const b = await generateEphemeralSession()
    expect(b.rawPublicKey).not.toEqual(a.rawPublicKey)
    expect(b.fingerprint).not.toBe(a.fingerprint)
  })
})

describe('per-session holder (§12.1 — memory only, never persisted)', () => {
  it('starts empty and caches the same object across ensureEphemeralSession calls', async () => {
    expect(getEphemeralSession()).toBeNull()

    const first = await ensureEphemeralSession()
    const second = await ensureEphemeralSession()
    expect(second).toBe(first)
    expect(getEphemeralSession()).toBe(first)
  })

  it('generates a fresh session after setEphemeralSession(null)', async () => {
    const first = await ensureEphemeralSession()

    setEphemeralSession(null)
    expect(getEphemeralSession()).toBeNull()

    const second = await ensureEphemeralSession()
    expect(second).not.toBe(first)
    expect(second.fingerprint).not.toBe(first.fingerprint)
  })

  it('accepts an explicitly installed session', async () => {
    const session = await generateEphemeralSession()
    setEphemeralSession(session)
    expect(getEphemeralSession()).toBe(session)
    await expect(ensureEphemeralSession()).resolves.toBe(session)
  })
})

describe('ECDH agreement between two ephemeral sessions (§12.1)', () => {
  it('derives the same 256-bit secret from each side against the other raw key', async () => {
    const a = await generateEphemeralSession()
    const b = await generateEphemeralSession()

    // Each side imports the peer's RAW public key (the wire form that
    // `ephkeys` will carry) and combines it with its own private key.
    const importedForA = await crypto.subtle.importKey(
      'raw',
      b.rawPublicKey as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    )
    const importedForB = await crypto.subtle.importKey(
      'raw',
      a.rawPublicKey as BufferSource,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    )

    const bitsA = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedForA },
      a.keypair.privateKey,
      256,
    )
    const bitsB = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: importedForB },
      b.keypair.privateKey,
      256,
    )

    expect(bitsA.byteLength).toBe(32)
    expect(new Uint8Array(bitsB)).toEqual(new Uint8Array(bitsA))
  })
})
