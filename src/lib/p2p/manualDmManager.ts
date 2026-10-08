import { ManualPeerEngine, ManualPeerError, type ManualPeerState } from './manualPeer'
import type { Envelope } from './protocol'
import { canonicalFingerprint } from '../crypto/dm'
import { ensureSessionIdentity, getSessionIdentity, TYPING_TTL_MS } from './roomManager'
import { ensureEphemeralSession, type EphemeralSession } from '../crypto/sessionEphemeral'
import type { SessionIdentity } from '../crypto/identity'
import { sanitizeRemoteNick } from '../nickname'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { getTofuFingerprint, pinMatchesFingerprint, pinTofuFingerprint } from '../tofu'

/**
 * UI-facing manager for trackerless manual DMs — spec.md §12.2, issue #97
 * phase 3. Plays the roomManager role for the manual path (the mirror of the
 * M3 DM wiring): it owns the live ManualPeerEngine instances, feeds their
 * callbacks into the `manualDms` store slice and exposes the wizard/sends
 * surface the UI consumes. Components never touch WebRTC — they only see
 * this module (through useRoomManager) and the store (§12.2 rule).
 *
 * Identity/ephemeral material comes from the SAME seams the room path uses:
 * `ensureSessionIdentity`/`getSessionIdentity` (roomManager) and
 * `ensureEphemeralSession` (sessionEphemeral). Keys are never regenerated
 * here — the blob announces the session's existing identity + ephemeral
 * public keys, so a manual peer verifies exactly the fingerprint shown in
 * rooms (RF-04).
 *
 * TOFU (§12.2): manual peers have no Trystero peerId, so the pin rides the
 * SAME flat `gritos:tofu` map under the reserved key
 * `manual:<canonical-fingerprint>` → display fingerprint (first-write-wins,
 * the #23 prefix rule inherited through pinMatchesFingerprint). A later
 * exchange with a DIFFERENT identity under the same key flags the channel
 * `keyChanged` — the exact advisory notice room DMs show — and keeps the
 * pinned fingerprint displayed. Pins are the only persisted trace: channels
 * are session-only (nothing beyond `gritos:tofu`).
 *
 * Lifecycle: at most ONE pending wizard flow at a time (`pendingFlow`), in
 * whatever §12.2 waiting state; cancellation disposes its engine with no
 * store trace (channels are only created on connect). On `connected` the
 * engine graduates into `connectedEngines` keyed by the canonical remote
 * fingerprint and lands the user in the standard DM view; a later exchange
 * with the same identity replaces the (necessarily dead) previous engine and
 * retakes the SAME channel with its history intact (§12.2 reconnection). A
 * post-connect drop surfaces as `available: false` — the room-DM «El par se
 * ha desconectado» state, composer hard-blocked, history in memory.
 */

/** Reserved `gritos:tofu` key prefix for fingerprint-keyed manual pins. */
export const MANUAL_DM_KEY_PREFIX = 'manual:'

/** Store key of a manual channel: `manual:<canonical-fingerprint>`. */
export function manualDmKey(canonical: string): string {
  return `${MANUAL_DM_KEY_PREFIX}${canonical}`
}

/** Forwarded engine event — the wizard's progress/error source. */
export type ManualDmEventCallback = (state: ManualPeerState, error?: ManualPeerError) => void

interface PendingFlow {
  readonly engine: ManualPeerEngine
}

/** The wizard's in-progress exchange, if any (pre-connect). */
let pendingFlow: PendingFlow | null = null

/**
 * Creation of the pending flow while still in flight (the identity and
 * ephemeral material resolve over several async turns): paste calls queue
 * on it, because the wizard exposes the paste controls the instant the role
 * screen renders — a fast paste must wait for the engine, never bounce.
 */
let pendingCreation: Promise<ManualPeerEngine> | null = null

/**
 * Monotonic flow token: cancellation bumps it so an engine creation that
 * lands after its own cancel never installs a zombie pending flow.
 */
let flowGeneration = 0

