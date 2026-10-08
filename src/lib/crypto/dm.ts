import { MAX_PLAINTEXT_LENGTH } from '../p2p/protocol'

/**
 * 1:1 direct-message E2EE — spec.md §9.2:
 *
 * 1. Both peers announce their raw ECDH P-256 public key via `keys` (§7.1).
 * 2. `secreto = ECDH(myPriv, theirPub)` → 256 bits.
 * 3. `claveDM = HKDF-SHA256(secreto, salt = SHA-256(fpA ‖ fpB ordered),
 *    info = "gritos/dm/v1", 32 B)` → AES-GCM-256 key.
 * 4. Per message: random 12-byte IV; the transmitted blob is
 *    `base64(IV ‖ AES-GCM(texto))` (Envelope §7.2: `iv` + `body`).
 * 5. Derived keys live in memory per session and per peer — never persisted.
 *
 * v2 (spec.md §12.1, issue #93 — phase 2 of the migration, wire switch in
 * later phases): DM keys derive from SESSION-EPHEMERAL ECDH keypairs instead
 * of the long-lived identity keys. The HKDF salt binds BOTH fingerprint
 * pairs (identity + session-ephemeral) and the `info` separator moves to
 * 'gritos/dm/v2'; the ephemeral keypair lives only for the app session, so
 * the exposure window per session shrinks from the identity's full lifetime
 * to the session itself (recorded DM history dies with the tab).
 *
 * Everything runs on Web Crypto (`crypto.subtle`); no hand-rolled primitives.
 */

/** §9.2 step 3 — HKDF `info` domain separator. */
export const DM_KEY_INFO = 'gritos/dm/v1'

/** §12.1 (issue #93) — HKDF `info` domain separator of the v2 derivation. */
export const DM_KEY_INFO_V2 = 'gritos/dm/v2'

/** AES-GCM nonce length in bytes (§9.2 step 4). */
export const DM_IV_BYTES = 12

/**
 * The sealed DM payload. `payload` is the full transmitted blob
 * `base64(IV ‖ ciphertext)` (§9.2 step 4); `iv` carries the same IV on its
 * own for the Envelope's §7.2 `iv` field.
 */
export interface SealedPayload {
  /** base64 of the 12-byte IV (Envelope §7.2 `iv`). */
  iv: string
  /** base64(IV ‖ ciphertext) — the transmitted blob (§9.2 step 4). */
  payload: string
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// base64 helpers (binary-safe; no dependencies)
// ---------------------------------------------------------------------------

/** Encodes bytes as standard base64 (chunked so large buffers never overflow). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Decodes standard base64 into bytes; throws on malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Fingerprint ordering (both ends must derive the same HKDF salt, §9.2)
// ---------------------------------------------------------------------------

/**
 * Canonical fingerprint form for key derivation: whitespace stripped and
 * uppercased, so both ends hash the exact same byte sequence regardless of
 * how each side stores the display string. Since issue #23 the display (and
 * therefore the derivation) strings carry 128 bits (32 hex chars); each end
 * computes them locally from the announced raw public keys, so peers running
 * the same build always derive the same salt.
 */
export function canonicalFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').toUpperCase()
}

/** Orders two canonical fingerprints (§9.2: "fpA ‖ fpB ordenados"). */
export function orderedFingerprints(fpA: string, fpB: string): [string, string] {
  const a = canonicalFingerprint(fpA)
  const b = canonicalFingerprint(fpB)
  return a <= b ? [a, b] : [b, a]
}

/**
 * HKDF salt (§9.2 step 3): SHA-256 over the UTF-8 concatenation of the two
 * fingerprints in sorted order (128-bit display strings per issue #23,
 * canonicalized). Both peers compute the identical salt from their raw-key
 * fingerprints. Deliberate migration: the salt of a peer pair changes with
 * this widening, so DMs between builds of different formats do not interop
 * — channels and keys are session memory only, nothing persisted to move.
 */
export async function deriveDmSalt(fpA: string, fpB: string): Promise<Uint8Array> {
  const [first, second] = orderedFingerprints(fpA, fpB)
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(first + second))
  return new Uint8Array(digest)
}

