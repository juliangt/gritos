import { beforeEach, describe, expect, it } from 'vitest'
import {
  DM_KEY_INFO,
  DM_KEY_INFO_V2,
  clearDmKeyCache,
  decryptDm,
  deriveDmKeyV2,
  deriveDmSaltV2,
  encryptDm,
  getCachedDmKey,
  getCachedDmKeyV2,
} from '../src/lib/crypto/dm'
import { generateEphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import type { EphemeralSession } from '../src/lib/crypto/sessionEphemeral'

// Invented long-lived identity fingerprints in display form (8 groups of 4
// hex chars + separators, §9.1): canonicalization strips the spaces and
// uppercases, so A sorts BEFORE B ('09AB…' < 'E1F0…') even though A is
// always the "own" side in the natural calls — exercising the role swap.
const ID_FP_A = 'E1F0 2A3B 4C5D 6E7F 8901 2345 6789 ABCD'
const ID_FP_B = '09ab 11cd 22ef 3301 4455 6677 8899 aabb'

// Fixtures shared per test: A and B are the honest DM ends; E is the
// attacker-controlled ephemeral key whose fingerprint gets substituted.
let sessionA: EphemeralSession
let sessionB: EphemeralSession
let sessionE: EphemeralSession

beforeEach(async () => {
  clearDmKeyCache()
  sessionA = await generateEphemeralSession()
  sessionB = await generateEphemeralSession()
  sessionE = await generateEphemeralSession()
})

describe('migration gate (issue #93, spec §12.1)', () => {
  it('pins the versioned info separators of both derivations', () => {
    expect(DM_KEY_INFO_V2).toBe('gritos/dm/v2')
    // The v1 pin stays: the v1 path must keep its own domain separator.
    expect(DM_KEY_INFO).toBe('gritos/dm/v1')
  })
})

describe('v2 key derivation (spec §12.1)', () => {
  it('derives the SAME key on both ends from role-swapped inputs (A↔B)', async () => {
    // Each side uses its own ephemeral private key, the peer's RAW ephemeral
    // public key, and both fingerprint pairs in opposite argument order.
    const keyA = await getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    const keyB = await getCachedDmKeyV2(
      sessionB.keypair.privateKey,
      sessionA.rawPublicKey,
      ID_FP_B,
      ID_FP_A,
      sessionB.fingerprint,
      sessionA.fingerprint,
    )

    // Non-extractable keys: equality is proven through AES-GCM roundtrips
    // in both directions.
    const sealed = await encryptDm(keyA, 'secreto efímero')
    await expect(decryptDm(keyB, sealed)).resolves.toBe('secreto efímero')

    const reply = await encryptDm(keyB, 'respuesta efímera')
    await expect(decryptDm(keyA, reply)).resolves.toBe('respuesta efímera')
  })

  it('derives the same salt under ANY role swap of the four fingerprints', async () => {
    const a = ID_FP_A
    const b = ID_FP_B
    const c = sessionA.fingerprint
    const d = sessionB.fingerprint
    const base = await deriveDmSaltV2(a, b, c, d)
    expect(base).toHaveLength(32)

    // Every swap of the (own, peer) roles — identity pair, ephemeral pair,
    // or both — hashes the identical four-string sequence.
    const swaps: Array<[string, string, string, string]> = [
      [b, a, d, c],
      [a, b, d, c],
      [b, a, c, d],
      [d, c, b, a],
    ]
    for (const [ownId, peerId, ownEph, peerEph] of swaps) {
      await expect(deriveDmSaltV2(ownId, peerId, ownEph, peerEph)).resolves.toEqual(base)
    }
  })

  it('changes the salt when ANY one of the four fingerprints is flipped', async () => {
    const base = await deriveDmSaltV2(
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    const stranger = sessionE.fingerprint

    // One flip per slot: own identity, peer identity, own ephemeral, peer
    // ephemeral — each must move the salt (the §12.1 binding property).
    const flipped = [
      await deriveDmSaltV2(stranger, ID_FP_B, sessionA.fingerprint, sessionB.fingerprint),
      await deriveDmSaltV2(ID_FP_A, stranger, sessionA.fingerprint, sessionB.fingerprint),
      await deriveDmSaltV2(ID_FP_A, ID_FP_B, stranger, sessionB.fingerprint),
      await deriveDmSaltV2(ID_FP_A, ID_FP_B, sessionA.fingerprint, stranger),
    ]
    for (const salt of flipped) {
      expect(salt).not.toEqual(base)
    }
  })

  it('makes a substituted-ephemeral derivation fail GCM visibly (§12.1 binding)', async () => {
    // The honest A↔B key seals the message.
    const honestKey = await deriveDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    const sealed = await encryptDm(honestKey, 'integridad efímera')

    // An attacker substitutes their own ephemeral key for the peer's: any
    // derivation that mixes the stranger's fingerprint into the salt lands
    // on a DIFFERENT AES key, so the honest ciphertext fails GCM
    // authentication loudly on decrypt instead of ever decrypting — one
    // flip per fingerprint slot.
    const stranger = sessionE.fingerprint
    const wrongKeys = [
      deriveDmKeyV2(
        sessionA.keypair.privateKey,
        sessionB.rawPublicKey,
        stranger,
        ID_FP_B,
        sessionA.fingerprint,
        sessionB.fingerprint,
      ),
      deriveDmKeyV2(
        sessionA.keypair.privateKey,
        sessionB.rawPublicKey,
        ID_FP_A,
        stranger,
        sessionA.fingerprint,
        sessionB.fingerprint,
      ),
      deriveDmKeyV2(
        sessionA.keypair.privateKey,
        sessionB.rawPublicKey,
        ID_FP_A,
        ID_FP_B,
        stranger,
        sessionB.fingerprint,
      ),
      deriveDmKeyV2(
        sessionA.keypair.privateKey,
        sessionB.rawPublicKey,
        ID_FP_A,
        ID_FP_B,
        sessionA.fingerprint,
        stranger,
      ),
    ]
    for (const wrong of wrongKeys) {
      await expect(decryptDm(await wrong, sealed)).rejects.toThrowError()
    }
    // GCM failure surfaces as OperationError, same contract as v1.
    let reason: unknown
    try {
      await decryptDm(await wrongKeys[0], sealed)
    } catch (error) {
      reason = error
    }
    expect(reason).toBeInstanceOf(Error)
    expect((reason as Error).name).toBe('OperationError')
  })

  it('keeps v1 and v2 keys domain-separated (neither opens the other)', async () => {
    // The SAME key material feeds both derivations: only the HKDF salt/info
    // differ (v1: identity-style pair alone with 'gritos/dm/v1'; v2: both
    // pairs with 'gritos/dm/v2') — yet the AES keys must never coincide.
    const v1Key = await getCachedDmKey(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    const v2Key = await getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )

    const v2Sealed = await encryptDm(v2Key, 'solo v2')
    await expect(decryptDm(v1Key, v2Sealed)).rejects.toThrowError()

    const v1Sealed = await encryptDm(v1Key, 'solo v1')
    await expect(decryptDm(v2Key, v1Sealed)).rejects.toThrowError()
  })
})

describe('v2 per-session key cache (§12.1, §9.2 step 5 idiom)', () => {
  it('returns the identical promise per input set until cleared', async () => {
    const first = getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    // Role-swapped arguments canonicalize onto the same cache key.
    const second = getCachedDmKeyV2(
      sessionB.keypair.privateKey,
      sessionA.rawPublicKey,
      ID_FP_B,
      ID_FP_A,
      sessionB.fingerprint,
      sessionA.fingerprint,
    )
    expect(second).toBe(first)
    await expect(first).resolves.toBeDefined()

    // clearDmKeyCache empties the v2 cache too: the next call resolves to a
    // fresh key (a new promise object, not the cached one).
    clearDmKeyCache()
    const regenerated = getCachedDmKeyV2(
      sessionA.keypair.privateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    expect(regenerated).not.toBe(first)
    await expect(regenerated.then((key) => encryptDm(key, 'ok'))).resolves.toBeDefined()
  })

  it('evicts a failed derivation so the next call retries fresh', async () => {
    // A non-ECDH private key makes the derivation reject; the failed entry
    // must evict itself so the retry is a NEW promise, not the same one.
    const badPrivateKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt'],
    )
    const first = getCachedDmKeyV2(
      badPrivateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    await expect(first).rejects.toThrowError()

    const second = getCachedDmKeyV2(
      badPrivateKey,
      sessionB.rawPublicKey,
      ID_FP_A,
      ID_FP_B,
      sessionA.fingerprint,
      sessionB.fingerprint,
    )
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrowError()
  })
})
