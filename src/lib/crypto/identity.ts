import type { Identity } from '../../stores/useAppStore'
import { sha256Hex } from './hashes'

/**
 * Local identity — spec.md §9.1 + §8.2: ECDH P-256 keypair generated on the
 * first run (or when regenerating), raw 65-byte public key hashed into an
 * 8×4-hex fingerprint (issue #23: 128 displayed bits, TOFU verification in
 * DMs). The JWK pair is persisted
 * under `gritos:identity` as `{nickname, fingerprint, createdAt, pubJwk,
 * privJwk}` so the same keypair survives reloads; identities persisted by
 * M2 (profile only, no JWKs) are migrated in place preserving the nickname.
 */

export const IDENTITY_STORAGE_KEY = 'gritos:identity'

/** ECDH P-256 keypair (spec §9.1). `extractable` so the raw key can be exported. */
export interface IdentityKeypair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

/** Shape stored in localStorage under `gritos:identity` — spec §8.2. */
export interface PersistedIdentity {
  nickname: string
  fingerprint: string
  createdAt: number
  /** JWK of the public key (spec §8.2). */
  pubJwk?: JsonWebKey
  /** JWK of the private key (spec §8.2). */
  privJwk?: JsonWebKey
}

/**
 * Everything the session needs to announce itself: the store-facing
 * `Identity`, the keypair for ECDH, and the raw 65-byte public key that
 * travels over the `keys` action.
 */
export interface SessionIdentity {
  identity: Identity
  keypair: IdentityKeypair
  rawPublicKey: Uint8Array
}

const ECDH_ALG: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' }

/** Generates the session ECDH P-256 keypair (spec §9.1). */
export async function generateSessionKeypair(): Promise<IdentityKeypair> {
  const keypair = await crypto.subtle.generateKey(ECDH_ALG, true, ['deriveKey', 'deriveBits'])
  return keypair as IdentityKeypair
}

/** Exports the public key in raw/uncompressed form: 65 bytes (0x04 ‖ X ‖ Y). */
export async function exportRawPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  return new Uint8Array(raw)
}

/** Exports both keys as JWK for `gritos:identity` persistence (§8.2). */
export async function exportIdentityJwks(
  keypair: IdentityKeypair,
): Promise<{ pubJwk: JsonWebKey; privJwk: JsonWebKey }> {
  const [pubJwk, privJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keypair.publicKey),
    crypto.subtle.exportKey('jwk', keypair.privateKey),
  ])
  return { pubJwk, privJwk }
}

/**
 * Re-imports a persisted JWK pair into live CryptoKeys. The resulting
 * keypair is bit-identical to the one exported: derive operations and the
 * raw public key match the original session.
 */
export async function importIdentityKeypair(
  pubJwk: JsonWebKey,
  privJwk: JsonWebKey,
): Promise<IdentityKeypair> {
  const publicKey = await crypto.subtle.importKey('jwk', pubJwk, ECDH_ALG, true, [])
  const privateKey = await crypto.subtle.importKey('jwk', privJwk, ECDH_ALG, true, [
    'deriveKey',
    'deriveBits',
  ])
  return { publicKey, privateKey } as IdentityKeypair
}

/** True when the persisted record already carries the JWK pair (§8.2). */
export function hasIdentityJwks(
  persisted: Partial<PersistedIdentity> | null,
): persisted is PersistedIdentity & { pubJwk: JsonWebKey; privJwk: JsonWebKey } {
  return (
    persisted !== null &&
    typeof persisted === 'object' &&
    persisted.pubJwk !== undefined &&
    persisted.privJwk !== undefined
  )
}

/**
 * Pure formatter for the fingerprint digest (§9.1, issue #23): first 16
 * bytes (128 bits) of the SHA-256 hex digest, uppercased, in 8
 * space-separated groups of 4 — e.g.
 * 'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678'. Display-only: anything past
 * the 32nd hex char is ignored, so a full 64-hex digest is accepted too.
 */
