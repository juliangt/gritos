import type { Identity } from '../../stores/useAppStore'
import { sha256Hex } from './hashes'

/**
 * Local identity — spec.md §9.1: ECDH P-256 keypair, raw 65-byte public key
 * hashed into a 4×4-hex fingerprint (TOFU verification in DMs).
 *
 * M1 scope: the keypair is EPHEMERAL per browser session — the manager
 * announces it via the `keys` action and stores peers' raw keys in memory.
 * JWK persistence under `gritos:identity` (§8.2) and regeneration land in
 * M3; those entry points stay stubbed behind the same narrow surface.
 */

export const IDENTITY_STORAGE_KEY = 'gritos:identity'

/** ECDH P-256 keypair (spec §9.1). `extractable` so the raw key can be exported. */
export interface IdentityKeypair {
  publicKey: CryptoKey
  privateKey: CryptoKey
}

/** Shape that M3 will store in localStorage — spec §8.2. */
export interface PersistedIdentity {
  nickname: string
  fingerprint: string
  createdAt: number
  pubJwk: JsonWebKey
  privJwk: JsonWebKey
}

/**
 * Everything the session needs to announce itself: the store-facing
 * `Identity`, the keypair for M3's ECDH, and the raw 65-byte public key
 * that travels over the `keys` action.
 */
export interface SessionIdentity {
  identity: Identity
  keypair: IdentityKeypair
  rawPublicKey: Uint8Array
}

/** Generates the session ECDH P-256 keypair (spec §9.1). */
export async function generateSessionKeypair(): Promise<IdentityKeypair> {
  const keypair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  )
  return keypair as IdentityKeypair
}

/** Exports the public key in raw/uncompressed form: 65 bytes (0x04 ‖ X ‖ Y). */
export async function exportRawPublicKey(
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  return new Uint8Array(raw)
}

/**
 * Pure formatter for the fingerprint digest (§9.1): first 8 bytes of the
 * SHA-256 hex digest, uppercased, in 4 space-separated groups of 4 —
 * e.g. 'A31F 09BC 77D2 4E5A'.
 */
export function formatFingerprint(digestHex: string): string {
  const bytes = digestHex.slice(0, 16)
  return bytes
    .toUpperCase()
    .replace(/(.{4})(?=.)/g, '$1 ')
}

/** SHA-256 of the raw public key, formatted per §9.1. */
export async function computeFingerprint(
  rawPublicKey: Uint8Array,
): Promise<string> {
  return formatFingerprint(await sha256Hex(rawPublicKey))
}

/** Builds the full ephemeral session identity (nickname included). */
export async function createSessionIdentity(
  nickname: string,
): Promise<SessionIdentity> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  const fingerprint = await computeFingerprint(rawPublicKey)
  return {
    identity: { nickname, fingerprint, createdAt: Date.now() },
    keypair,
    rawPublicKey,
  }
}

// ---------------------------------------------------------------------------
// M3 stubs — persistence and regeneration (plan §4, M3). Kept as typed
// placeholders so later milestones extend this surface without reshaping it.
// ---------------------------------------------------------------------------

/** M3: writes the JWK pair under `gritos:identity` (§8.2). */
export function persistIdentity(_identity: PersistedIdentity): void {
  throw new Error('not implemented: identity persistence lands in M3 (spec §8.2)')
}

/** M3: restores the persisted keypair, or null on first visit (RF-01). */
export function loadIdentity(): PersistedIdentity | null {
  throw new Error('not implemented: identity persistence lands in M3 (spec §8.2)')
}

/** M3 (RF-07) — regenerating changes the fingerprint and invalidates DM keys. */
export async function regenerateIdentity(
  _nickname: string,
): Promise<{ identity: Identity; keypair: IdentityKeypair }> {
  throw new Error('not implemented: identity regeneration lands in M3 (RF-07)')
}
