import { canonicalFingerprint, decryptDm, encryptDm, getCachedDmKeyV2 } from '../crypto/dm'
import { computeFingerprint } from '../crypto/identity'
import { ensureEphemeralSession } from '../crypto/sessionEphemeral'
import type { DmTransport } from './dmTransport'
import { deriveDmSessionKey } from './dmTransport'
import {
  MAX_PLAINTEXT_LENGTH,
  MAX_RECEIPT_BATCH,
  DM_PROTOCOL_VERSION,
  BoundedSeenIds,
  createEnvelope,
  filterDmForSelf,
  isOversized,
  parseEnvelope,
  shouldProcess,
  validateReceipt,
  type Envelope,
  type ReceiptPayload,
  type TypingPayload,
} from './protocol'
import {
  RAW_PUBLIC_KEY_LENGTH,
  RECEIPT_DEBOUNCE_MS,
  TYPING_TTL_MS,
  consumeRollingBudget,
  ensureSessionIdentity,
  getSelfPeerId,
  getSessionIdentity,
  joinAuxiliarySwarm,
  onIdentityMaterialRebroadcast,
  type AuxiliarySwarmRoom,
} from './roomManager'
import {
  KNOCK_RATE_CAP,
  MAX_SIGNAL_PRESENCE,
  NOTE_MAX_LENGTH,
  deriveSignalRoomId,
  parseKnock,
  parseKnockAck,
  parseWhoami,
  type KnockAckPayload,
  type KnockPayload,
  type WhoamiPayload,
} from './signalChannelConstants'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { getTofuFingerprint, pinMatchesFingerprint, pinTofuFingerprint } from '../tofu'

/**
 * Issue #105 (spec §12.5) — the global DM signaling channel manager ("canal
 * global"): an isolated, well-known Trystero swarm where opt-in peers can be
 * knocked BY IDENTITY FINGERPRINT; an accepted knock opens an E2EE DM backed
 * by that same swarm. The channel is dumb by contract — it carries whoami
 * (nick + fingerprint presence), knocks, acks and the keys/ephkeys announces
 * (so the DM v2 derivation works over signal-backed channels exactly as §9.2
 * defines it) — never conversation content: DMs only flow AFTER consent,
 * inside the signal-backed DmChannel both sides open on accept.
 *
 * Lifecycle: join/leave is strictly bound to `Settings.globalDm` (default
 * OFF) through a module-level subscription to the settings store — the
 * react/history module-load wiring precedent — so the phase-3 toggle works
 * with zero further wiring and a panic wipe (settings reset) tears the swarm
 * down deterministically. Leaving destroys ALL in-memory swarm state
 * (presence LRU, knock budgets, pending acks) and lands every signal-backed
 * channel in the RF-04 «El par se ha desconectado» state — history stays in
 * memory, nothing persists (spec §8.2: no new `gritos:*` key; the only
 * persisted trace is the TOFU pins of peers a channel was OPENED for —
 * presence alone never writes `gritos:tofu`, so the swarm cannot become a
 * local stranger directory).
 *
 * Keying (§12.5): signal channels live in the SAME `dms` store slice as room
 * DMs, keyed by the CANONICAL IDENTITY FINGERPRINT (the fp is the product's
 * address; the swarm peerId is ephemeral per session), marked `global: true`
 * — the «(global)» sibling of the manual «(sin sala)» marker. Room channels
 * are keyed by Trystero peerId, a disjoint namespace (46-char ids vs 32-hex
 * fingerprints), so the two DM kinds coexist in `DmList` without colliding.
 *
 * Address resolution (§12.5: the declared fp is advisory, the keys-derived
 * fp is the crypto-trusted anchor): presence and knocks are ADDRESSED by the
 * self-declared fingerprint (whoami/knock), while DM crypto and TOFU always
 * resolve through the keys-derived fingerprint — a spoofed declaration can
 * only misroute its OWN traffic, never forge a channel's identity. The store
 * channel key is the declared fp the knock/accept flow used; the keys-
 * derived fp pins TOFU under it and flags `keyChanged` on divergence, the
 * exact room semantics under a fingerprint-shaped key.
 *
 * All Trystero access goes through roomManager's seams (`joinAuxiliarySwarm`,
 * `AuxiliarySwarmRoom`, identity/ephemeral material): this module never
 * imports trystero (plan §3 — roomManager is the app's single Trystero
 * surface).
 */

/** Rolling window over which KNOCK_RATE_CAP applies (spec §12.5: per minute). */
export const KNOCK_RATE_WINDOW_MS = 60_000

/** Typed refusal of `knockPeer` (the issue's typed-error discipline). */
export class KnockError extends Error {
  /** `signal-off`: the swarm is not joined; `peer-not-present`: the fingerprint is not in the presence LRU. */
  readonly reason: 'signal-off' | 'peer-not-present' | 'invalid-knock'

  constructor(reason: KnockError['reason']) {
    super(
      reason === 'signal-off'
        ? 'The global channel is disabled'
        : reason === 'peer-not-present'
          ? 'That fingerprint is not present on the global channel'
          : 'The knock is not valid',
    )
    this.name = 'KnockError'
    this.reason = reason
  }
}

/** An inbound knock awaiting the phase-3 consent card (per-session state). */
export interface SignalKnock {
  readonly fp: string
  readonly nick: string
  readonly note?: string
}

/** The consent-card seam: validated, capped, mute-gated inbound knocks. */
export type SignalKnockListener = (knock: SignalKnock) => void

const knockListeners = new Set<SignalKnockListener>()