/**
 * HKDF salt for the v2 derivation (spec §12.1, issue #93): SHA-256 over the
 * UTF-8 concatenation of all four fingerprints — the long-lived identity
 * pair AND the session-ephemeral pair — canonicalized and sorted ascending.
 *
 * Binding design: because the salt covers BOTH pairs, an ephemeral key
 * substituted by an attacker (a swapped `ephkeys` announcement) can no
 * longer steer the derivation silently — with the substituted fingerprint
 * mixed in, both ends compute a DIFFERENT salt, hence a different AES-GCM
 * key, and the attacker-substituted traffic simply fails GCM authentication
 * visibly on decrypt instead of ever decrypting under a key the attacker
 * knows. The identity pair keeps the TOFU anchor (`gritos:tofu`, §12.1)
 * inside the derivation.
 *
 * Role independence: all four canonical fingerprints are fixed-width —
 * 39 chars in display form (8 groups of 4 hex chars + 7 separators), 32 hex
 * chars canonicalized — so a plain ascending sort of the four strings is
 * unambiguous: both ends sort to the identical sequence regardless of who
 * is "own" and who is "peer", and hash the identical salt.
 */
export async function deriveDmSaltV2(
  ownIdFp: string,
  peerIdFp: string,
  ownEphFp: string,
  peerEphFp: string,
): Promise<Uint8Array> {
  const [first, second, third, fourth] = [ownIdFp, peerIdFp, ownEphFp, peerEphFp]
    .map(canonicalFingerprint)
    .sort()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(first + second + third + fourth),
  )
  return new Uint8Array(digest)
}

// ---------------------------------------------------------------------------
// Key derivation (§9.2 steps 2–3)
// ---------------------------------------------------------------------------

/**
 * Derives the shared DM key exactly per §9.2: ECDH(myPriv, theirRawPub) →
 * HKDF-SHA256 (salt = SHA-256(ordered fingerprints), info = 'gritos/dm/v1',
 * 32 B) → non-extractable AES-GCM-256 key. Mirrored inputs on both ends
 * yield the same key.
 */
