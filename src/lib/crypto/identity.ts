import type { Identity } from '../../stores/useAppStore'

/**
 * Local identity — spec.md §9.1: ECDH P-256 keypair generated on first
 * run, raw public key hashed into a 4×4-hex fingerprint (TOFU), JWK
 * public+private persisted under `gritos:identity` (§8.2).
 * Implementation lands in M3.
 */

export const IDENTITY_STORAGE_KEY = 'gritos:identity'

export interface IdentityKeypair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

/** Shape stored in localStorage — spec §8.2. */
export interface PersistedIdentity {
  nickname: string
  fingerprint: string
  createdAt: number
  pubJwk: JsonWebKey
  privJwk: JsonWebKey
}

/** SHA-256(raw public key) → 'A31F 09BC 77D2 4E5A' format (§9.1). */
export function formatFingerprint(_rawPublicKey: Uint8Array): string {
  throw new Error('not implemented: identity crypto lands in M3 (spec §9.1)')
}

export async function generateIdentity(
  _nickname: string,
): Promise<{ identity: Identity; keypair: IdentityKeypair }> {
  throw new Error('not implemented: identity crypto lands in M3 (spec §9.1)')
}

export function persistIdentity(_identity: PersistedIdentity): void {
  throw new Error('not implemented: identity crypto lands in M3 (spec §9.1)')
}

/** Restores the persisted keypair, or null on first visit (RF-01). */
export function loadIdentity(): PersistedIdentity | null {
  throw new Error('not implemented: identity crypto lands in M3 (spec §9.1)')
}

/** RF-07 — regenerating changes the fingerprint and invalidates DM keys. */
export async function regenerateIdentity(
  _nickname: string,
): Promise<{ identity: Identity; keypair: IdentityKeypair }> {
  throw new Error('not implemented: identity crypto lands in M3 (spec §9.1)')
}