/**
 * Subscribes to inbound knocks (phase 3's consent card); returns the
 * unsubscribe function. DISPOSABLE listener state: cleared by
 * `resetSignalChannelForTests` (the onReact-seam discipline — the
 * settings/nickname subscriptions below are wiring and never cleared).
 */
export function onKnock(listener: SignalKnockListener): () => void {
  knockListeners.add(listener)
  return () => {
    knockListeners.delete(listener)
  }
}

/** How an OUTGOING knock ended (phase 3's waiting state resolves on this). */
export interface KnockResolution {
  /** The TARGET fingerprint the knock was addressed to (the channel key). */
  readonly fp: string
  readonly accepted: boolean
}

const knockResolutionListeners = new Set<(resolution: KnockResolution) => void>()

/**
 * Subscribes to outgoing-knock resolutions (the phase-3 dialog's
 * «esperando respuesta» → landed/rejected transition); returns the
 * unsubscribe function. Fired exactly once per acked knock, AFTER the
 * accept path has opened the channel (the listener can navigate straight
 * into the DM view). A knock dropped without an ack (the peer leaving)
 * never resolves — the dialog stays cancellable. DISPOSABLE listener
 * state: cleared by `resetSignalChannelForTests`.
 */
export function onKnockResolved(listener: (resolution: KnockResolution) => void): () => void {
  knockResolutionListeners.add(listener)
  return () => {
    knockResolutionListeners.delete(listener)
  }
}

/** Notifies every resolution listener (the handleKnockAck tail). */
function resolveKnock(fp: string, accepted: boolean): void {
  for (const listener of knockResolutionListeners) {
    listener({ fp, accepted })
  }
}

interface PresenceEntry {
  readonly nick: string
  readonly peerId: string
  readonly lastSeen: number
}

interface InboundKnock {
  readonly nick: string
  readonly note?: string
  readonly peerId: string
}

interface SignalSwarm {
  readonly roomId: string
  readonly room: AuxiliarySwarmRoom
  readonly actions: ReturnType<typeof makeSignalActions>
  /** Per-swarm dedup window for dm envelopes (spec §7.3). */
  readonly seenDmIds: BoundedSeenIds
  /** Transport peerId → announced identity raw key / its derived fp. */
  readonly peerKeys: Map<string, Uint8Array>
  readonly peerKeyFps: Map<string, string>
  /** Transport peerId → announced session-ephemeral key / its derived fp. Never pinned (§12.1). */
  readonly peerEphKeys: Map<string, Uint8Array>
  readonly peerEphFps: Map<string, string>
  /** Transport peerId → self-declared canonical fp (whoami/knock, advisory). */
  readonly declaredFps: Map<string, string>
  /** Canonical fp → presence entry; LRU capped at MAX_SIGNAL_PRESENCE. */
  readonly presence: Map<string, PresenceEntry>
  /** Received-knock timestamps per transport peerId (KNOCK_RATE_CAP budget). */
  readonly knockTimes: Map<string, number[]>
  /** Knocker canonical fp → inbound knock awaiting consent. */
  readonly inboundKnocks: Map<string, InboundKnock>
  /** Target canonical fp → transport peerId (knocks awaiting an ack). */
  readonly pendingKnocks: Map<string, string>
  /** Receipt ids per author transport peerId, flushed debounced (§7.1). */
  readonly pendingReceipts: Map<string, string[]>
  receiptTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
}

/**
 * Structural action handle — the shape of trystero's `makeAction` result the
 * manager actually touches (the real type lives behind roomManager's import).
 */
interface SwarmAction<T> {
  send: (data: T, options?: { target?: string }) => Promise<void>
  onMessage: ((data: T, context: { peerId: string }) => void | Promise<void>) | null
}

