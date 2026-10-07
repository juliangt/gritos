import { computeFingerprint, exportRawPublicKey, generateSessionKeypair } from './identity'
import type { IdentityKeypair } from './identity'

/**
 * Session-ephemeral ECDH keypair for DM forward secrecy — spec.md §12.1,
 * issue #93 (phase 1: this module only; roomManager/panic wiring lands in
 * later phases).
 *
 * A fresh ECDH P-256 keypair is generated once per app session and DM key
 * derivation (§9.2) moves from static-static ECDH between long-lived
 * identity keys to this session-scoped material. The keypair lives ONLY in
 * memory and is NEVER persisted — not to `localStorage` (where the identity
 * record sits, §8.2) and not to IndexedDB (the key vault, issue #24) — so
 * it dies with the tab: the "harvest now, decrypt later" window shrinks
 * from the identity's full lifetime to a single session, and recorded DM
 * history becomes undecryptable once the session ends.
 *
 * TOFU discipline (§12.1, issue #22): the long-lived identity fingerprint
 * stays the pinned anchor (`gritos:tofu`) and the one peers verify manually
 * (RF-04). The ephemeral fingerprint must NEVER be pinned — it changes on
 * every session and pinning it would break the pin on each reload.
 *
 * Everything runs on Web Crypto (`crypto.subtle`); no hand-rolled primitives.
 */

/**
 * One session's ephemeral bundle: the keypair for ECDH plus the announced
 * form (`ephkeys`, issue #93) — the raw 65-byte public key and its
 * fingerprint, always recomputed from the key material so they can never
 * drift from what peers receive.
 */
export interface EphemeralSession {
  keypair: IdentityKeypair
  rawPublicKey: Uint8Array
  fingerprint: string
}

/**
 * The current session's ephemeral bundle, or null before the first
 * `ensureEphemeralSession` (or after an explicit clear). Module state per
 * the dm.ts idiom: session memory only, explicit clear, never persisted.
 */
let ephemeralSession: EphemeralSession | null = null

/** The current ephemeral session, or null when none has been generated yet. */
export function getEphemeralSession(): EphemeralSession | null {
  return ephemeralSession
}

/**
 * Installs or clears (null) the session bundle. Later phases call this with
 * null on identity regeneration (RF-07) and panic wipe (RF-08) so a stale
 * ephemeral key never outlives the identity that announced it.
 */
export function setEphemeralSession(session: EphemeralSession | null): void {
  ephemeralSession = session
}

/**
 * Pure async factory: a fresh ECDH P-256 keypair with the same algorithm,
 * extractability and usages (`deriveKey`/`deriveBits`) as the identity
 * keypair (§9.1), its raw 65-byte public key, and the matching fingerprint.
 */
export async function generateEphemeralSession(): Promise<EphemeralSession> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  const fingerprint = await computeFingerprint(rawPublicKey)
  return { keypair, rawPublicKey, fingerprint }
}

/**
 * Returns the current session bundle, generating and storing a fresh one on
 * first use (or after a clear). Repeated calls within a session return the
 * very same object — the keypair is generated at most once per session.
 */
export async function ensureEphemeralSession(): Promise<EphemeralSession> {
  if (ephemeralSession === null) {
    ephemeralSession = await generateEphemeralSession()
  }
  return ephemeralSession
}
