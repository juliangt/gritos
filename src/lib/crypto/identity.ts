import type { Identity } from '../../stores/useAppStore'
import { canonicalFingerprint } from './dm'
import { sha256Hex } from './hashes'
import { unwrapPrivateKey, wrapPrivateKey } from './keyVault'

/**
 * Local identity — spec.md §9.1 + §8.2: ECDH P-256 keypair generated on the
 * first run (or when regenerating), raw 65-byte public key hashed into an
 * 8×4-hex fingerprint (issue #23: 128 displayed bits, TOFU verification in
 * DMs). The keypair is persisted under `gritos:identity` as
 * `{nickname, fingerprint, createdAt, pubJwk, priv}` so the same keypair
 * survives reloads; `priv` is a keyVault envelope (issue #24): the private
 * JWK is wrapped with a non-extractable AES key in IndexedDB, never stored
 * as plaintext (passthrough envelopes keep the app alive where IndexedDB is
 * unavailable). Identities persisted by M2 (profile only, no keypair) and
 * by pre-#24 builds (plaintext `privJwk`) are migrated in place preserving
 * the nickname — the latter immediately re-persisted in the wrapped format.
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
  /**
   * Issue #24 — keyVault envelope of the private key: a JSON string holding
   * either an AES-GCM-wrapped JWK (`{v:1,iv,ct}`) or the passthrough
   * fallback (`{v:0,plain}`) where IndexedDB is unavailable. Never the raw
   * JWK object under this field.
   */
  priv?: string
  /**
   * Legacy plaintext private JWK, present only while reading records
   * written by pre-#24 builds. Read-only migration input: `persistIdentity`
   * converts it to a `priv` envelope and never writes `privJwk` back.
   */
  legacyPrivJwk?: JsonWebKey
}

/**
 * What callers hand to `persistIdentity`: the private key either in the
 * clear (`privJwk` — it is wrapped before anything touches localStorage) or
 * as an already-wrapped envelope (`priv` — stored verbatim, e.g. nickname
 * changes re-persist it untouched).
 */
