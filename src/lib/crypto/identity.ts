import type { Identity } from '../../stores/useAppStore'
import { sha256Hex } from './hashes'

/**
 * Local identity — spec.md §9.1: ECDH P-256 keypair, raw 65-byte public key
 * hashed into a 4×4-hex fingerprint (TOFU verification in DMs).
 *
 * M2 scope: the keypair itself stays EPHEMERAL per browser session; what is
 * persisted under `gritos:identity` (§8.2) is the profile
 * `{nickname, fingerprint, createdAt}` so returning visitors skip
 * onboarding. The JWK pair (pubJwk/privJwk) and regeneration land in M3 —
 * the persisted shape is typed open for them below.
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
  /** M3: exported JWKs (spec §8.2). Optional until DM crypto lands. */
  pubJwk?: JsonWebKey
  privJwk?: JsonWebKey
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
  const keypair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveKey',
    'deriveBits',
  ])
  return keypair as IdentityKeypair
}

/** Exports the public key in raw/uncompressed form: 65 bytes (0x04 ‖ X ‖ Y). */
export async function exportRawPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
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
  return bytes.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
}

/** SHA-256 of the raw public key, formatted per §9.1. */
export async function computeFingerprint(rawPublicKey: Uint8Array): Promise<string> {
  return formatFingerprint(await sha256Hex(rawPublicKey))
}

/** Builds the full ephemeral session identity (nickname included). */
export async function createSessionIdentity(nickname: string): Promise<SessionIdentity> {
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
// M2 persistence (profile only — §8.2). M3 extends the stored payload with
// the JWK pair; the readers below already pass unknown fields through.
// ---------------------------------------------------------------------------

/** Writes the persisted profile under `gritos:identity` (§8.2, RF-01). */
export function persistIdentity(identity: PersistedIdentity): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity))
  } catch {
    // Quota/privacy-mode failure: identity stays session-only.
  }
}

/**
 * Restores the persisted profile, or null on first visit / corrupted
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

/** M3 (RF-07) — regenerating changes the fingerprint and invalidates DM keys. */
export async function regenerateIdentity(
  _nickname: string,
): Promise<{ identity: Identity; keypair: IdentityKeypair }> {
  throw new Error('not implemented: identity regeneration lands in M3 (RF-07)')
}
