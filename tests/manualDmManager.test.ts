// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectPair,
  createFakePeerPair,
  dropPair,
  installFakePeerConnectionFactory,
  type FakePeerPair,
  type FakeRTCPeerConnection,
} from './fakeManualPeer'
import {
  ManualPeerEngine,
  setPeerConnectionFactory,
  type ManualPeerState,
} from '../src/lib/p2p/manualPeer'
import {
  cancelManualDm,
  manualDmKey,
  pasteManualAnswer,
  pasteManualInvite,
  resetManualDmForTests,
  sendManualDm,
  sendManualDmTyping,
  startManualDmAnswer,
  startManualDmInvite,
} from '../src/lib/p2p/manualDmManager'
import { resetManagerForTests, regenerateSessionIdentity } from '../src/lib/p2p/roomManager'
import { createSessionIdentity, type SessionIdentity } from '../src/lib/crypto/identity'
import { generateEphemeralSession, type EphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import { canonicalFingerprint, clearDmKeyCache } from '../src/lib/crypto/dm'
import type { Envelope } from '../src/lib/p2p/protocol'
import { INITIAL_APP_STATE, useAppStore } from '../src/stores/useAppStore'
import { TOFU_STORAGE_KEY } from '../src/lib/tofu'
import { panicWipe } from '../src/lib/panic'

/**
 * Phase 3 store/manager wiring of issue #97 (spec §12.2): the
 * manualDmManager feeding the `manualDms` slice, the fingerprint-keyed TOFU
 * pins under `manual:` and the connected-channel surface (dm/typing/
 * receipts/disconnect/cancel). jsdom for localStorage — the pins are the
 * one persisted trace of the feature. The transport is the fake PC pair
 * (fakeManualPeer): the manager side runs the REAL engine through the
 * wizard seam; the peer side is a raw engine driven by the test.
 */

const FP_FOREIGN = 'DEAD BEEF CAFE 0000 1111 2222 3333 4444'

let sessionB: SessionIdentity
let ephB: EphemeralSession

beforeEach(async () => {
  localStorage.clear()
  clearDmKeyCache()
  sessionB = await createSessionIdentity('zorro-b')
  ephB = await generateEphemeralSession()
})

afterEach(() => {
  resetManualDmForTests()
  resetManagerForTests()
  setPeerConnectionFactory(null)
  useAppStore.setState({ ...INITIAL_APP_STATE })
  localStorage.clear()
  vi.useRealTimers()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Lets the async decrypt/receipt tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return sleep(120)
}

/** One event-loop turn via MessageChannel (manualPeer.test pattern). */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}

/**
 * One real event-loop turn that fake timers never intercept (none are used
 * here, but the pump mirrors manualPeer.test) and that lets starved Web
 * Crypto completions interleave — MessageChannel ticks alone burn thousands
 * of iterations in microseconds without the hash landing.
 */
function yieldRealTurn(): Promise<void> {
  // Off globalThis: the DOM lib does not declare setImmediate.
  const immediate = (globalThis as { setImmediate?: (callback: () => void) => void }).setImmediate
  if (typeof immediate === 'function') {
    return new Promise((resolve) => immediate(resolve))
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Pumps turns until the fake PC is parked in its gather wait. */
async function untilParked(getPc: () => FakeRTCPeerConnection): Promise<void> {
  // Cheap turns first (crypto usually lands within a few event-loop turns),
  // then real-turn yields bounded by a 5 s wall-clock deadline: under the
  // full parallel suite the Web Crypto threadpool is starved across workers
  // and short tick loops give up before the hash lands.
  for (let i = 0; i < 20; i += 1) {
    await tick()
    if (getPc().localDescription !== null) return
  }
  const deadline = Date.now() + 5_000
  for (;;) {
    await yieldRealTurn()
    if (getPc().localDescription !== null) return
    if (Date.now() >= deadline) {
      throw new Error('fake pc never reached setLocalDescription')
    }
  }
}

/** Polls `cond` with real sleeps (Web Crypto completions must land). */
async function until(cond: () => boolean, what: string): Promise<void> {
  // 5 s bound: enough for starved-crypto full-suite runs, far above the
  // normal few-ms happy path.
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error(`timeout: ${what}`)
}

interface PeerSide {
  engine: ManualPeerEngine
  received: Array<{ envelope: Envelope; text: string }>
  typingEvents: boolean[]
  receiptIds: string[]
  states: ManualPeerState[]
}

/** The remote peer: a raw engine over the second PC of the pair. */
function makePeerSide(
  pair: FakePeerPair,
  inviteBlob: string,
): {
  side: PeerSide
  answer: Promise<string>
} {
  const side: PeerSide = {
    engine: null as unknown as ManualPeerEngine,
    received: [],
    typingEvents: [],
    receiptIds: [],
    states: [],
  }
  const engine = new ManualPeerEngine({
    role: 'answer',
    session: sessionB,
    ephemeral: ephB,
    callbacks: {
      onStateChange: (state) => {
        side.states.push(state)
      },
      onDmMessage: (envelope, text) => {
        side.received.push({ envelope, text })
      },
      onTyping: (on) => {
        side.typingEvents.push(on)
      },
      onReceipt: (ids) => {
        side.receiptIds.push(...ids)
      },
    },
  })
  side.engine = engine
  const answer = engine.acceptInvite(inviteBlob)
  // The engine parks in ITS gather wait on the second PC of the pair.
  const parked = untilParked(() => pair.pcB).then(() => {
    pair.pcB.completeGathering()
  })
  return { side, answer: Promise.all([answer, parked]).then(([blob]) => blob) }
}

/** Full handshake through the manager (role A) against the raw peer side. */
async function connectThroughManager() {
  const pair = createFakePeerPair()
  installFakePeerConnectionFactory([pair.pcA, pair.pcB])
  const states: ManualPeerState[] = []
  const inviting = startManualDmInvite((_state) => {
    states.push(_state)
  })
  await untilParked(() => pair.pcA)
  pair.pcA.completeGathering()
  const inviteBlob = await inviting
  const { side, answer } = makePeerSide(pair, inviteBlob)
  const answerBlob = await answer
  await pasteManualAnswer(answerBlob)
  connectPair(pair)
  const key = manualDmKey(canonicalFingerprint(sessionB.identity.fingerprint))
  await until(
    () => useAppStore.getState().manualDms[key]?.available === true,
    'manager channel never connected',
  )
  return { pair, side, states, key, inviteBlob, answerBlob }
}

describe('manualDmManager (issue #97, spec §12.2)', () => {
  it('pins the first fingerprint under manual:<canonical-fp> on connect and opens the channel', async () => {
    const { key } = await connectThroughManager()

    const state = useAppStore.getState()
    const channel = state.manualDms[key]
    expect(channel).toBeDefined()
    expect(channel?.available).toBe(true)
    expect(channel?.manual).toBe(true)
    expect(channel?.peerNick).toBe('zorro-b')
    expect(channel?.peerFingerprint).toBe(sessionB.identity.fingerprint)
    expect(channel?.keyChanged).toBe(false)
    // The manager lands the user in the standard DM view (§12.2 contract).
    expect(state.activeView).toEqual({ kind: 'dm', peerId: key })

    // The only persisted trace: the fingerprint-keyed TOFU pin (first write
    // wins, same flat gritos:tofu map — §12.2).
    const pins = JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >
    expect(pins[key]).toBe(sessionB.identity.fingerprint)
  })

  it('flags keyChanged and keeps the pinned fingerprint on divergence', async () => {
    // Pre-pin a DIFFERENT fingerprint for this identity (a rotated key).
    const key = manualDmKey(canonicalFingerprint(sessionB.identity.fingerprint))
    localStorage.setItem(TOFU_STORAGE_KEY, JSON.stringify({ [key]: FP_FOREIGN }))

    const { key: connectedKey } = await connectThroughManager()

    const channel = useAppStore.getState().manualDms[connectedKey]
    expect(channel?.keyChanged).toBe(true)
    // The pinned first-seen fingerprint stays the displayed identity.
    expect(channel?.peerFingerprint).toBe(FP_FOREIGN)
    // First-write-wins: the pin was NOT overwritten by the live fingerprint.
    const pins = JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >
    expect(pins[connectedKey]).toBe(FP_FOREIGN)
  })

  it('delivers dm, typing and receipts both ways over the manual channel', async () => {
    const { key, side } = await connectThroughManager()

    // Own send: echoed into the store and delivered to the peer, whose
    // auto-receipt flips the message to ✓✓ (same §7.1 discipline).
    const sent = await sendManualDm(key, 'hola manual')
    expect(sent).toBe(true)
    const ownMessage = useAppStore.getState().manualDms[key]?.messages[0]
    expect(ownMessage?.text).toBe('hola manual')
    expect(ownMessage?.authorId).toBe('self')
    await until(() => side.received.length > 0, 'peer never received the dm')
    expect(side.received[0]?.text).toBe('hola manual')
    await until(
      () => useAppStore.getState().manualDms[key]?.messages[0]?.status === 'delivered',
      'receipt never landed',
    )

    // The reverse direction: B's dm lands on the channel and A's auto-
    // receipt reaches B's onReceipt callback (✓✓ round trip).
    const reply = await side.engine.sendDm('hola de vuelta')
    await until(
      () =>
        (useAppStore.getState().manualDms[key]?.messages ?? []).some(
          (message) => message.text === 'hola de vuelta' && message.authorId === key,
        ),
      'reply never landed on the channel',
    )
    await until(() => side.receiptIds.includes(reply.id), 'peer never received its receipt')
    // The connect focused the channel, so the reply never counts as unread.
    expect(useAppStore.getState().manualDms[key]?.unread).toBe(0)

    // Composer typing → the peer sees the flag; peer typing → the channel.
    sendManualDmTyping(key, true)
    await until(() => side.typingEvents.includes(true), 'peer never saw the typing flag')
    side.engine.sendTyping(true)
    await until(
      () => Object.keys(useAppStore.getState().manualDms[key]?.typing ?? {}).length > 0,
      'typing never landed on the channel',
    )
    side.engine.sendTyping(false)
    await until(
      () => Object.keys(useAppStore.getState().manualDms[key]?.typing ?? {}).length === 0,
      'typing stop never cleared the channel',
    )

    // An unsendable channel reports false instead of throwing (room parity).
    expect(await sendManualDm('manual:nope', 'x')).toBe(false)
  })

  it('a drop after connect mirrors the room disconnected state, history intact', async () => {
    const { key, pair } = await connectThroughManager()
    await sendManualDm(key, 'before the drop')
    await flushCrypto()

    dropPair(pair)
    await until(
      () => useAppStore.getState().manualDms[key]?.available === false,
      'drop never flipped available',
    )
    const channel = useAppStore.getState().manualDms[key]
    expect(channel?.messages).toHaveLength(1)
    // A dropped channel refuses sends (single-use engine, §12.2).
    expect(await sendManualDm(key, 'after the drop')).toBe(false)
  })

  it('cancel disposes the pending engine and leaves no store trace', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const inviting = startManualDmInvite(vi.fn())
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    await inviting

    cancelManualDm()

    // §12.2: cancel closes the transport (dispose assertions watch `closed`)
    // and, pre-connect, leaves zero channel state behind.
    expect(pair.pcA.closed).toBe(true)
    expect(useAppStore.getState().manualDms).toEqual({})
    expect(useAppStore.getState().activeView).toBeNull()
  })

  it('startManualDmAnswer creates a cancellable flow that produces the answer blob', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    await startManualDmAnswer(vi.fn())

    // The peer side (role A) is the raw engine here.
    const sessionA = await createSessionIdentity('zorro-a')
    const ephA = await generateEphemeralSession()
    const engineA = new ManualPeerEngine({ role: 'invite', session: sessionA, ephemeral: ephA })
    const inviting = engineA.createInvite()
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    const inviteBlob = await inviting

    // The wizard (role B) pastes the invite; ITS pc is the second in queue.
    const answering = (async () => {
      const pending = pasteManualInvite(inviteBlob)
      await untilParked(() => pair.pcB)
      pair.pcB.completeGathering()
      return pending
    })()
    const answerBlob = await answering
    expect(answerBlob.length).toBeGreaterThan(0)
    await engineA.acceptAnswer(answerBlob)
    connectPair(pair)

    const key = manualDmKey(canonicalFingerprint(sessionA.identity.fingerprint))
    await until(
      () => useAppStore.getState().manualDms[key]?.available === true,
      'manager channel never connected (role B)',
    )
    cancelManualDm()
    // Post-connect cancel is a no-op: the channel is real now.
    expect(useAppStore.getState().manualDms[key]?.available).toBe(true)
  })

  // -- RF-07 × #97 (spec §12.2): identity regeneration invalidates everything --

  it('identity regeneration cancels the pending wizard flow (ephemeral state only)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const states: ManualPeerState[] = []
    const inviting = startManualDmInvite((state) => {
      states.push(state)
    })
    await untilParked(() => pair.pcA)
    pair.pcA.completeGathering()
    await inviting

    // The seam: the manager listens on onSessionIdentityRegenerated — no
    // explicit call from the room path.
    await regenerateSessionIdentity()

    // The pending engine is disposed (transport closed) and the wizard is
    // told, so it lands on the failure screen instead of waiting forever.
    expect(pair.pcA.closed).toBe(true)
    expect(states[states.length - 1]).toBe('failed')
    // No store trace was ever created (channels exist only on connect) and
    // a late paste finds no flow: nothing resurrects.
    expect(useAppStore.getState().manualDms).toEqual({})
    await expect(pasteManualAnswer('AAAA')).rejects.toThrow()
  })

  it('identity regeneration kills the live manual channel, pin kept', async () => {
    const { key, pair } = await connectThroughManager()
    await sendManualDm(key, 'antes de regenerar')
    await flushCrypto()
    const pinsBefore = JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >
    expect(pinsBefore[key]).toBe(sessionB.identity.fingerprint)

    await regenerateSessionIdentity()

    // The channel dies with its keys: RF-04 disconnected state ("The peer
    // has disconnected"), history in memory, sends refused. The remote pin
    // (a public value) survives the regeneration, like the room pins.
    expect(pair.pcA.closed).toBe(true)
    const channel = useAppStore.getState().manualDms[key]
    expect(channel?.available).toBe(false)
    expect(channel?.messages).toHaveLength(1)
    expect(await sendManualDm(key, 'tras regenerar')).toBe(false)
    const pinsAfter = JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) ?? '{}') as Record<
      string,
      string
    >
    expect(pinsAfter[key]).toBe(sessionB.identity.fingerprint)
  })

  it('panicWipe aborts the live manual transport (RF-08 × #97)', async () => {
    const { key, pair } = await connectThroughManager()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })

    panicWipe({ reload: false })

    // The engine transport is really closed — the store reset alone would
    // not prove abortAllManualDms ran.
    expect(pair.pcA.closed).toBe(true)
    expect(useAppStore.getState().manualDms).toEqual({})
    expect(useAppStore.getState().activeView).toBeNull()
    expect(await sendManualDm(key, 'after the panic')).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