export function formatFingerprint(digestHex: string): string {
  const bytes = digestHex.slice(0, 32)
  return bytes.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

/** SHA-256 of the raw public key, formatted per §9.1. */
export async function computeFingerprint(rawPublicKey: Uint8Array): Promise<string> {
  return formatFingerprint(await sha256Hex(rawPublicKey))
}

/**
 * Builds a full identity from a fresh keypair: the fingerprint is always
 * recomputed from the raw public key so the announced value matches the
 * crypto material bit for bit.
 */
export async function createSessionIdentity(nickname: string): Promise<SessionIdentity> {
  const keypair = await generateSessionKeypair()
  return attachRawKey({ nickname, keypair })
}

async function attachRawKey(params: {
  nickname: string
  keypair: IdentityKeypair
}): Promise<SessionIdentity> {
  const rawPublicKey = await exportRawPublicKey(params.keypair.publicKey)
  const fingerprint = await computeFingerprint(rawPublicKey)
  return {
    identity: { nickname: params.nickname, fingerprint, createdAt: Date.now() },
    keypair: params.keypair,
    rawPublicKey,
  }
}

// ---------------------------------------------------------------------------
// Persistence (§8.2 `gritos:identity`)
// ---------------------------------------------------------------------------

/** Writes the persisted identity under `gritos:identity` (§8.2, RF-01). */
export function persistIdentity(identity: PersistedIdentity): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Quota/privacy-mode failure: identity stays session-only.
  }
}

/**
 * Restores the persisted identity, or null on first visit / corrupted
 * payload (RF-01: no onboarding when a valid identity exists).
 */
export function loadIdentity(): PersistedIdentity | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(IDENTITY_STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedIdentity> | null
    if (typeof parsed !== 'object' || parsed === null) return null
    if (
      typeof parsed.nickname !== 'string' ||
      typeof parsed.fingerprint !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null
    }
    return {
      nickname: parsed.nickname,
      fingerprint: parsed.fingerprint,
      createdAt: parsed.createdAt,
      pubJwk: parsed.pubJwk,
      privJwk: parsed.privJwk,
    }
  } catch {
    return null
  }
}

/**
 * Restores a session identity from the persisted record (§8.2 → §9.1).
 * With JWKs present the exact keypair is re-imported, so reloads keep the
 * same fingerprint and ECDH material. Pre-M3 records (profile only) are
 * migrated: a fresh keypair is generated, the fingerprint is recomputed
 * from it and the record is re-persisted with the nickname/createdAt
 * preserved. The returned `migrated` flag reports which path ran.
 */
export async function restoreSessionIdentity(
  persisted: PersistedIdentity,
): Promise<{ session: SessionIdentity; migrated: boolean }> {
  if (hasIdentityJwks(persisted)) {
    const keypair = await importIdentityKeypair(persisted.pubJwk, persisted.privJwk)
    const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
    // Trust the key material: the fingerprint is recomputed from the raw
    // public key so it can never drift from what peers will verify.
    const fingerprint = await computeFingerprint(rawPublicKey)
    return {
      session: {
        identity: {
          nickname: persisted.nickname,
          fingerprint,
          createdAt: persisted.createdAt,
        },
        keypair,
        rawPublicKey,
      },
      migrated: false,
    }
  }

  // Migration from the M2 profile-only shape: keep nickname/createdAt, bind
  // a real keypair, and re-persist the merged §8.2 record.
  const session = await createSessionIdentity(persisted.nickname)
  const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
  persistIdentity({
    nickname: persisted.nickname,
    fingerprint: session.identity.fingerprint,
    createdAt: persisted.createdAt,
    pubJwk,
    privJwk,
  })
  session.identity.createdAt = persisted.createdAt
  return { session, migrated: true }
}

/**
 * Regenerates the identity (RF-07 acceptance, UI wiring lands in M5): a new
 * ECDH keypair with a new fingerprint is created, persisted under
 * `gritos:identity` and returned. Call sites must also invalidate the
 * per-session DM key cache (`clearDmKeyCache` in lib/crypto/dm.ts) and
 * re-announce presence + keys — both are wiring concerns of the session
 * layer, not of this module.
 */
export async function regenerateIdentity(nickname: string): Promise<SessionIdentity> {
  const session = await createSessionIdentity(nickname)
  const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
  persistIdentity({
    nickname: session.identity.nickname,
    fingerprint: session.identity.fingerprint,
    createdAt: session.identity.createdAt,
    pubJwk,
    privJwk,
  })
  return session
}