/** Connected (or dropped) engines by store key `manual:<canonical-fp>`. */
const connectedEngines = new Map<string, ManualPeerEngine>()

/** Channel key of every engine that reached `connected` (callback routing). */
const engineKeys = new WeakMap<ManualPeerEngine, string>()

/** Typing sweeper of the manual channels (mirror of the room-path timer). */
let typingTimer: ReturnType<typeof setInterval> | null = null

function pruneExpiredManualTyping(now: number): void {
  for (const [key, channel] of Object.entries(useAppStore.getState().manualDms)) {
    const ts = channel.typing[key]
    if (ts === undefined) continue
    if (now - ts >= TYPING_TTL_MS) useAppStore.getState().setManualDmTyping(key, null)
  }
}

function ensureManualTypingSweeper(): void {
  if (typingTimer !== null) return
  typingTimer = setInterval(() => {
    pruneExpiredManualTyping(Date.now())
    const typingActive = Object.values(useAppStore.getState().manualDms).some(
      (channel) => Object.keys(channel.typing).length > 0,
    )
    if (!typingActive && typingTimer !== null) {
      clearInterval(typingTimer)
      typingTimer = null
    }
  }, 1_000)
}

/**
 * Nickname shown for a manual peer: the blob's advisory `nick` (sanitized at
 * the boundary like the room presence path, issue #28) or a fingerprint-
 * derived fallback when nothing legible travels — the identity is the
 * fingerprint, the nick is decoration (§12.2).
 */
function manualPeerNickname(engine: ManualPeerEngine): string {
  const sanitized = sanitizeRemoteNick(engine.remoteNick ?? '')
  if (sanitized !== null) return sanitized
  return `par ${engine.remoteFingerprint?.slice(0, 4) ?? '????'}`
}

/**
 * §12.2 — connect-time reconciliation: TOFU pin (first write wins) + channel
 * creation + the same divergence flag room DMs use. `pinned` is displayed
 * once it exists (stale pins win over the live value, issue #22 semantics).
 */
function reconcileManualChannel(engine: ManualPeerEngine): string {
  const remoteFingerprint = engine.remoteFingerprint
  if (remoteFingerprint === null) {
    throw new ManualPeerError('not-connected', 'No hay par validado')
  }
  const key = manualDmKey(canonicalFingerprint(remoteFingerprint))
  pinTofuFingerprint(key, remoteFingerprint)
  const pinned = getTofuFingerprint(key)
  const pinStale = pinned !== null && !pinMatchesFingerprint(pinned, remoteFingerprint)
  const state = useAppStore.getState()
  state.ensureManualDmChannel(
    key,
    manualPeerNickname(engine),
    pinStale ? pinned : remoteFingerprint,
  )
  state.setManualDmKeyChanged(key, pinStale)
  state.setManualDmAvailable(key, true)
  return key
}

/** Expiry on the RECEIVER clock (issue #96 rule shared with the room path). */
function expiresAtFor(ttl: number | undefined, receivedAt: number): number | undefined {
  return ttl === undefined ? undefined : receivedAt + ttl * 1000
}

/**
 * Connect-time graduation: TOFU + channel + focus + registry swap. The
 * pending flow (this engine) stops being cancellable — the channel is now
 * real and lives in `connectedEngines`.
 */
function handleConnected(engine: ManualPeerEngine): void {
  const key = reconcileManualChannel(engine)
  engineKeys.set(engine, key)
  const previous = connectedEngines.get(key)
  if (previous !== undefined && previous !== engine) {
    // A fresh exchange retakes the SAME channel (§12.2): the old engine is
    // terminal (its link died — blobs are single-use), dispose for hygiene.
    engineKeys.delete(previous)
    previous.dispose()
  }
  connectedEngines.set(key, engine)
  if (pendingFlow?.engine === engine) pendingFlow = null
  useAppStore.getState().setActiveView({ kind: 'dm', peerId: key })
}

