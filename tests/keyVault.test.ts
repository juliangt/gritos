import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetKeyVaultForTests,
  unwrapPrivateKey,
  wipeKeyVault,
  wrapPrivateKey,
} from '../src/lib/crypto/keyVault'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from './fakeIndexedDB'

/**
 * Key vault (issue #24): the private JWK is AES-GCM-wrapped with a
 * non-extractable key held in IndexedDB. The suite drives the real crypto
 * (Node's global Web Crypto) against the in-memory IndexedDB stub, plus the
 * v0 passthrough degradation where IndexedDB is missing or broken and the
 * panic wipe.
 */

const PRIV_JWK_JSON = JSON.stringify({
  kty: 'EC',
  crv: 'P-256',
  x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4',
  y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM',
  d: '870MB6gfuTJ4HtUnUvYMyJpr5eUZNP4Bk43bVdj3eAE',
})

function vaultRecords(fake: FakeIndexedDBHandle): Map<string, unknown> | undefined {
  return fake.databases.get('gritos')?.get('keys')
}

beforeEach(() => {
  resetKeyVaultForTests()
})

afterEach(() => {
  resetKeyVaultForTests()
  vi.unstubAllGlobals()
})

describe('wrapPrivateKey / unwrapPrivateKey (v1 envelopes)', () => {
  it('wraps into {v:1, iv, ct} and unwraps back to the exact JWK JSON', async () => {
    const fake = installFakeIndexedDB()
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)

    const parsed = JSON.parse(envelope) as { v: number; iv: string; ct: string }
    expect(parsed.v).toBe(1)
    expect(typeof parsed.iv).toBe('string')
    expect(typeof parsed.ct).toBe('string')
    // Nothing of the plaintext JWK is greppable in the envelope.
    expect(envelope).not.toContain(PRIV_JWK_JSON)
    expect(envelope).not.toContain('"kty"')
    expect(envelope).not.toContain(JSON.parse(PRIV_JWK_JSON).d as string)

    expect(await unwrapPrivateKey(envelope)).toBe(PRIV_JWK_JSON)
    expect(vaultRecords(fake)?.has('identity-wrap')).toBe(true)
  })

  it('persists a non-extractable AES-GCM-256 wrapping key in the vault record', async () => {
    const fake = installFakeIndexedDB()
    await wrapPrivateKey(PRIV_JWK_JSON)

    const key = vaultRecords(fake)?.get('identity-wrap')
    expect(key).toBeInstanceOf(CryptoKey)
    expect((key as CryptoKey).extractable).toBe(false)
    expect((key as CryptoKey).algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect((key as CryptoKey).usages).toEqual(['encrypt', 'decrypt'])
  })

  it('reuses the wrapping key across calls but never the IV', async () => {
    installFakeIndexedDB()
    const first = await wrapPrivateKey(PRIV_JWK_JSON)
    const second = await wrapPrivateKey(PRIV_JWK_JSON)
    expect(first).not.toBe(second) // fresh IV per envelope
    expect(await unwrapPrivateKey(first)).toBe(PRIV_JWK_JSON)
    expect(await unwrapPrivateKey(second)).toBe(PRIV_JWK_JSON)
  })

  it('unwraps after a "reload": fresh session cache, same vault', async () => {
    installFakeIndexedDB()
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    // Simulates a new page load: the in-memory key cache is empty, the
    // IndexedDB vault persists.
    resetKeyVaultForTests()
    expect(await unwrapPrivateKey(envelope)).toBe(PRIV_JWK_JSON)
  })

  it('rejects for a v1 envelope whose wrapping key is gone (wrong key)', async () => {
    const fake = installFakeIndexedDB()
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    vaultRecords(fake)?.delete('identity-wrap')
    resetKeyVaultForTests()
    await expect(unwrapPrivateKey(envelope)).rejects.toThrow('failed to open')
  })

  it('rejects for a v1 envelope when the vault became unavailable', async () => {
    installFakeIndexedDB()
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    vi.stubGlobal('indexedDB', undefined)
    resetKeyVaultForTests()
    await expect(unwrapPrivateKey(envelope)).rejects.toThrow('wrapping key unavailable')
  })
})

describe('graceful degradation (no usable IndexedDB)', () => {
  it('falls back to a v0 passthrough envelope when indexedDB is undefined', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    expect(JSON.parse(envelope)).toEqual({ v: 0, plain: PRIV_JWK_JSON })
    expect(await unwrapPrivateKey(envelope)).toBe(PRIV_JWK_JSON)
  })

  it('falls back when indexedDB.open throws', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('blocked by policy')
      },
    })
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    expect(JSON.parse(envelope)).toMatchObject({ v: 0 })
    expect(await unwrapPrivateKey(envelope)).toBe(PRIV_JWK_JSON)
  })

  it('falls back when the open request fails', async () => {
    installFakeIndexedDB({ openError: new DOMException('denied', 'SecurityError') })
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    expect(JSON.parse(envelope)).toMatchObject({ v: 0 })
    expect(await unwrapPrivateKey(envelope)).toBe(PRIV_JWK_JSON)
  })
})

describe('unwrapPrivateKey rejects for malformed envelopes', () => {
  it('rejects on unparsable, unknown-shape and incomplete envelopes', async () => {
    await expect(unwrapPrivateKey('not json')).rejects.toThrow('malformed envelope')
    await expect(unwrapPrivateKey(JSON.stringify({ v: 9 }))).rejects.toThrow(
      'unknown envelope format',
    )
    await expect(unwrapPrivateKey(JSON.stringify({ v: 1, iv: 'aa' }))).rejects.toThrow(
      'malformed v1 envelope',
    )
    await expect(unwrapPrivateKey(JSON.stringify({ v: 0 }))).rejects.toThrow(
      'malformed v0 envelope',
    )
  })
})

describe('wipeKeyVault (RF-08, issue #24)', () => {
  it('clears the vault so a wiped envelope can no longer be opened', async () => {
    const fake = installFakeIndexedDB()
    const envelope = await wrapPrivateKey(PRIV_JWK_JSON)
    expect(vaultRecords(fake)?.size).toBe(1)

    await wipeKeyVault()

    expect(vaultRecords(fake)?.size).toBe(0)
    // The key is gone: opening the old envelope fails (a fresh key would be
    // generated on the next wrap, never retroactively for this envelope).
    await expect(unwrapPrivateKey(envelope)).rejects.toThrow()
  })

  it('resolves without throwing where IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(wipeKeyVault()).resolves.toBeUndefined()
  })
})
