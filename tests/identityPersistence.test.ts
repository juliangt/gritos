// @vitest-environment jsdom
import './dom-setup'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IDENTITY_STORAGE_KEY,
  computeFingerprint,
  createSessionIdentity,
  exportIdentityJwks,
  importIdentityKeypair,
  loadIdentity,
  persistIdentity,
  regenerateIdentity,
  restoreSessionIdentity,
} from '../src/lib/crypto/identity'

// jsdom + real timers: the suite only needs localStorage and Node's global
// Web Crypto (both available without fake timers).

beforeEach(() => {
  localStorage.clear()
})

describe('identity persistence — M3 JWK storage (§8.2)', () => {
  it('persists {nickname, fingerprint, createdAt, pubJwk, privJwk} and restores the SAME keypair after a reload', async () => {
    // First visit: create + persist exactly like the onboarding entry point.
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })

    // "Reload": read the persisted record back and re-import the keys.
    const restoredRecord = loadIdentity()
    expect(restoredRecord).not.toBeNull()
    const restored = await restoreSessionIdentity(restoredRecord as NonNullable<typeof restoredRecord>)

    expect(restored.migrated).toBe(false)
    expect(restored.session.identity).toEqual({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
    })
    expect(restored.session.rawPublicKey).toEqual(session.rawPublicKey)

    // Bit-level equality: same ECDH secret from the reloaded private key.
    const bitsBefore = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: session.keypair.publicKey },
      session.keypair.privateKey,
      256,
    )
    const bitsAfter = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: restored.session.keypair.publicKey },
      restored.session.keypair.privateKey,
      256,
    )
    expect(new Uint8Array(bitsAfter)).toEqual(new Uint8Array(bitsBefore))
    expect(await importIdentityKeypair(pubJwk, privJwk)).toBeDefined()
  })

  it('keeps the raw JSON shape of gritos:identity per §8.2', async () => {
    const session = await createSessionIdentity('luna-cauta')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    persistIdentity({
      nickname: 'luna-cauta',
      fingerprint: session.identity.fingerprint,
      createdAt: 1_700_000_000_000,
      pubJwk,
      privJwk,
    })
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) as string) as Record<
      string,
      unknown
    >
    expect(Object.keys(parsed).sort()).toEqual(
      ['createdAt', 'fingerprint', 'nickname', 'privJwk', 'pubJwk'].sort(),
    )
    expect(parsed.createdAt).toBe(1_700_000_000_000)
  })

  it('migrates a pre-M3 profile-only record: nickname kept, real keypair bound (§8.2)', async () => {
    // The exact M2 persisted shape — no JWKs, fingerprint of an ephemeral key.
    localStorage.setItem(
      IDENTITY_STORAGE_KEY,
      JSON.stringify({
        nickname: 'zorro-bravo',
        fingerprint: 'A31F 09BC 77D2 4E5A',
        createdAt: 1_700_000_000_000,
      }),
    )

    const { session, migrated } = await restoreSessionIdentity(loadIdentity() as NonNullable<
      ReturnType<typeof loadIdentity>
    >)
    expect(migrated).toBe(true)
    // The nickname (and createdAt) survive; the fingerprint now matches a
    // real persisted keypair.
    expect(session.identity.nickname).toBe('zorro-bravo')
    expect(session.identity.createdAt).toBe(1_700_000_000_000)
    expect(await computeFingerprint(session.rawPublicKey)).toBe(session.identity.fingerprint)
    expect(session.identity.fingerprint).not.toBe('A31F 09BC 77D2 4E5A')

    // The record was merged in place: §8.2 shape with the JWK pair added.
    const merged = loadIdentity()
    expect(merged?.nickname).toBe('zorro-bravo')
    expect(merged?.createdAt).toBe(1_700_000_000_000)
    expect(merged?.pubJwk).toBeDefined()
    expect(merged?.privJwk).toBeDefined()

    // A second restore takes the no-migration path and returns the same key.
    const again = await restoreSessionIdentity(merged as NonNullable<ReturnType<typeof loadIdentity>>)
    expect(again.migrated).toBe(false)
    expect(again.session.rawPublicKey).toEqual(session.rawPublicKey)
  })

  it('regeneration replaces the persisted record with a new keypair and fingerprint', async () => {
    const session = await createSessionIdentity('luna-cauta')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    persistIdentity({
      nickname: 'luna-cauta',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })

    const regenerated = await regenerateIdentity('zorro-bravo')
    expect(regenerated.identity.fingerprint).not.toBe(session.identity.fingerprint)

    const stored = loadIdentity()
    expect(stored?.nickname).toBe('zorro-bravo')
    expect(stored?.fingerprint).toBe(regenerated.identity.fingerprint)
    expect(stored?.pubJwk).toBeDefined()
    // Reload restores the regenerated key, not the old one.
    const reloaded = await restoreSessionIdentity(stored as NonNullable<ReturnType<typeof loadIdentity>>)
    expect(reloaded.session.rawPublicKey).toEqual(regenerated.rawPublicKey)
  })
})