function appendReceivedMessage(key: string, envelope: Envelope, text: string): void {
  const expiresAt = expiresAtFor(envelope.ttl, Date.now())
  useAppStore.getState().appendManualDmMessage(key, {
    id: envelope.id,
    roomId: `dm:${key}`,
    authorId: key,
    authorNick: envelope.nick,
    text,
    ts: envelope.ts,
    encrypted: false,
    status: 'delivered',
    kind: 'user',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
}

/**
 * Builds the engine with the full callback wiring (store feeding plus the
 * wizard event forward). The self-reference exists because the callbacks
 * belong to the engine being constructed; events only fire after async
 * turns, when the binding is already set.
 */
async function createWiredEngine(
  role: 'invite' | 'answer',
  onEvent: ManualDmEventCallback,
): Promise<ManualPeerEngine> {
  const session: SessionIdentity = await ensureSessionIdentity()
  const ephemeral: EphemeralSession = await ensureEphemeralSession()
  const ref: { current: ManualPeerEngine | null } = { current: null }
  const engine = new ManualPeerEngine({
    role,
    session,
    ephemeral,
    callbacks: {
      onStateChange: (state, error) => {
        const self = ref.current
        if (self === null) return
        if (state === 'connected') handleConnected(self)
        else if (state === 'disconnected') {
          const key = engineKeys.get(self)
          if (key !== undefined) useAppStore.getState().setManualDmAvailable(key, false)
        }
        onEvent(state, error)
      },
      onDmMessage: (envelope, text) => {
        const key = ref.current === null ? undefined : engineKeys.get(ref.current)
        if (key !== undefined) appendReceivedMessage(key, envelope, text)
      },
      onTyping: (on) => {
        const key = ref.current === null ? undefined : engineKeys.get(ref.current)
        if (key === undefined) return
        useAppStore.getState().setManualDmTyping(key, on ? Date.now() : null)
        if (on) ensureManualTypingSweeper()
      },
      onReceipt: (ids) => {
        const key = ref.current === null ? undefined : engineKeys.get(ref.current)
        if (key === undefined) return
        useAppStore.getState().markManualDmMessagesDelivered(key, ids)
      },
    },
    iceServers: useSettingsStore.getState().settings.iceServers,
  })
  ref.current = engine
  return engine
}

// ---------------------------------------------------------------------------
// Wizard flow (one at a time)
// ---------------------------------------------------------------------------

/**
 * Role A — creates the invite engine and resolves with the invite blob once
 * candidate gathering completes (§12.2 non-trickle). Throws on engine
 * errors; a previous pending flow is disposed first (one wizard at a time).
 */
export async function startManualDmInvite(onEvent: ManualDmEventCallback): Promise<string> {
  cancelManualDm()
  const generation = ++flowGeneration
  const creating = createWiredEngine('invite', onEvent)
  pendingCreation = creating
  const engine = await creating
  if (generation !== flowGeneration) {
    // Cancelled (or superseded) while the engine was being created: dispose
    // and bail — a cancelled flow must never come back to life (§12.2).
    engine.dispose()
    throw new ManualPeerError('illegal-transition', 'La conexión manual fue cancelada')
  }
  pendingCreation = null
  pendingFlow = { engine }
  return engine.createInvite()
}

/**
 * Role B — creates the answer engine (idle). The invite is pasted through
 * `pasteManualInvite`, which resolves with the answer blob.
 */
export async function startManualDmAnswer(onEvent: ManualDmEventCallback): Promise<void> {
  cancelManualDm()
  const generation = ++flowGeneration
  const creating = createWiredEngine('answer', onEvent)
  pendingCreation = creating
  const engine = await creating
  if (generation !== flowGeneration) {
    engine.dispose()
    throw new ManualPeerError('illegal-transition', 'La conexión manual fue cancelada')
  }
  pendingCreation = null
  pendingFlow = { engine }
}

/**
 * The pending engine for a paste call, waiting out an in-flight creation
 * (the wizard's paste controls render before the engine exists — see
 * `pendingCreation`). Throws when no flow is pending or the flow belongs to
 * the other role.
 */
async function requirePendingEngine(role: 'invite' | 'answer'): Promise<ManualPeerEngine> {
  const creating = pendingCreation
  if (creating !== null) {
    await creating.catch(() => {
      throw new ManualPeerError('illegal-transition', 'No hay conexión manual pendiente')
    })
  }
  const engine = pendingFlow?.engine
  if (engine === undefined || engine.role !== role) {
    throw new ManualPeerError('illegal-transition', 'No hay invitación pendiente')
  }
  return engine
}

/** Role A pastes B's answer; rejections leave `invite-ready` (retryable). */
export async function pasteManualAnswer(text: string): Promise<void> {
  const engine = await requirePendingEngine('invite')
  await engine.acceptAnswer(text)
}

/** Role B pastes A's invite; resolves with the answer blob (retryable). */
export async function pasteManualInvite(text: string): Promise<string> {
  const engine = await requirePendingEngine('answer')
  return engine.acceptInvite(text)
}

/**
 * §12.2 cancellation: disposes the pending engine and drops the flow. A
 * no-op once connected (the channel is real; closing the wizard then must
 * NOT kill it) and always idempotent — cancel leaves no store trace because
 * channels are only created on connect. Safe to call while an engine is
 * still being created: the finished engine is disposed on arrival.
 */
export function cancelManualDm(): void {
  flowGeneration += 1
  const flow = pendingFlow
  const creating = pendingCreation
  pendingFlow = null
  pendingCreation = null
  if (flow !== null) {
    flow.engine.dispose()
  } else if (creating !== null) {
    void creating
      .then((engine) => {
        engine.dispose()
      })
      .catch(() => {
        // Creation already failed on its own — nothing left to dispose.
      })
  }
}

// ---------------------------------------------------------------------------
// Connected-channel surface (composer path, mirror of the room DM bridge)
// ---------------------------------------------------------------------------

/**
 * Sends a dm over the manual channel and echoes it into the store (room-DM
 * parity): false when there is no live channel, and when the single-use
 * engine refuses (§12.2 has no §10.3 queue to hide behind).
 */
export async function sendManualDm(key: string, text: string, ttl?: number): Promise<boolean> {
  const engine = connectedEngines.get(key)
  const identity = getSessionIdentity()
  const channel = useAppStore.getState().manualDms[key]
  if (engine === undefined || identity === null || channel === undefined) return false
  let envelope: Envelope
  try {
    envelope = await engine.sendDm(text, ttl)
  } catch {
    return false
  }
  const expiresAt = expiresAtFor(ttl, Date.now())
  useAppStore.getState().appendManualDmMessage(key, {
    id: envelope.id,
    roomId: `dm:${key}`,
    authorId: 'self',
    authorNick: identity.identity.nickname,
    text,
    ts: envelope.ts,
    encrypted: false,
    status: 'sent',
    kind: 'user',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
  return true
}

/** §7.1 DM typing over the manual channel (best-effort, like the engine). */
export function sendManualDmTyping(key: string, on: boolean): void {
  connectedEngines.get(key)?.sendTyping(on)
}

/**
 * RF-08 support — synchronously disposes every manual engine (pending flow
 * and connected channels): the panic path must leave no live manual
 * transport behind. Pins under `gritos:tofu` are wiped by the panic storage
 * sweep; identity regeneration keeps them by design (spec §12.2).
 */
export function abortAllManualDms(): void {
  cancelManualDm()
  for (const [key, engine] of [...connectedEngines]) {
    engineKeys.delete(engine)
    engine.dispose()
    connectedEngines.delete(key)
  }
  if (typingTimer !== null) {
    clearInterval(typingTimer)
    typingTimer = null
  }
  const view = useAppStore.getState().activeView
  if (view?.kind === 'dm' && view.peerId.startsWith(MANUAL_DM_KEY_PREFIX)) {
    useAppStore.getState().setActiveView(null)
  }
}

/** Test-only reset: drops every manual engine and typing timer. */
export function resetManualDmForTests(): void {
  abortAllManualDms()
}
