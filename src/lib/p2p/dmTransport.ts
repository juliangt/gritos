import { getCachedDmKeyV2 } from '../crypto/dm'
import { ensureEphemeralSession } from '../crypto/sessionEphemeral'
import type { Envelope } from './protocol'

/**
 * Issue #105 (spec §12.5) — the DmTransport abstraction: the minimal
 * interface a DM channel's backing swarm must expose so the store and (in
 * phase 3) the UI stay unaware of the difference between a ROOM-swarm-backed
 * channel (keyed by Trystero peerId, today) and a SIGNAL-swarm-backed one
 * (keyed by the canonical identity fingerprint, new).
 *
 * Deliberately minimal, per §12.5's contract:
 *
 * - `sendDmEnvelope` carries the sealed `dm` Envelope (v:2, §9.2, directed) —
 *   sealing is NOT transport work: both backings resolve the SAME cached v2
 *   derivation (`deriveDmSessionKey` below), so the crypto layer is shared
 *   and only the wire differs.
 * - `sendTyping` / `sendReceipts` are §7.1 exactly as the room path sends
 *   them (directed, `dm: true` typing flag, ≤ MAX_RECEIPT_BATCH id batches).
 * - `available()` is the RF-04 «par desconectado» state from the transport's
 *   point of view: room = the peer shares a live room + the channel is open;
 *   signal = the swarm is joined and the peer is present.
 * - `peerIdentityFingerprint` / `peerEphemeralKey` are the key-resolution
 *   halves of the v2 derivation: the keys-derived identity fingerprint (the
 *   TOFU anchor, never the spoofable self-declaration) and the announced
 *   session-ephemeral key with its fingerprint.
 *
 * This module imports NOTHING from roomManager (the room transport's home):
 * roomManager, signalChannel and the tests all depend on the interface
 * here — a one-way dependency that keeps the swarm managers decoupled.
 */

/** Which backing swarm a transport rides — parity tests table on this. */
export type DmTransportKind = 'room' | 'signal'

/**
 * A peer's announced session-ephemeral key (the `ephkeys` announce, spec
 * §12.1) with its derived fingerprint. Crypto-trust only: never pinned,
 * never displayed — the long-lived identity key stays the TOFU anchor.
 */
export interface PeerEphemeralKey {
  readonly rawKey: Uint8Array
  readonly fingerprint: string
}

export interface DmTransport {
  readonly kind: DmTransportKind
  /**
   * The store channel key this transport feeds: the Trystero peerId for the
   * room backing (`dms[peerId]`), the canonical identity fingerprint for the
   * signal backing (`dms[fp]`).
   */
  readonly channelKey: string
  /** The transport-level address of the peer (envelope `to`, send target). */
  readonly peerId: string
  /** RF-04 availability recomputed on every call — never cached. */
  available(): boolean
  /** The keys-derived identity fingerprint (TOFU anchor), null when unknown. */
  peerIdentityFingerprint(): string | null
  /** The announced session-ephemeral key, null when unknown (legacy v1 peer). */
  peerEphemeralKey(): PeerEphemeralKey | null
  /** Sends the SEALED v2 `dm` Envelope, directed at the peer. */
  sendDmEnvelope(envelope: Envelope): void
  /** §7.1 DM typing signal, directed, flagged `dm: true`. */
  sendTyping(on: boolean): void
  /** §7.1 delivery receipt batch, directed at the author. */
  sendReceipts(ids: string[]): void
}

/**
 * The shared half of the DM send path (spec §9.2, issue #93): resolves the
 * cached v2 key over the session-ephemeral pairs with BOTH fingerprint pairs
 * (identity and ephemeral) bound into the HKDF salt. The session-ephemeral
 * keypair is generated lazily on first use — AFTER the guards, so a refused
 * derivation never triggers a pointless keygen. Returns null when the peer's
 * identity fingerprint or ephemeral key has not landed (a v1 legacy build
 * can never open a v2 dm) or on crypto failure — never throws.
 */
export async function deriveDmSessionKey(
  ownIdentityFingerprint: string,
  transport: DmTransport,
): Promise<CryptoKey | null> {
  const theirIdFp = transport.peerIdentityFingerprint()
  const eph = transport.peerEphemeralKey()
  if (theirIdFp === null || eph === null) return null
  try {
    const session = await ensureEphemeralSession()
    return await getCachedDmKeyV2(
      session.keypair.privateKey,
      eph.rawKey,
      ownIdentityFingerprint,
      theirIdFp,
      session.fingerprint,
      eph.fingerprint,
    )
  } catch {
    return null
  }
}