export async function deriveDmKey(
  ownPrivateKey: CryptoKey,
  peerRawPublicKey: Uint8Array,
  ownFingerprint: string,
  peerFingerprint: string,
): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    'raw',
    peerRawPublicKey as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    ownPrivateKey,
    256,
  )
  const salt = await deriveDmSalt(ownFingerprint, peerFingerprint)
  const baseKey = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: textEncoder.encode(DM_KEY_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * Derives the v2 shared DM key (spec §12.1, issue #93): ECDH P-256 over the
 * SESSION-EPHEMERAL keypair of this side and the peer's announced ephemeral
 * raw public key → HKDF-SHA256 (salt = `deriveDmSaltV2` over both fingerprint
 * pairs, info = 'gritos/dm/v2', 32 B) → non-extractable AES-GCM-256 key.
 * Same import/derive shape as v1's `deriveDmKey`; mirrored inputs on both
 * ends yield the same key.
 */
export async function deriveDmKeyV2(
  ownEphemeralPrivateKey: CryptoKey,
  peerEphemeralRawPublicKey: Uint8Array,
  ownIdFp: string,
  peerIdFp: string,
  ownEphFp: string,
  peerEphFp: string,
): Promise<CryptoKey> {
  const peerPublicKey = await crypto.subtle.importKey(
    'raw',
    peerEphemeralRawPublicKey as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  )
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    ownEphemeralPrivateKey,
    256,
  )
  const salt = await deriveDmSaltV2(ownIdFp, peerIdFp, ownEphFp, peerEphFp)
  const baseKey = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: textEncoder.encode(DM_KEY_INFO_V2),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ---------------------------------------------------------------------------
// Per-session key cache (§9.2 step 5 — memory only, never persisted)
// ---------------------------------------------------------------------------

/** peer-pair (ordered fingerprints) → derived key, for the whole session. */
const keyCache = new Map<string, Promise<CryptoKey>>()

/**
 * Cached variant of `deriveDmKey` keyed by the ordered fingerprint pair:
 * one derived key per peer per session (§9.2 step 5). Failures evict
 * themselves so a transient error is retried on the next call.
 */
export function getCachedDmKey(
  ownPrivateKey: CryptoKey,
  peerRawPublicKey: Uint8Array,
  ownFingerprint: string,
  peerFingerprint: string,
): Promise<CryptoKey> {
  const [first, second] = orderedFingerprints(ownFingerprint, peerFingerprint)
  const cacheKey = `${first}|${second}`
  let derived = keyCache.get(cacheKey)
  if (derived === undefined) {
    derived = deriveDmKey(ownPrivateKey, peerRawPublicKey, ownFingerprint, peerFingerprint)
    derived.catch(() => {
      keyCache.delete(cacheKey)
    })
    keyCache.set(cacheKey, derived)
  }
  return derived
}

/** v2 (§12.1): identity pair ‖ ephemeral pair (each ordered) → derived key. */
const keyCacheV2 = new Map<string, Promise<CryptoKey>>()

/**
 * Cached variant of `deriveDmKeyV2` (spec §12.1, issue #93), keyed by the
 * ordered identity fingerprint pair AND the ordered ephemeral pair — one
 * derived key per peer per session: a fresh session regenerates the
 * ephemeral pair, so the cache entry dies with it. Failures evict
 * themselves so a transient error is retried on the next call.
 */
export function getCachedDmKeyV2(
  ownEphemeralPrivateKey: CryptoKey,
  peerEphemeralRawPublicKey: Uint8Array,
  ownIdFp: string,
  peerIdFp: string,
  ownEphFp: string,
  peerEphFp: string,
): Promise<CryptoKey> {
  const [idFirst, idSecond] = orderedFingerprints(ownIdFp, peerIdFp)
  const [ephFirst, ephSecond] = orderedFingerprints(ownEphFp, peerEphFp)
  const cacheKey = `${idFirst}|${idSecond}|${ephFirst}|${ephSecond}`
  let derived = keyCacheV2.get(cacheKey)
  if (derived === undefined) {
    derived = deriveDmKeyV2(
      ownEphemeralPrivateKey,
      peerEphemeralRawPublicKey,
      ownIdFp,
      peerIdFp,
      ownEphFp,
      peerEphFp,
    )
    derived.catch(() => {
      keyCacheV2.delete(cacheKey)
    })
    keyCacheV2.set(cacheKey, derived)
  }
  return derived
}

/** Drops every cached DM key (v1 and v2) — identity regeneration, tests. */
export function clearDmKeyCache(): void {
  keyCache.clear()
  keyCacheV2.clear()
}

// ---------------------------------------------------------------------------
// AES-GCM sealing (§9.2 step 4)
// ---------------------------------------------------------------------------

/**
 * Encrypts `plaintext` with the shared DM key: random 12-byte IV, AES-GCM,
 * payload = base64(IV ‖ ciphertext). Plaintext above the protocol limit
 * (4000 chars, §7.3) is rejected before any crypto work.
 */
export async function encryptDm(key: CryptoKey, plaintext: string): Promise<SealedPayload> {
  if (plaintext.length > MAX_PLAINTEXT_LENGTH) {
    throw new RangeError(`The message exceeds the limit of ${MAX_PLAINTEXT_LENGTH} characters`)
  }
  const iv = crypto.getRandomValues(new Uint8Array(DM_IV_BYTES))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(plaintext)),
  )
  const combined = new Uint8Array(DM_IV_BYTES + ciphertext.length)
  combined.set(iv)
  combined.set(ciphertext, DM_IV_BYTES)
  return { iv: bytesToBase64(iv), payload: bytesToBase64(combined) }
}

/**
 * Decrypts a sealed DM payload: splits the 12-byte IV from the payload blob
 * and verifies the GCM tag. Tampered or wrong-key ciphertexts reject with
 * OperationError; malformed (too short / bad base64) payloads throw before
 * any decryption.
 */
export async function decryptDm(key: CryptoKey, payload: SealedPayload): Promise<string> {
  const combined = base64ToBytes(payload.payload)
  if (combined.length <= DM_IV_BYTES) {
    throw new RangeError('Payload DM demasiado corto')
  }
  if (payload.iv !== '' && payload.iv !== bytesToBase64(combined.slice(0, DM_IV_BYTES))) {
    throw new RangeError('Envelope IV inconsistent with the payload')
  }
  const iv = combined.slice(0, DM_IV_BYTES)
  const ciphertext = combined.slice(DM_IV_BYTES)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext as BufferSource,
  )
  return textDecoder.decode(plaintext)
}