function makeSignalActions(room: AuxiliarySwarmRoom) {
  return {
    // §12.5 — the swarm's own actions (presence, the door, the answer).
    whoami: room.makeAction<WhoamiPayload>('whoami'),
    knock: room.makeAction<KnockPayload>('knock'),
    'knock-ack': room.makeAction<KnockAckPayload>('knock-ack'),
    // §7.1 key announces, same binary discipline as rooms (issue #93).
    keys: room.makeAction<Uint8Array | ArrayBuffer>('keys'),
    ephkeys: room.makeAction<Uint8Array | ArrayBuffer>('ephkeys'),
    // The DmTransport wire (§12.5): sealed v2 dm envelopes, typing and
    // receipts exactly as the room path sends them.
    dm: room.makeAction<Envelope>('dm'),
    typing: room.makeAction<TypingPayload>('typing'),
    receipt: room.makeAction<ReceiptPayload>('receipt'),
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The joined swarm, or null while the setting is off (or still joining). */
let swarmRef: SignalSwarm | null = null

/** Serializes concurrent enable flaps so joins never double-join. */
let joining = false

/**
 * Sends an action payload, swallowing rejections from channels that closed
 * mid-flight (the roomManager safeSend policy — best-effort sends never
 * surface transport errors to the UI).
 */
function safeSend<T>(action: SwarmAction<T>, data: T, options?: { target: string }): void {
  try {
    void Promise.resolve(action.send(data, options)).catch(() => {
      // Channel closed — nothing to report for best-effort sends.
    })
  } catch {
    // Fake transports in tests may throw synchronously; same policy.
  }
}

function globalDmEnabled(): boolean {
  return useSettingsStore.getState().settings.globalDm
}

/** The canonical identity fingerprint of THIS peer, when the identity exists. */
function ownFingerprint(): string | null {
  const identity = getSessionIdentity()
  return identity === null ? null : canonicalFingerprint(identity.identity.fingerprint)
}

/**
 * The store channel key of a transport peer: the self-declared fp when known
 * (the address knocks and acks used), falling back to the keys-derived fp.
 * null when neither has landed — nothing can be routed to an unknown peer.
 */
function channelKeyOf(swarm: SignalSwarm, peerId: string): string | null {
  return swarm.declaredFps.get(peerId) ?? swarm.peerKeyFps.get(peerId) ?? null
}

/** The transport peerId currently declaring/presenting `fp`, if connected. */
function peerIdForChannelKey(swarm: SignalSwarm, fp: string): string | null {
  for (const [peerId, declared] of swarm.declaredFps) {
    if (declared === fp) return peerId
  }
  return null
}

/** Local moderation gate (issue #95): a muted fp drops, canonical form. */
function isMutedFingerprint(fingerprint: string): boolean {
  return useSettingsStore
    .getState()
    .settings.mutedFingerprints.includes(canonicalFingerprint(fingerprint))
}

/** The keys-derived fp of a transport peer, when both key and fp landed. */
function keysDerivedFp(swarm: SignalSwarm, peerId: string): string | null {
  return swarm.peerKeyFps.get(peerId) ?? null
}

// ---------------------------------------------------------------------------
// Channel reconciliation (TOFU under the fp-keyed channel) — the room
// syncDmTofuState semantics over `ensureGlobalDmChannel`
// ---------------------------------------------------------------------------

/**
 * Creates (or refreshes) the signal-backed channel for `channelKey` under
 * the room TOFU discipline: the pinned first-seen fingerprint is displayed
 * once it exists, a live fingerprint that differs flags `keyChanged`
 * (advisory) instead of silently rotating the shown identity, and a
 * divergence pins the displayed value to the pin.
 */
function reconcileSignalChannel(channelKey: string, peerNick: string, liveFp: string | null): void {
  const pinned = getTofuFingerprint(channelKey)
  const pinStaleForLive =
    pinned !== null && liveFp !== null && !pinMatchesFingerprint(pinned, liveFp)
  const state = useAppStore.getState()
  state.ensureGlobalDmChannel(channelKey, peerNick, pinStaleForLive ? pinned : (liveFp ?? pinned))
  state.setDmKeyChanged(channelKey, pinStaleForLive)
}

/**
 * The keys-path variant: reconciles an EXISTING channel only — receiving
 * keys never opens channels (they are created on demand: accept/send/
 * receive, the RF-04 rule).
 */
function reconcileExistingSignalChannel(channelKey: string, liveFp: string): void {
  if (useAppStore.getState().dms[channelKey] === undefined) return
  reconcileSignalChannel(channelKey, '', liveFp)
}

// ---------------------------------------------------------------------------
// Receive paths
// ---------------------------------------------------------------------------

function handleWhoami(swarm: SignalSwarm, data: unknown, peerId: string): void {
  const payload = parseWhoami(data)
  if (payload === null) return
  swarm.declaredFps.set(peerId, payload.fp)
  // LRU refresh: re-inserting moves the entry to the newest end.
  swarm.presence.delete(payload.fp)
  swarm.presence.set(payload.fp, {
    nick: payload.nick,
    peerId,
    lastSeen: Date.now(),
  })
  // The 101st entry evaporates the least-recently-SEEN one (Map insertion
  // order): engine state, never a browsable directory (spec §12.5).
  while (swarm.presence.size > MAX_SIGNAL_PRESENCE) {
    const oldest = swarm.presence.keys().next().value
    if (oldest === undefined) break
    swarm.presence.delete(oldest)
  }
}

function handleKeys(swarm: SignalSwarm, data: unknown, peerId: string): void {
  // Trystero delivers binary payloads as ArrayBuffers (or TypedArrays);
  // only an exact uncompressed P-256 public key (65 bytes) is accepted.
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (bytes === null) return
  if (isOversized(bytes.byteLength) || bytes.byteLength !== RAW_PUBLIC_KEY_LENGTH) return
  swarm.peerKeys.set(peerId, bytes)
  void computeFingerprint(bytes).then((fingerprint) => {
    // The peer may have left (or the swarm torn down) while hashing.
    if (swarmRef !== swarm || !swarm.peerKeys.has(peerId)) return
    // CANONICAL form: the signal channel's key space (whoami/knock fps) is
    // canonical, so the keys-derived fp must live in the same one (the room
    // path keeps the spaced display form; the v2 derivation canonicalizes
    // either way — this only normalizes the signal swarm's own maps).
    swarm.peerKeyFps.set(peerId, canonicalFingerprint(fingerprint))
    const channelKey = swarm.declaredFps.get(peerId)
    if (channelKey === undefined) return
    // TOFU pin under the CHANNEL key — the identity fp only, and ONLY when a
    // channel for this peer already exists (it was opened by the accept flow
    // or a received dm): unlike the room path, keys/presence alone never
    // write `gritos:tofu`, so sweeping the signal swarm cannot leave a
    // persisted stranger directory behind (spec §12.5's no-directory
    // constraint — the room swarm pins every peer, the signal swarm pins
    // every CONTACT).
    if (useAppStore.getState().dms[channelKey] === undefined) return
    pinTofuFingerprint(channelKey, fingerprint)
    reconcileExistingSignalChannel(channelKey, fingerprint)
  })
}

function handleEphKeys(swarm: SignalSwarm, data: unknown, peerId: string): void {
  // Issue #93 (spec §12.1) discipline, verbatim: same binary gate as keys —
  // and deliberately NO pin and no display: the ephemeral fp never touches
  // `gritos:tofu` (the long-lived identity key stays the TOFU anchor).
  const bytes =
    data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (bytes === null) return
  if (isOversized(bytes.byteLength) || bytes.byteLength !== RAW_PUBLIC_KEY_LENGTH) return
  swarm.peerEphKeys.set(peerId, bytes)
  void computeFingerprint(bytes).then((fingerprint) => {
    if (swarmRef !== swarm || !swarm.peerEphKeys.has(peerId)) return
    // Canonical, matching peerKeyFps — crypto-trust only, never pinned.
    swarm.peerEphFps.set(peerId, canonicalFingerprint(fingerprint))
    // From this moment the peer is v2-capable: clear a legacy flag on its
    // channel (if any), exactly in the room path's async-tail style.
    const channelKey = channelKeyOf(swarm, peerId)
    if (channelKey !== null) useAppStore.getState().setDmLegacyPeer(channelKey, false)
  })
}

function handleKnock(swarm: SignalSwarm, data: unknown, peerId: string): void {
  // MUTE GATE FIRST (spec §12.5 via §12.4's door): a muted sender's knock
  // drops before any parse or budget — resolved through the keys-derived fp
  // (crypto-trusted), failing open while the announce has not landed, the
  // exact room-path posture.
  const transportFp = swarm.peerKeyFps.get(peerId)
  if (transportFp !== undefined && isMutedFingerprint(transportFp)) return
  const payload = parseKnock(data)
  if (payload === null) return
  // Second gate on the DECLARED fp: suppressing a knock by declaring a muted
  // fp can only silence the spoofer's own knock (the transport peerId is
  // DTLS-secured, so third-party knocks cannot be forged away).
  if (isMutedFingerprint(payload.from.fp)) return
  const own = ownFingerprint()
  if (own !== null && payload.from.fp === own) return
  // Rate cap (KNOCK_RATE_CAP 5/min/peer, rolling): the excess is discarded
  // silently — the same mitigation class as the room-path cosmetic caps.
  if (!consumeRollingBudget(swarm.knockTimes, peerId, KNOCK_RATE_CAP, KNOCK_RATE_WINDOW_MS)) return
  // The knock DECLARES the sender's fp like a whoami does (advisory): knock
  // routing and the accept flow can address the knocker even before their
  // whoami announce lands.
  swarm.declaredFps.set(peerId, payload.from.fp)
  swarm.inboundKnocks.set(payload.from.fp, {
    nick: payload.from.nick,
    ...(payload.note !== undefined ? { note: payload.note } : {}),
    peerId,
  })
  for (const listener of knockListeners) {
    listener({
      fp: payload.from.fp,
      nick: payload.from.nick,
      ...(payload.note !== undefined ? { note: payload.note } : {}),
    })
  }
}

function handleKnockAck(swarm: SignalSwarm, data: unknown, peerId: string): void {
  const payload = parseKnockAck(data)
  if (payload === null) return
  // The ack's fp echoes the KNOCKER's — ours. A foreign ack is not ours to
  // match (defense in depth; acks also arrive directed via target).
  const own = ownFingerprint()
  if (own === null || payload.fp !== own) return
  // Match ONE pending knock by transport peer; an ack matching none of the
  // pending knocks is discarded at the manager layer (spec §12.5).
  let targetFp: string | null = null
  for (const [fp, pendingPeerId] of swarm.pendingKnocks) {
    if (pendingPeerId === peerId) {
      targetFp = fp
      break
    }
  }
  if (targetFp === null) return
  swarm.pendingKnocks.delete(targetFp)
  if (!payload.accept) {
    // Rejected: no channel, the knock is forgotten — the UI learns through
    // the resolution seam (phase 3's inline «rechazado» state).
    resolveKnock(targetFp, false)
    return
  }
  const entry = swarm.presence.get(targetFp)
  openSignalChannel(swarm, targetFp, entry?.nick ?? 'par')
  // Fired AFTER the channel exists: the dialog can land in the DM view
  // directly from this callback.
  resolveKnock(targetFp, true)
}

function handleSignalTyping(swarm: SignalSwarm, payload: TypingPayload, peerId: string): void {
  if (typeof payload?.on !== 'boolean') return
  // Issue #95 — a muted peer's typing flags never land (same gate as rooms).
  const transportFp = swarm.peerKeyFps.get(peerId)
  if (transportFp !== undefined && isMutedFingerprint(transportFp)) return
  const channelKey = channelKeyOf(swarm, peerId)
  if (channelKey === null) return
  useAppStore.getState().setDmTyping(channelKey, payload.on ? Date.now() : null)
  if (payload.on) ensureSignalTypingSweeper()
}

function handleSignalReceipt(swarm: SignalSwarm, payload: ReceiptPayload, peerId: string): void {
  if (!validateReceipt(payload)) return
  const channelKey = channelKeyOf(swarm, peerId)
  if (channelKey === null) return
  useAppStore.getState().markDmMessagesDelivered(channelKey, payload.ids)
}

/**
 * DM receive path over the signal swarm — the room path's guard sequence
 * (mute pre-parse → parseEnvelope v2-only → directed-to-self → dedup →
 * ephemeral material present → v2 decrypt), resolved through THIS swarm's
 * key maps and appended to the fp-keyed channel. §7.3 silence everywhere on
 * refusal.
 */
function handleSignalDm(swarm: SignalSwarm, data: unknown, transportPeerId: string): void {
  const senderIdFp = swarm.peerKeyFps.get(transportPeerId)
  if (senderIdFp !== undefined && isMutedFingerprint(senderIdFp)) return
  const envelope = parseEnvelope(data)
  if (envelope === null || envelope.kind !== 'dm') return
  if (filterDmForSelf(envelope, getSelfPeerId()) === null) return
  if (!shouldProcess(envelope, swarm.seenDmIds)) return
  if (!envelope.enc || envelope.iv === null) return

  const identity = getSessionIdentity()
  const senderRawKey = swarm.peerKeys.get(transportPeerId)
  const senderEphRaw = swarm.peerEphKeys.get(transportPeerId)
  const senderEphFp = swarm.peerEphFps.get(transportPeerId)
  // The sender's identity key AND session-ephemeral announce must have
  // landed; otherwise the payload is undecryptable (§7.3 silent discard).
  if (identity === null || senderRawKey === undefined) return
  if (senderEphRaw === undefined || senderEphFp === undefined) return

  void (async () => {
    try {
      const theirIdFp = senderIdFp ?? (await computeFingerprint(senderRawKey))
      const ownSession = await ensureEphemeralSession()
      // The v2 derivation (spec §9.2, issue #93): ECDH over the session-
      // ephemeral pairs, BOTH fingerprint pairs (identity + ephemeral) in
      // the HKDF salt — the exact shared key the sender derived.
      const key = await getCachedDmKeyV2(
        ownSession.keypair.privateKey,
        senderEphRaw,
        identity.identity.fingerprint,
        theirIdFp,
        ownSession.fingerprint,
        senderEphFp,
      )
      const text = await decryptDm(key, { iv: envelope.iv ?? '', payload: envelope.body })
      if (text.length > MAX_PLAINTEXT_LENGTH) return
      const channelKey = channelKeyOf(swarm, transportPeerId)
      if (channelKey === null) return
      const channel = useAppStore.getState().dms[channelKey]
      // The receive path MAY open the channel (RF-04: created on open/send/
      // receive), marked «(global)», pinning the keys-derived identity fp on
      // creation (the first-write-wins TOFU anchor for this contact).
      if (channel === undefined) {
        pinTofuFingerprint(channelKey, theirIdFp)
        reconcileSignalChannel(channelKey, envelope.nick, theirIdFp)
        useAppStore.getState().setDmAvailable(channelKey, true)
      } else {
        reconcileExistingSignalChannel(channelKey, theirIdFp)
      }
      // Issue #96 — expiry on the RECEIVER clock, never the author ts.
      const expiresAt = envelope.ttl === undefined ? undefined : Date.now() + envelope.ttl * 1000
      useAppStore.getState().appendDmMessage(channelKey, {
        id: envelope.id,
        roomId: `dm:${channelKey}`,
        authorId: channelKey,
        authorNick: envelope.nick,
        text,
        ts: envelope.ts,
        encrypted: false,
        status: 'delivered',
        kind: 'user',
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      })
      // §6.4/§7.1 — the debounced directed receipt (✓✓), like rooms.
      queueSignalReceipt(swarm, transportPeerId, envelope.id)
    } catch {
      // Wrong key, tampered tag or malformed payload (§7.3): silent discard.
    }
  })()
}

/** Debounced directed receipt queue (§7.1, the room-path discipline). */
function queueSignalReceipt(swarm: SignalSwarm, authorPeerId: string, messageId: string): void {
  const ids = swarm.pendingReceipts.get(authorPeerId)
  if (ids === undefined) swarm.pendingReceipts.set(authorPeerId, [messageId])
  else ids.push(messageId)
  if (swarm.receiptTimer === null) {
    swarm.receiptTimer = setTimeout(() => {
      swarm.receiptTimer = null
      flushSignalReceipts(swarm)
    }, RECEIPT_DEBOUNCE_MS)
  }
}

function flushSignalReceipts(swarm: SignalSwarm): void {
  for (const [authorPeerId, ids] of [...swarm.pendingReceipts]) {
    swarm.pendingReceipts.delete(authorPeerId)
    while (ids.length > 0) {
      const batch = ids.splice(0, MAX_RECEIPT_BATCH)
      safeSend(swarm.actions.receipt, { ids: batch } satisfies ReceiptPayload, {
        target: authorPeerId,
      })
    }
  }
}

/** RF-04 — signal-channel typing entries expire after TYPING_TTL_MS. */
function ensureSignalTypingSweeper(): void {
  const swarm = swarmRef
  if (swarm === null || swarm.typingTimer !== null) return
  swarm.typingTimer = setInterval(() => {
    const active = swarmRef === swarm ? pruneSignalTyping(Date.now()) : false
    if (!active && swarm.typingTimer !== null) {
      clearInterval(swarm.typingTimer)
      swarm.typingTimer = null
    }
  }, 1_000)
}

/** Clears expired typing entries on the swarm's channels; true while any remain. */
function pruneSignalTyping(now: number): boolean {
  let active = false
  const state = useAppStore.getState()
  for (const [key, channel] of Object.entries(state.dms)) {
    if (channel.global !== true) continue
    const ts = channel.typing[key]
    if (ts === undefined) continue
    if (now - ts >= TYPING_TTL_MS) state.setDmTyping(key, null)
    else active = true
  }
  return active
}

// ---------------------------------------------------------------------------
// Peer join / leave
// ---------------------------------------------------------------------------

function handleSignalPeerJoin(swarm: SignalSwarm, peerId: string): void {
  // Announce whoami + identity keys + session-ephemeral key, directed at the
  // joiner — the room join burst over the signal swarm (§12.5: keys/ephkeys
  // "anuncio como en sala").
  const identity = getSessionIdentity()
  if (identity !== null) {
    safeSend(
      swarm.actions.whoami,
      { nick: identity.identity.nickname, fp: identity.identity.fingerprint },
      { target: peerId },
    )
    safeSend(swarm.actions.keys, identity.rawPublicKey, { target: peerId })
    void ensureEphemeralSession().then((session) => {
      safeSend(swarm.actions.ephkeys, session.rawPublicKey, { target: peerId })
    })
  }
  // A peer that was already in a channel with us is (back) reachable.
  const channelKey = channelKeyOf(swarm, peerId)
  if (channelKey !== null) useAppStore.getState().setDmAvailable(channelKey, true)
}

function handleSignalPeerLeave(swarm: SignalSwarm, peerId: string): void {
  const channelKey = channelKeyOf(swarm, peerId)
  const declared = swarm.declaredFps.get(peerId)
  swarm.declaredFps.delete(peerId)
  swarm.peerKeys.delete(peerId)
  swarm.peerKeyFps.delete(peerId)
  swarm.peerEphKeys.delete(peerId)
  swarm.peerEphFps.delete(peerId)
  if (declared !== undefined) swarm.presence.delete(declared)
  // Knock state dies with the peer: their ack could never land, and an
  // inbound consent card for a departed peer is stale.
  for (const [fp, knock] of [...swarm.inboundKnocks]) {
    if (knock.peerId === peerId) swarm.inboundKnocks.delete(fp)
  }
  for (const [fp, pendingPeerId] of [...swarm.pendingKnocks]) {
    if (pendingPeerId === peerId) swarm.pendingKnocks.delete(fp)
  }
  // The channel passes to the RF-04 disconnected state — history stays.
  if (channelKey !== null) {
    const state = useAppStore.getState()
    state.setDmAvailable(channelKey, false)
    state.setDmTyping(channelKey, null)
  }
}

// ---------------------------------------------------------------------------
// Join / leave (bound to Settings.globalDm)
// ---------------------------------------------------------------------------

async function joinSignalSwarm(): Promise<void> {
  if (swarmRef !== null || joining) return
  joining = true
  try {
    // The identity must exist before anything can announce itself.
    await ensureSessionIdentity()
    const roomId = await deriveSignalRoomId()
    // Re-check AFTER the awaits: a toggle-off racing the join must not
    // install a swarm (nothing was joined yet — the factory call follows).
    if (!globalDmEnabled() || swarmRef !== null) return
    const room = joinAuxiliarySwarm(roomId)
    const actions = makeSignalActions(room)
    const swarm: SignalSwarm = {
      roomId,
      room,
      actions,
      seenDmIds: new BoundedSeenIds(),
      peerKeys: new Map(),
      peerKeyFps: new Map(),
      peerEphKeys: new Map(),
      peerEphFps: new Map(),
      declaredFps: new Map(),
      presence: new Map(),
      knockTimes: new Map(),
      inboundKnocks: new Map(),
      pendingKnocks: new Map(),
      pendingReceipts: new Map(),
      receiptTimer: null,
      typingTimer: null,
    }
    actions.whoami.onMessage = (data, context) => handleWhoami(swarm, data, context.peerId)
    actions.knock.onMessage = (data, context) => handleKnock(swarm, data, context.peerId)
    actions['knock-ack'].onMessage = (data, context) => handleKnockAck(swarm, data, context.peerId)
    actions.keys.onMessage = (data, context) => handleKeys(swarm, data, context.peerId)
    actions.ephkeys.onMessage = (data, context) => handleEphKeys(swarm, data, context.peerId)
    actions.dm.onMessage = (data, context) => handleSignalDm(swarm, data, context.peerId)
    actions.typing.onMessage = (data, context) => handleSignalTyping(swarm, data, context.peerId)
    actions.receipt.onMessage = (data, context) => handleSignalReceipt(swarm, data, context.peerId)
    room.onPeerJoin = (peerId) => handleSignalPeerJoin(swarm, peerId)
    room.onPeerLeave = (peerId) => handleSignalPeerLeave(swarm, peerId)
    swarmRef = swarm
  } finally {
    joining = false
  }
}

/**
 * §12.5 teardown: leaves the swarm EN EL ACTO and destroys ALL in-memory
 * channel state — presence, knock budgets, pending acks. With
 * `markDisconnected` (the toggle path) every signal-backed channel passes to
 * the RF-04 «El par se ha desconectado» state, history in memory; the panic
 * path passes false (the store reset follows immediately, the room
 * abortAllRooms/abortAllManualDms convention).
 */
function leaveSignalSwarm(markDisconnected: boolean): void {
  const swarm = swarmRef
  swarmRef = null
  if (swarm === null) return
  swarm.room.onPeerJoin = null
  swarm.room.onPeerLeave = null
  try {
    void swarm.room.leave()
  } catch {
    // Fake transports may not implement leave; nothing further to clean.
  }
  if (swarm.receiptTimer !== null) {
    clearTimeout(swarm.receiptTimer)
    swarm.receiptTimer = null
  }
  if (swarm.typingTimer !== null) {
    clearInterval(swarm.typingTimer)
    swarm.typingTimer = null
  }
  swarm.pendingReceipts.clear()
  if (markDisconnected) {
    const state = useAppStore.getState()
    for (const [key, channel] of Object.entries(state.dms)) {
      if (channel.global !== true) continue
      state.setDmAvailable(key, false)
      state.setDmTyping(key, null)
    }
  }
}

/**
 * Applies a Settings.globalDm change: ON joins (+ announces on the first
 * peer join), OFF tears everything down. Also the module's boot path — the
 * subscription below only fires on CHANGES, so a persisted ON setting
 * (reload with the toggle set) joins right here.
 */
function applyGlobalDmSetting(): void {
  if (globalDmEnabled()) void joinSignalSwarm()
  else leaveSignalSwarm(true)
}

// ---------------------------------------------------------------------------
// Module-load wiring (the react/history precedent: subscriptions are wiring,
// never disposable state — resetSignalChannelForTests drops state only)
// ---------------------------------------------------------------------------

useSettingsStore.subscribe((state, prev) => {
  if (state.settings.globalDm !== prev.settings.globalDm) applyGlobalDmSetting()
})

// Boot: join immediately when the persisted setting is already on.
if (globalDmEnabled()) void joinSignalSwarm()

// Nickname changes re-announce presence (spec §12.5: "difusión al conectar
// y al cambiar apodo"), watched through the store the room path writes.
useAppStore.subscribe((state, prev) => {
  const swarm = swarmRef
  if (swarm === null) return
  if (state.identity === null || prev.identity === null) return
  if (state.identity.nickname === prev.identity.nickname) return
  safeSend(swarm.actions.whoami, {
    nick: state.identity.nickname,
    fp: state.identity.fingerprint,
  })
})

// Identity regeneration: re-announce the FINAL new material (identity keys +
// fresh session-ephemeral key) to every present peer, room-path parity —
// signal-backed channels keep working across an RF-07 regeneration.
onIdentityMaterialRebroadcast((session, ephemeral) => {
  const swarm = swarmRef
  if (swarm === null) return
  safeSend(swarm.actions.whoami, {
    nick: session.identity.nickname,
    fp: session.identity.fingerprint,
  })
  for (const peerId of swarm.peerKeys.keys()) {
    safeSend(swarm.actions.keys, session.rawPublicKey, { target: peerId })
    safeSend(swarm.actions.ephkeys, ephemeral.rawPublicKey, { target: peerId })
  }
})

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Whether the global-DM opt-in is currently on (the setting, live). */
export function isGlobalDmEnabled(): boolean {
  return globalDmEnabled()
}

/**
 * The toggle (phase 3's Ajustes → Privacidad switch): writes the setting;
 * the module-level subscription performs the actual join/leave, so UI wiring
 * stays declarative.
 */
export function setGlobalDmEnabled(on: boolean): void {
  useSettingsStore.getState().setSettings({ globalDm: on })
}

/** Test/observability seam: whether the signal swarm is currently joined. */
export function isSignalChannelJoined(): boolean {
  return swarmRef !== null
}

/**
 * Engine-state presence snapshot (spec §12.5: engine state, never a
 * browsable UI directory — this exists for tests and the phase-3 «Contacto
 * por huella» lookup, capped at MAX_SIGNAL_PRESENCE by construction).
 */
export function getSignalPresence(): Array<{ fp: string; nick: string }> {
  const swarm = swarmRef
  if (swarm === null) return []
  return [...swarm.presence.entries()].map(([fp, entry]) => ({ fp, nick: entry.nick }))
}

/** Inbound knocks awaiting consent (the phase-3 card's state source). */
export function getPendingKnocks(): SignalKnock[] {
  const swarm = swarmRef
  if (swarm === null) return []
  return [...swarm.inboundKnocks.entries()].map(([fp, knock]) => ({
    fp,
    nick: knock.nick,
    ...(knock.note !== undefined ? { note: knock.note } : {}),
  }))
}

/**
 * Knocking OUT (§12.5 «Contacto por huella»): sends a directed knock to the
 * peer whose PRESENCE entry declares `fp`. Throws the typed KnockError when
 * the swarm is off (`signal-off`), the fingerprint is not present
 * (`peer-not-present`) or the knock cannot be built (`invalid-knock`). The
 * knock is remembered until its ack (or the peer's leave) so the accept path
 * can open the channel.
 */
export function knockPeer(fp: string, note?: string): void {
  const swarm = swarmRef
  if (swarm === null) throw new KnockError('signal-off')
  const canonical = canonicalFingerprint(fp)
  const entry = swarm.presence.get(canonical)
  if (entry === undefined) throw new KnockError('peer-not-present')
  const identity = getSessionIdentity()
  if (identity === null) throw new KnockError('signal-off')
  const payload = parseKnock({
    type: 'knock',
    from: { fp: identity.identity.fingerprint, nick: identity.identity.nickname },
    ...(note !== undefined ? { note: note.slice(0, NOTE_MAX_LENGTH) } : {}),
  })
  if (payload === null) throw new KnockError('invalid-knock')
  swarm.pendingKnocks.set(canonical, entry.peerId)
  safeSend(swarm.actions.knock, payload, { target: entry.peerId })
}

/**
 * Consent (phase 3's [Aceptar]): answers the knocker with
 * `knock-ack {accept: true, fp: <knocker>}` and opens the signal-backed
 * channel on BOTH sides' convention — here (the acceptor's) immediately; the
 * knocker opens on its ack. No-op for an unknown/stale knock.
 */
export function acceptKnock(fp: string): void {
  const swarm = swarmRef
  if (swarm === null) return
  const canonical = canonicalFingerprint(fp)
  const knock = swarm.inboundKnocks.get(canonical)
  if (knock === undefined) return
  swarm.inboundKnocks.delete(canonical)
  safeSend(swarm.actions['knock-ack'], { accept: true, fp: canonical } satisfies KnockAckPayload, {
    target: knock.peerId,
  })
  openSignalChannel(swarm, canonical, knock.nick)
}

/**
 * Rejection (phase 3's [Rechazar]): answers `knock-ack {accept: false}` and
 * forgets the knocker — no channel, nothing remembered (no contact store;
 * per-session state, spec §12.5). No-op for an unknown/stale knock.
 */
export function rejectKnock(fp: string): void {
  const swarm = swarmRef
  if (swarm === null) return
  const canonical = canonicalFingerprint(fp)
  const knock = swarm.inboundKnocks.get(canonical)
  if (knock === undefined) return
  swarm.inboundKnocks.delete(canonical)
  safeSend(swarm.actions['knock-ack'], { accept: false, fp: canonical } satisfies KnockAckPayload, {
    target: knock.peerId,
  })
}

/** Opens (or retakes) the signal-backed channel for `channelKey`. */
function openSignalChannel(swarm: SignalSwarm, channelKey: string, peerNick: string): void {
  const peerId = peerIdForChannelKey(swarm, channelKey)
  const liveFp = peerId !== null ? keysDerivedFp(swarm, peerId) : null
  // First pin (if any key material is known yet) + channel + availability.
  if (liveFp !== null) pinTofuFingerprint(channelKey, liveFp)
  reconcileSignalChannel(channelKey, peerNick, liveFp)
  useAppStore.getState().setDmAvailable(channelKey, true)
}

/**
 * The SIGNAL backing of the DmTransport interface (§12.5): the same surface
 * the room transport exposes, resolved over this swarm's key maps and
 * directed sends. Returns null while the swarm is off or the fingerprint is
 * not a connected peer.
 */
export function signalDmTransport(fp: string): DmTransport | null {
  const swarm = swarmRef
  if (swarm === null) return null
  const channelKey = canonicalFingerprint(fp)
  const peerId = peerIdForChannelKey(swarm, channelKey)
  if (peerId === null) return null
  return {
    kind: 'signal',
    channelKey,
    peerId,
    available: () =>
      swarmRef === swarm &&
      swarm.declaredFps.has(peerId) &&
      useAppStore.getState().dms[channelKey] !== undefined,
    peerIdentityFingerprint: () => keysDerivedFp(swarm, peerId),
    peerEphemeralKey: () => {
      const rawKey = swarm.peerEphKeys.get(peerId)
      const fingerprint = swarm.peerEphFps.get(peerId)
      return rawKey !== undefined && fingerprint !== undefined ? { rawKey, fingerprint } : null
    },
    sendDmEnvelope: (envelope) => safeSend(swarm.actions.dm, envelope, { target: peerId }),
    sendTyping: (on) =>
      safeSend(swarm.actions.typing, { on, dm: true } satisfies TypingPayload, {
        target: peerId,
      }),
    sendReceipts: (ids) =>
      safeSend(swarm.actions.receipt, { ids } satisfies ReceiptPayload, { target: peerId }),
  }
}

/**
 * Sends a dm over the signal-backed channel (the room sendDm mirror through
 * the shared DmTransport key resolution): seals with the cached v2 key,
 * delivers directed, echoes into `dms[channelKey]`. Returns false — nothing
 * sent, nothing echoed — when the swarm is off, the channel is unknown or
 * unavailable, the text exceeds the protocol cap, or the key cannot be
 * derived (a peer whose announces have not landed). Never throws.
 */
export async function sendSignalDm(fp: string, text: string, ttl?: number): Promise<boolean> {
  const identity = getSessionIdentity()
  const transport = signalDmTransport(fp)
  if (identity === null || transport === null || !transport.available()) return false
  if (text.length > MAX_PLAINTEXT_LENGTH) return false
  const key = await deriveDmSessionKey(identity.identity.fingerprint, transport)
  if (key === null) return false
  const sealed = await encryptDm(key, text)
  const envelope = createEnvelope({
    from: getSelfPeerId(),
    nick: identity.identity.nickname,
    kind: 'dm',
    to: transport.peerId,
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
    v: DM_PROTOCOL_VERSION,
    ...(ttl !== undefined ? { ttl } : {}),
  })
  transport.sendDmEnvelope(envelope)
  const channelKey = transport.channelKey
  const liveFp = transport.peerIdentityFingerprint()
  if (liveFp !== null) reconcileExistingSignalChannel(channelKey, liveFp)
  const expiresAt = ttl === undefined ? undefined : Date.now() + ttl * 1000
  useAppStore.getState().appendDmMessage(channelKey, {
    id: envelope.id,
    roomId: `dm:${channelKey}`,
    authorId: 'self',
    authorNick: envelope.nick,
    text,
    ts: envelope.ts,
    encrypted: false,
    status: 'sent',
    kind: 'user',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
  return true
}

/** §7.1 DM typing over the signal channel (best-effort, like the room path). */
export function sendSignalDmTyping(fp: string, on: boolean): void {
  signalDmTransport(fp)?.sendTyping(on)
}

// ---------------------------------------------------------------------------
// Panic + tests
// ---------------------------------------------------------------------------

/**
 * RF-08 support — synchronously tears the signal swarm down (leave + every
 * in-memory map dropped). Channel bookkeeping is skipped: the panic path
 * resets the store right after (the abortAllManualDms convention).
 */
export function abortSignalChannel(): void {
  leaveSignalSwarm(false)
}

/**
 * Test-only reset: tears the swarm down (channels marked disconnected so a
 * following store reset starts pristine either way) and clears the
 * disposable knock listeners. The module-load wiring (settings/nickname/
 * rebroadcast subscriptions) is intentionally kept — it is wiring, not
 * state. resetManagerForTests restores DEFAULT_SETTINGS, whose globalDm:
 * false trips the module subscription and tears the swarm down too; this
 * explicit reset keeps signal-channel tests independent of that ordering.
 */
export function resetSignalChannelForTests(): void {
  leaveSignalSwarm(true)
  knockListeners.clear()
  knockResolutionListeners.clear()
}