export interface PersistedIdentityInput {
  nickname: string
  fingerprint: string
  createdAt: number
  pubJwk?: JsonWebKey
  privJwk?: JsonWebKey
  priv?: string
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

/**
 * True when the persisted record carries a full keypair in either storage
 * format (§8.2): the wrapped envelope (`priv`, current) or the legacy
 * plaintext `privJwk` surfaced as `legacyPrivJwk` (pre-#24).
 */
export function hasIdentityJwks(persisted: Partial<PersistedIdentity> | null): boolean {
  return (
    persisted !== null &&
    typeof persisted === 'object' &&
    persisted.pubJwk !== undefined &&
    (persisted.priv !== undefined || persisted.legacyPrivJwk !== undefined)
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
 * Normalizes any fingerprint spelling (spaced 8×4 display form, canonical
 * 32-hex, mixed case, stale TOFU pins) into THE display form every surface
 * renders: 8 uppercased space-separated groups of 4 hex chars (issue #122).
 * Inputs longer than 32 hex chars are cut like `formatFingerprint`; the
 * canonicalization first is what lets either stored form round-trip.
 */
export function displayFingerprint(fingerprint: string): string {
  return formatFingerprint(canonicalFingerprint(fingerprint))
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

/**
 * Serializes the writable record: the plaintext private JWK is wrapped into
 * a keyVault envelope (passthrough where IndexedDB is missing) and a legacy
 * plaintext carrier is never written back. The legacy carrier is accepted
 * so a nickname change on a pre-#24 record wraps it in the same stroke.
 */
async function serializeIdentity(input: PersistedIdentityInput): Promise<PersistedIdentity> {
  let priv = input.priv
  if (priv === undefined && input.privJwk !== undefined) {
    // wrapPrivateKey never rejects (it degrades to a v0 passthrough).
    priv = await wrapPrivateKey(JSON.stringify(input.privJwk))
  }
  return {
    nickname: input.nickname,
    fingerprint: input.fingerprint,
    createdAt: input.createdAt,
    pubJwk: input.pubJwk,
    priv,
  }
}

/**
 * Writes the persisted identity under `gritos:identity` (§8.2, RF-01). The
 * write is async since #24: when a plaintext private JWK is given it is
 * wrapped with the IndexedDB key vault first, so the record lands in
 * localStorage a microtask (or more, with a live vault) after the call —
 * even when an envelope is merely passed through. No caller reads the
 * record back in the same tick; fire-and-forget (`void`) is safe because
 * the function itself never rejects.
 */
export async function persistIdentity(identity: PersistedIdentityInput): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const record = await serializeIdentity(identity)
  try {
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Quota/privacy-mode failure: identity stays session-only.
  }
}

/**
 * The raw parsed JSON of a stored record: the current shape plus the
 * plaintext `privJwk` field that pre-#24 builds wrote (read-only migration
 * input — it is never serialized back, see `serializeIdentity`).
 */
type StoredIdentity = Partial<PersistedIdentity> & { privJwk?: JsonWebKey }

/**
 * Reads the persisted record, or null on first visit / corrupted payload
 * (RF-01: no onboarding when a valid identity exists). Sync by design —
 * the profile fields feed the first render; the private envelope is only
 * unwrapped later, inside the async `restoreSessionIdentity`.
 */
export function loadIdentity(): PersistedIdentity | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(IDENTITY_STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as StoredIdentity | null
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
      priv: typeof parsed.priv === 'string' ? parsed.priv : undefined,
      // Pre-#24 records carry the plaintext `privJwk` — surfaced under a
      // distinct field so no code path can mistake it for the envelope.
      legacyPrivJwk: parsed.privJwk,
    }
  } catch {
    return null
  }
}

/**
 * Resolves the private JWK from either carrier: the legacy plaintext field
 * or the keyVault envelope. Null when there is no key material or the
 * envelope cannot be opened (vault gone, tampered record) — the caller
 * falls back to the regular re-keying migration instead of failing.
 */
async function resolvePrivateJwk(persisted: PersistedIdentity): Promise<JsonWebKey | null> {
  if (persisted.legacyPrivJwk !== undefined) return persisted.legacyPrivJwk
  if (persisted.priv === undefined) return null
  try {
    return JSON.parse(await unwrapPrivateKey(persisted.priv)) as JsonWebKey
  } catch {
    return null
  }
}

/**
 * Restores a session identity from the persisted record (§8.2 → §9.1).
 * With key material present the exact keypair is re-imported (the private
 * JWK is unwrapped from the key vault first, issue #24), so reloads keep
 * the same fingerprint and ECDH material. Pre-M3 records (profile only)
 * and pre-#24 records (plaintext private JWK) are migrated: the former get
 * a fresh keypair, the latter keep their keys but are immediately
 * re-persisted in the wrapped format — nickname/createdAt always preserved.
 * The returned `migrated` flag reports which path ran.
 */
export async function restoreSessionIdentity(
  persisted: PersistedIdentity,
): Promise<{ session: SessionIdentity; migrated: boolean }> {
  const privJwk = await resolvePrivateJwk(persisted)
  if (persisted.pubJwk !== undefined && privJwk !== null) {
    const keypair = await importIdentityKeypair(persisted.pubJwk, privJwk)
    const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
    // Trust the key material: the fingerprint is recomputed from the raw
    // public key so it can never drift from what peers will verify.
    const fingerprint = await computeFingerprint(rawPublicKey)
    const session: SessionIdentity = {
      identity: {
        nickname: persisted.nickname,
        fingerprint,
        createdAt: persisted.createdAt,
      },
      keypair,
      rawPublicKey,
    }
    if (persisted.priv === undefined) {
      // Pre-#24 record (plaintext `privJwk` in storage): raise the bar
      // immediately by re-persisting the same keys in the wrapped format.
      await persistIdentity({
        nickname: persisted.nickname,
        fingerprint,
        createdAt: persisted.createdAt,
        pubJwk: persisted.pubJwk,
        privJwk,
      })
    }
    return { session, migrated: persisted.priv === undefined }
  }

  // Migration from the M2 profile-only shape (or an unreadable envelope):
  // keep nickname/createdAt, bind a fresh keypair, and re-persist the
  // wrapped §8.2 record.
  const session = await createSessionIdentity(persisted.nickname)
  const { pubJwk, privJwk: freshPrivJwk } = await exportIdentityJwks(session.keypair)
  await persistIdentity({
    nickname: persisted.nickname,
    fingerprint: session.identity.fingerprint,
    createdAt: persisted.createdAt,
    pubJwk,
    privJwk: freshPrivJwk,
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
  await persistIdentity({
    nickname: session.identity.nickname,
    fingerprint: session.identity.fingerprint,
    createdAt: session.identity.createdAt,
    pubJwk,
    privJwk,
  })
  return session
}
