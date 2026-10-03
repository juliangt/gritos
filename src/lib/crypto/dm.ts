/**
 * 1:1 direct-message E2EE — spec.md §9.2: ECDH P-256 shared secret →
 * HKDF-SHA256 (salt = SHA-256 of both fingerprints, ordered) → AES-GCM-256
 * with a random 12-byte IV per message. Keys live in memory per session,
 * never persisted. Implementation lands in M3.
 */

export interface SealedPayload {
  /** base64 of the 12-byte IV. */
  iv: string
  /** base64 of the AES-GCM ciphertext. */
  body: string
}

/**
 * Derives the shared DM key. Both peers must order the fingerprints the
 * same way to reach the same HKDF salt (§9.2 step 3).
 */
export async function deriveDmKey(
  _ownPrivateKey: CryptoKey,
  _peerPublicKey: CryptoKey,
  _ownFingerprint: string,
  _peerFingerprint: string,
): Promise<CryptoKey> {
  throw new Error('not implemented: DM E2EE lands in M3 (spec §9.2)')
}

export async function encryptDm(
  _key: CryptoKey,
  _plaintext: string,
): Promise<SealedPayload> {
  throw new Error('not implemented: DM E2EE lands in M3 (spec §9.2)')
}

/** Rejects tampered ciphertext via the GCM tag (M3 test: tamper fails). */
export async function decryptDm(
  _key: CryptoKey,
  _payload: SealedPayload,
): Promise<string> {
  throw new Error('not implemented: DM E2EE lands in M3 (spec §9.2)')
}
