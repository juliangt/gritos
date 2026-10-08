import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_GUARD_MS,
  ICE_GATHER_GUARD_MS,
  MANUAL_BLOB_VERSION,
  ManualBlobError,
  ManualPeerEngine,
  ManualPeerError,
  createAnswerBlob,
  createInviteBlob,
  parseManualBlob,
  setPeerConnectionFactory,
} from '../src/lib/p2p/manualPeer'
import { createSessionIdentity } from '../src/lib/crypto/identity'
import type { SessionIdentity } from '../src/lib/crypto/identity'
import { generateEphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import type { EphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import {
  base64ToBytes,
  bytesToBase64,
  canonicalFingerprint,
  clearDmKeyCache,
  deriveDmKeyV2,
  encryptDm,
} from '../src/lib/crypto/dm'
import {
  DM_PROTOCOL_VERSION,
  MAX_ENVELOPE_AGE_MS,
  MAX_PLAINTEXT_LENGTH,
  createEnvelope,
  type Envelope,
} from '../src/lib/p2p/protocol'
import {
  connectPair,
  createFakePeerPair,
  dropPair,
  FakeRTCPeerConnection,
  installFakePeerConnectionFactory,
  installRecordingFactory,
  type FakePeerPair,
} from './fakeManualPeer'

/**
 * Phase 2 of issue #97 (spec §12.2): the trackerless manual DM engine. The
 * tests inject a fake RTCPeerConnection pair (fakeManualPeer — the mirror
 * of fakeTrystero) and drive the whole §12.2 surface: blob validation, both
 * state machines, the 5 s/15 s guards, and the JSON-framed dm/typing/receipt
 * wire over the connected pair. Web Crypto is real: the key-derivation
 * parity test pins that the manual path derives the SAME v2 key as the room
 * path (spec §9.2/§12.1).
 */

let sessionA: SessionIdentity
let sessionB: SessionIdentity
let sessionC: SessionIdentity
let ephA: EphemeralSession
let ephB: EphemeralSession

beforeEach(async () => {
  // Real timers by default (repo pattern: Web Crypto threadpool roundtrips
  // are not pumped by fake timers); the dispose test opts into fake ones.
  clearDmKeyCache()
  sessionA = await createSessionIdentity('zorro-a')
  sessionB = await createSessionIdentity('zorro-b')
  sessionC = await createSessionIdentity('tejón-c')
  ephA = await generateEphemeralSession()
  ephB = await generateEphemeralSession()
})

afterEach(() => {
  setPeerConnectionFactory(null)
  vi.useRealTimers()
})

/**
 * One event-loop turn via MessageChannel — a real macrotask that fake
 * timers (limited to setTimeout/setInterval) never intercept, so the same
 * pump works under `vi.useFakeTimers` and lets Web Crypto threadpool
 * completions land between turns.
 */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Lets the async decrypt/receipt tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return sleep(80)
}

function waitForReceiptDebounce(): Promise<void> {
  return sleep(300 + 120)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEngine(
  role: 'invite' | 'answer',
  options?: Partial<ConstructorParameters<typeof ManualPeerEngine>[0]>,
): ManualPeerEngine {
  return new ManualPeerEngine({
    role,
    session: role === 'invite' ? sessionA : sessionB,
    ephemeral: role === 'invite' ? ephA : ephB,
    ...options,
  })
}

/**
 * Runs A's createInvite with the manually-driven non-trickle gather: pump
 * event-loop turns until the engine is parked in its gather wait (bounded,
 * so a broken engine fails the test instead of hanging it), then complete
 * the harvest. The PC arrives through a getter: the factory creates it when
 * the engine starts, i.e. inside the helper call itself.
 */
async function pumpUntilParked(getPc: () => FakeRTCPeerConnection): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await tick()
    if (getPc().localDescription !== null) return
  }
  throw new Error('fake pc never reached setLocalDescription')
}

/** Same pump for A's createInvite (offer out). */
async function createInviteWithGather(
  engine: ManualPeerEngine,
  getPc: () => FakeRTCPeerConnection,
): Promise<string> {
  const inviting = engine.createInvite()
  await pumpUntilParked(getPc)
  getPc().completeGathering()
  return inviting
}

/** Same pump for B's acceptInvite (offer in; answer out after ITS gather). */
async function acceptInviteWithGather(
  engine: ManualPeerEngine,
  getPc: () => FakeRTCPeerConnection,
  inviteBlob: string,
): Promise<string> {
  const answering = engine.acceptInvite(inviteBlob)
  // acceptInvite hashes both keys of the blob (Web Crypto threadpool) before
  // the PC exists, so the number of turns varies — pump until parked.
  await pumpUntilParked(getPc)
  getPc().completeGathering()
  return answering
}

interface Handshake {
  a: ManualPeerEngine
  b: ManualPeerEngine
  pair: FakePeerPair
  inviteBlob: string
  answerBlob: string
}

/**
 * Full blob exchange over the fake pair (no connection yet): A lands on
 * `answer-pasted`, B on `answer-ready`; `connectPair` finishes the job.
 */
async function handshakePair(
  options?: Partial<ConstructorParameters<typeof ManualPeerEngine>[0]>,
): Promise<Handshake> {
  const pair = createFakePeerPair()
  installFakePeerConnectionFactory([pair.pcA, pair.pcB])
  const a = makeEngine('invite', options)
  const b = makeEngine('answer', options)
  const inviteBlob = await createInviteWithGather(a, () => pair.pcA)
  const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)
  await a.acceptAnswer(answerBlob)
  return { a, b, pair, inviteBlob, answerBlob }
}

async function connectedPair(
  options?: Partial<ConstructorParameters<typeof ManualPeerEngine>[0]>,
): Promise<Handshake> {
  const handshake = await handshakePair(options)
  connectPair(handshake.pair)
  return handshake
}

/**
 * Full handshake + connection with distinct per-role callbacks (e.g. when
 * both ends must be observed separately).
 */
async function connectWithCallbacks(
  callbacksA: ConstructorParameters<typeof ManualPeerEngine>[0]['callbacks'],
  callbacksB: ConstructorParameters<typeof ManualPeerEngine>[0]['callbacks'],
  options?: Partial<Omit<ConstructorParameters<typeof ManualPeerEngine>[0], 'callbacks'>>,
): Promise<Handshake> {
  const pair = createFakePeerPair()
  installFakePeerConnectionFactory([pair.pcA, pair.pcB])
  const a = new ManualPeerEngine({
    role: 'invite',
    session: sessionA,
    ephemeral: ephA,
    callbacks: callbacksA,
    ...options,
  })
  const b = new ManualPeerEngine({
    role: 'answer',
    session: sessionB,
    ephemeral: ephB,
    callbacks: callbacksB,
    ...options,
  })
  const inviteBlob = await createInviteWithGather(a, () => pair.pcA)
  const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)
  await a.acceptAnswer(answerBlob)
  connectPair(pair)
  return { a, b, pair, inviteBlob, answerBlob }
}

/** Builds blob fields for the pure encode/decode tests. */
function blobFields(role: 'invite' | 'answer') {
  return {
    nick: 'zorro-a',
    fingerprint: sessionA.identity.fingerprint,
    idKey: sessionA.rawPublicKey,
    ephKey: ephA.rawPublicKey,
    sdp: {
      type: role === 'invite' ? ('offer' as const) : ('answer' as const),
      sdp: 'v=0\r\ns=-\r\n',
    },
  }
}

/** Decodes a blob, mutates its raw JSON and re-encodes it. */
async function tamperBlob(
  blob: string,
  mutate: (raw: Record<string, unknown>) => void,
): Promise<string> {
  const raw = JSON.parse(new TextDecoder().decode(base64ToBytes(blob))) as Record<string, unknown>
  mutate(raw)
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(raw)))
}

/** Seals a dm envelope from A's side with the standalone §9.2 v2 key. */
async function sealStandaloneEnvelope(text: string, ts?: number): Promise<Envelope> {
  const key = await deriveDmKeyV2(
    ephA.keypair.privateKey,
    ephB.rawPublicKey,
    sessionA.identity.fingerprint,
    sessionB.identity.fingerprint,
    ephA.fingerprint,
    ephB.fingerprint,
  )
  const sealed = await encryptDm(key, text)
  const envelope = createEnvelope({
    from: canonicalFingerprint(sessionA.identity.fingerprint),
    nick: 'zorro-a',
    kind: 'dm',
    to: canonicalFingerprint(sessionB.identity.fingerprint),
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
    v: DM_PROTOCOL_VERSION,
  })
  if (ts !== undefined) envelope.ts = ts
  return envelope
}

// ---------------------------------------------------------------------------
// Blobs (§12.2 format + validation)
// ---------------------------------------------------------------------------

describe('blob encode/decode (§12.2)', () => {
  it('round-trips an invite blob: keys, recomputed fingerprints, offer SDP', async () => {
    const blob = createInviteBlob(blobFields('invite'))
    const parsed = await parseManualBlob(blob)

    expect(parsed.role).toBe('invite')
    expect(parsed.nick).toBe('zorro-a')
    expect(parsed.fingerprint).toBe(sessionA.identity.fingerprint)
    expect(parsed.idKey).toEqual(sessionA.rawPublicKey)
    expect(parsed.ephKey).toEqual(ephA.rawPublicKey)
    // The ephemeral fingerprint is recomputed from the raw key: the wire
    // carries no ephemeral fingerprint at all (§12.2).
    expect(parsed.ephFingerprint).toBe(ephA.fingerprint)
    expect(parsed.sdp).toEqual({ type: 'offer', sdp: 'v=0\r\ns=-\r\n' })
  })

  it('round-trips an answer blob as an answer/answer pair', async () => {
    const parsed = await parseManualBlob(createAnswerBlob(blobFields('answer')))
    expect(parsed.role).toBe('answer')
    expect(parsed.sdp.type).toBe('answer')
  })

  it('pins the blob version tag', () => {
    expect(MANUAL_BLOB_VERSION).toBe(1)
  })

  it('rejects an unknown version', async () => {
    const blob = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.v = 2
    })
    await expect(parseManualBlob(blob)).rejects.toMatchObject({
      name: 'ManualBlobError',
      reason: 'version',
    })
  })

  it('rejects a fingerprint that does not match SHA-256(idKey) (§12.2 tamper check)', async () => {
    const blob = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.fp = sessionB.identity.fingerprint // a valid fingerprint of ANOTHER key
    })
    await expect(parseManualBlob(blob)).rejects.toMatchObject({ reason: 'fingerprint' })

    const nonsense = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.fp = '0000 0000 0000 0000 0000 0000 0000 0000'
    })
    await expect(parseManualBlob(nonsense)).rejects.toBeInstanceOf(ManualBlobError)
  })

  it('rejects malformed base64 and non-JSON payloads', async () => {
    await expect(parseManualBlob('esto no es base64 !!!')).rejects.toMatchObject({
      reason: 'encoding',
    })
    await expect(parseManualBlob(btoa('null'))).rejects.toMatchObject({ reason: 'encoding' })
    await expect(parseManualBlob(btoa('[1,2]'))).rejects.toMatchObject({ reason: 'encoding' })
  })

  it('tolerates clipboard whitespace and line wraps in the base64 (§12.2)', async () => {
    const blob = createInviteBlob(blobFields('invite'))
    const wrapped = blob.replace(/(.{40})/g, '$1\n  ')
    const parsed = await parseManualBlob(wrapped)
    expect(parsed.fingerprint).toBe(sessionA.identity.fingerprint)
  })

  it('rejects missing or wrong-length keys (exactly 65 bytes, §9.1)', async () => {
    const missing = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      delete raw.ephKey
    })
    await expect(parseManualBlob(missing)).rejects.toMatchObject({ reason: 'keys' })

    const shortId = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.idKey = bytesToBase64(new Uint8Array(64))
    })
    await expect(parseManualBlob(shortId)).rejects.toMatchObject({ reason: 'keys' })

    const badBase64 = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.ephKey = '&&&no es base64&&&'
    })
    await expect(parseManualBlob(badBase64)).rejects.toMatchObject({ reason: 'keys' })
  })

  it('rejects role/SDP incoherence (invite⇔offer, answer⇔answer)', async () => {
    const swapped = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.sdp = { type: 'answer', sdp: 'v=0\r\ns=-\r\n' }
    })
    await expect(parseManualBlob(swapped)).rejects.toMatchObject({ reason: 'role' })

    const noSdp = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      delete raw.sdp
    })
    await expect(parseManualBlob(noSdp)).rejects.toMatchObject({ reason: 'role' })

    const unknownRole = await tamperBlob(createInviteBlob(blobFields('invite')), (raw) => {
      raw.role = 'renegotiate'
    })
    await expect(parseManualBlob(unknownRole)).rejects.toMatchObject({ reason: 'role' })
  })
})

// ---------------------------------------------------------------------------
// State machine — role A
// ---------------------------------------------------------------------------

describe('state machine — role A (idle → invite-ready → answer-pasted → connected)', () => {
  it('produces a gathered offer blob and lands on invite-ready (non-trickle ICE)', async () => {
    const created = installRecordingFactory()
    const a = makeEngine('invite')
    const blob = await createInviteWithGather(a, () => created[0]!)

    expect(a.currentState).toBe('invite-ready')
    // The emitted blob carries the GATHERED description (candidate inside).
    expect(created[0]?.localDescription?.sdp).toContain('a=candidate:fake')
    const parsed = await parseManualBlob(blob)
    expect(parsed.sdp.type).toBe('offer')
    expect(parsed.sdp.sdp).toContain('a=candidate:fake')
    expect(parsed.fingerprint).toBe(sessionA.identity.fingerprint)
    expect(created[0]?.rtcConfig).toBeUndefined() // no user ICE servers → browser defaults
  })

  it('rejects illegal transitions and keeps the state', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')

    // acceptAnswer in idle.
    await expect(a.acceptAnswer(createAnswerBlob(blobFields('answer')))).rejects.toMatchObject({
      code: 'illegal-transition',
    })
    expect(a.currentState).toBe('idle')

    const blob = await createInviteWithGather(a, () => pair.pcA)
    expect(a.currentState).toBe('invite-ready')

    // Second createInvite once the invite exists.
    await expect(a.createInvite()).rejects.toMatchObject({ code: 'illegal-transition' })
    expect(a.currentState).toBe('invite-ready')
    expect(blob.length).toBeGreaterThan(0)
  })

  it('a bad or foreign answer blob leaves invite-ready untouched (paste retry)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')
    const inviteBlob = await createInviteWithGather(a, () => pair.pcA)

    // Corrupted blob: the paste can be corrected and retried.
    await expect(a.acceptAnswer('@@nope@@')).rejects.toBeInstanceOf(ManualBlobError)
    expect(a.currentState).toBe('invite-ready')
    // An INVITE pasted where an ANSWER belongs: explicit error, no channel.
    await expect(a.acceptAnswer(inviteBlob)).rejects.toMatchObject({ code: 'bad-blob' })
    expect(a.currentState).toBe('invite-ready')
    // The PC was never touched by the rejected answers.
    expect(pair.pcA.remoteDescription).toBeNull()
  })

  it('rejects an answer whose fingerprint differs from the expected one (§12.2)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')
    await createInviteWithGather(a, () => pair.pcA)

    // A consistent answer blob of a DIFFERENT identity (crafted purely: no
    // PC needed for the reject path).
    const foreign = createAnswerBlob({
      nick: 'zorro-b',
      fingerprint: sessionB.identity.fingerprint,
      idKey: sessionB.rawPublicKey,
      ephKey: ephB.rawPublicKey,
      sdp: { type: 'answer', sdp: 'v=0\r\ns=-\r\n' },
    })
    await expect(
      a.acceptAnswer(foreign, { expectedPeerFingerprint: sessionC.identity.fingerprint }),
    ).rejects.toMatchObject({ code: 'fingerprint-mismatch' })
    expect(a.currentState).toBe('invite-ready')
    expect(pair.pcA.remoteDescription).toBeNull()

    // The same blob against its OWN expected fingerprint is accepted.
    await a.acceptAnswer(foreign, { expectedPeerFingerprint: sessionB.identity.fingerprint })
    expect(a.currentState).toBe('answer-pasted')
  })

  it('cancel from invite-ready closes the pc and detaches its handlers', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')
    await createInviteWithGather(a, () => pair.pcA)

    a.cancel()
    expect(a.currentState).toBe('closed')
    expect(pair.pcA.closed).toBe(true)
    expect(pair.pcA.oniceconnectionstatechange).toBeNull()
    expect(pair.pcA.onconnectionstatechange).toBeNull()
    expect(pair.pcA.localChannel?.onopen).toBeNull()
    expect(pair.pcA.localChannel?.onmessage).toBeNull()
  })

  it('cancel during the ICE gather wait aborts the handshake promise', async () => {
    installRecordingFactory()
    const a = makeEngine('invite')
    const inviting = a.createInvite()
    await tick()
    a.cancel()
    await expect(inviting).rejects.toMatchObject({ code: 'illegal-transition' })
    expect(a.currentState).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// State machine — role B
// ---------------------------------------------------------------------------

describe('state machine — role B (idle → invite-pasted → answer-ready → connected)', () => {
  it('walks invite-pasted → answer-ready and exposes the remote identity', async () => {
    const states: string[] = []
    const pair = createFakePeerPair()
    // Only B's engine runs here: it must receive pair.pcB from the factory.
    installFakePeerConnectionFactory([pair.pcB])
    const b = makeEngine('answer', {
      callbacks: { onStateChange: (state) => states.push(state) },
    })

    const answerBlob = await acceptInviteWithGather(
      b,
      () => pair.pcB,
      createInviteBlob(blobFields('invite')),
    )

    expect(states).toEqual(['invite-pasted', 'answer-ready'])
    const parsed = await parseManualBlob(answerBlob)
    expect(parsed.role).toBe('answer')
    expect(parsed.sdp.type).toBe('answer')
    expect(b.remoteFingerprint).toBe(sessionA.identity.fingerprint)
    expect(b.remoteNick).toBe('zorro-a')
  })

  it('rejects illegal transitions: double paste, answer-in-invite-slot, createInvite', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcB])
    const b = makeEngine('answer')
    const inviteBlob = createInviteBlob(blobFields('invite'))
    const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)
    expect(b.currentState).toBe('answer-ready')

    await expect(b.acceptInvite(inviteBlob)).rejects.toMatchObject({ code: 'illegal-transition' })
    // An ANSWER pasted into the invite slot, even from idle: never opens a
    // silent channel (§12.2).
    const other = makeEngine('answer')
    await expect(other.acceptInvite(answerBlob)).rejects.toMatchObject({ code: 'bad-blob' })
    expect(other.currentState).toBe('idle')
    await expect(other.createInvite()).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('a corrupted invite leaves idle untouched and no pc is created', async () => {
    const created = installRecordingFactory()
    const b = makeEngine('answer')
    await expect(b.acceptInvite('!!!')).rejects.toBeInstanceOf(ManualBlobError)
    expect(b.currentState).toBe('idle')
    expect(created).toHaveLength(0)
  })

  it('cancel from answer-ready closes the pc', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcB])
    const b = makeEngine('answer')
    await acceptInviteWithGather(b, () => pair.pcB, createInviteBlob(blobFields('invite')))

    b.cancel()
    expect(b.currentState).toBe('closed')
    expect(pair.pcB.closed).toBe(true)
    expect(pair.pcB.ondatachannel).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Guards (§12.2: 5 s ICE gathering, 15 s establishment)
// ---------------------------------------------------------------------------

describe('guards (§12.2 timeouts)', () => {
  it('pins the guard constants to the spec values', () => {
    expect(ICE_GATHER_GUARD_MS).toBe(5_000)
    expect(CONNECT_GUARD_MS).toBe(15_000)
  })

  it('ICE guard: emits the partial SDP when gathering never completes', async () => {
    installRecordingFactory()
    const a = makeEngine('invite', { iceGatherGuardMs: 30 })
    const inviting = a.createInvite()
    // No completeGathering() — the 5 s guard (shortened) must fire.
    const blob = await inviting
    const parsed = await parseManualBlob(blob)
    expect(parsed.sdp.type).toBe('offer')
    expect(parsed.sdp.sdp).not.toContain('a=candidate:fake')
    expect(a.currentState).toBe('invite-ready')
  })

  it('connect guard on role A: failed with a typed error, pc closed', async () => {
    const errors: ManualPeerError[] = []
    const handshake = await handshakePair({
      connectGuardMs: 40,
      callbacks: { onStateChange: (_state, error) => error && errors.push(error) },
    })
    // answer-pasted, channels never open…
    expect(handshake.a.currentState).toBe('answer-pasted')
    await flushCrypto()
    await sleep(120)

    expect(handshake.a.currentState).toBe('failed')
    expect(errors[0]?.code).toBe('connect-timeout')
    expect(errors[0]).toBeInstanceOf(ManualPeerError)
    expect(handshake.pair.pcA.closed).toBe(true)
  })

  it('connect guard on role B: arms on establishment, not on the human paste wait', async () => {
    const errorsB: ManualPeerError[] = []
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    // A carries a long guard (its machine wait legitimately armed at
    // acceptAnswer); only B's arm-on-establishment path is under test.
    const a = makeEngine('invite', { connectGuardMs: 60_000 })
    const b = makeEngine('answer', {
      connectGuardMs: 40,
      callbacks: { onStateChange: (_state, error) => error && errorsB.push(error) },
    })
    const inviteBlob = await createInviteWithGather(a, () => pair.pcA)
    const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)
    await a.acceptAnswer(answerBlob)

    // The human wait (A handing the blob over) carries NO clock timeout
    // (§12.2): well past the guard, B is still answer-ready.
    await sleep(120)
    expect(b.currentState).toBe('answer-ready')
    expect(errorsB).toHaveLength(0)

    // Establishment starts (ice leaves 'new' — A's candidates flowing):
    // NOW the 15 s guard arms, and firing it fails the engine.
    pair.pcB.iceConnectionState = 'checking'
    pair.pcB.oniceconnectionstatechange?.()
    await sleep(120)
    expect(b.currentState).toBe('failed')
    expect(errorsB[0]?.code).toBe('connect-timeout')
    expect(pair.pcB.closed).toBe(true)
  })

  it('cancel works from every waiting state of both roles', async () => {
    // A: idle.
    const aIdle = makeEngine('invite')
    aIdle.cancel()
    expect(aIdle.currentState).toBe('closed')

    // A: invite-ready.
    const pairA = createFakePeerPair()
    installFakePeerConnectionFactory([pairA.pcA])
    const a = makeEngine('invite')
    await createInviteWithGather(a, () => pairA.pcA)
    a.cancel()
    expect(a.currentState).toBe('closed')

    // B: idle and answer-ready.
    const bIdle = makeEngine('answer')
    bIdle.cancel()
    expect(bIdle.currentState).toBe('closed')

    const pairB = createFakePeerPair()
    installFakePeerConnectionFactory([pairB.pcB])
    const b = makeEngine('answer')
    await acceptInviteWithGather(b, () => pairB.pcB, createInviteBlob(blobFields('invite')))
    b.cancel()
    expect(b.currentState).toBe('closed')

    // A: answer-pasted (post-exchange, pre-connect).
    const pairC = createFakePeerPair()
    installFakePeerConnectionFactory([pairC.pcA, pairC.pcB])
    const a2 = makeEngine('invite')
    const b2 = makeEngine('answer')
    const inviteBlob = await createInviteWithGather(a2, () => pairC.pcA)
    const answerBlob = await acceptInviteWithGather(b2, () => pairC.pcB, inviteBlob)
    await a2.acceptAnswer(answerBlob)
    a2.cancel()
    expect(a2.currentState).toBe('closed')
  })

  it('a terminal state never clobbers: dispose during acceptAnswer keeps closed', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')
    const inviteBlob = await createInviteWithGather(a, () => pair.pcA)
    const b = makeEngine('answer')
    const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)

    // dispose() lands during the answer-parse gap: the in-flight
    // acceptAnswer aborts with a typed error and the session stays closed.
    const accepting = a.acceptAnswer(answerBlob)
    a.dispose()
    await expect(accepting).rejects.toMatchObject({ code: 'illegal-transition' })
    expect(a.currentState).toBe('closed')
  })
})

// ---------------------------------------------------------------------------
// End-to-end over the fake pair
// ---------------------------------------------------------------------------

describe('end-to-end over the fake pair (§12.2 wire)', () => {
  it('connects both ends and exposes the remote fingerprints', async () => {
    const handshake = await connectedPair()
    expect(handshake.a.currentState).toBe('connected')
    expect(handshake.b.currentState).toBe('connected')
    expect(handshake.a.remoteFingerprint).toBe(sessionB.identity.fingerprint)
    expect(handshake.b.remoteFingerprint).toBe(sessionA.identity.fingerprint)
    expect(handshake.a.remoteNick).toBe('zorro-b')
  })

  it('A sends a dm: B decrypts it, with v2 envelopes addressed by fingerprint', async () => {
    const received: Array<{ envelope: Envelope; text: string }> = []
    const handshake = await connectedPair({
      callbacks: { onDmMessage: (envelope, text) => received.push({ envelope, text }) },
    })

    const sent = await handshake.a.sendDm('hola manual')

    await flushCrypto()
    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe('hola manual')
    expect(received[0]?.envelope.v).toBe(DM_PROTOCOL_VERSION)
    expect(received[0]?.envelope.enc).toBe(true)
    expect(received[0]?.envelope.from).toBe(canonicalFingerprint(sessionA.identity.fingerprint))
    expect(received[0]?.envelope.to).toBe(canonicalFingerprint(sessionB.identity.fingerprint))
    expect(received[0]?.envelope.id).toBe(sent.id)

    // §12.2 framing on the wire: one JSON text frame per message.
    const frame = handshake.pair.pcA.localChannel?.lastFrame() as {
      action: string
      payload: Envelope
    }
    expect(frame.action).toBe('dm')
    expect(frame.payload.id).toBe(sent.id)
  })

  it('B replies, receipts flow both ways (debounced ✓✓)', async () => {
    const aReceipts: string[][] = []
    const bReceipts: string[][] = []
    const aReceived: string[] = []
    const bReceived: string[] = []
    const handshake = await connectWithCallbacks(
      {
        onReceipt: (ids) => aReceipts.push(ids),
        onDmMessage: (_envelope, text) => aReceived.push(text),
      },
      {
        onReceipt: (ids) => bReceipts.push(ids),
        onDmMessage: (_envelope, text) => bReceived.push(text),
      },
    )

    const dm = await handshake.a.sendDm('primera')
    await flushCrypto()
    await waitForReceiptDebounce()
    // B answered A's message with a debounced receipt (✓✓)…
    expect(bReceived).toEqual(['primera'])
    // …which landed on A (onReceipt fires on RECEIPTS RECEIVED).
    expect(aReceipts).toEqual([[dm.id]])
    expect(bReceipts).toEqual([])

    const reply = await handshake.b.sendDm('respuesta')
    await flushCrypto()
    await waitForReceiptDebounce()
    expect(aReceived).toEqual(['respuesta'])
    // A receipts B's reply; A's own receipt set is unchanged.
    expect(bReceipts).toEqual([[reply.id]])
    expect(aReceipts).toEqual([[dm.id]])
  })

  it('typing flows both ways with the room DM semantics ({on, dm: true})', async () => {
    const aTyping: boolean[] = []
    const bTyping: boolean[] = []
    const handshake = await connectWithCallbacks(
      { onTyping: (on) => aTyping.push(on) },
      { onTyping: (on) => bTyping.push(on) },
    )

    handshake.a.sendTyping(true)
    expect(bTyping).toEqual([true])
    const frame = handshake.pair.pcA.localChannel?.lastFrame() as {
      action: string
      payload: unknown
    }
    expect(frame.action).toBe('typing')
    expect(frame.payload).toEqual({ on: true, dm: true })

    handshake.b.sendTyping(false)
    expect(aTyping).toEqual([false])
  })

  it('drops a duplicate dm id (own BoundedSeenIds dedup, §7.3)', async () => {
    const received: string[] = []
    const handshake = await connectedPair({
      callbacks: { onDmMessage: (_envelope, text) => received.push(text) },
    })

    await handshake.a.sendDm('única')
    await flushCrypto()
    expect(received).toEqual(['única'])

    // Replay the EXACT same frame (same id, still fresh): dropped.
    const frame = handshake.pair.pcA.localChannel?.sent[0] as string
    handshake.pair.pcB.remoteChannel?.receive(frame)
    await flushCrypto()
    expect(received).toEqual(['única'])
  })

  it('drops a stale dm envelope (freshness window reuses MAX_ENVELOPE_AGE_MS)', async () => {
    const received: string[] = []
    const handshake = await connectedPair({
      callbacks: { onDmMessage: (_envelope, text) => received.push(text) },
    })

    const stale = await sealStandaloneEnvelope(
      'mensaje del pasado',
      Date.now() - MAX_ENVELOPE_AGE_MS - 1_000,
    )
    handshake.pair.pcB.remoteChannel?.receive(JSON.stringify({ action: 'dm', payload: stale }))
    await flushCrypto()
    expect(received).toEqual([])

    // A far-future stamp (beyond the skew tolerance) dies the same way.
    const future = await sealStandaloneEnvelope('mensaje del futuro', Date.now() + 10 * 60_000)
    handshake.pair.pcB.remoteChannel?.receive(JSON.stringify({ action: 'dm', payload: future }))
    await flushCrypto()
    expect(received).toEqual([])
  })

  it('nothing is ever sent before connected (DTLS + application E2EE)', async () => {
    const pair = createFakePeerPair()
    installFakePeerConnectionFactory([pair.pcA, pair.pcB])
    const a = makeEngine('invite')
    const b = makeEngine('answer')
    const inviteBlob = await createInviteWithGather(a, () => pair.pcA)
    const answerBlob = await acceptInviteWithGather(b, () => pair.pcB, inviteBlob)

    await expect(a.sendDm('demasiado pronto')).rejects.toMatchObject({ code: 'not-connected' })
    a.sendTyping(true) // best-effort: silently ignored while not connected
    expect(pair.pcA.localChannel?.sent).toEqual([])
    await expect(b.sendDm('yo tampoco')).rejects.toMatchObject({ code: 'not-connected' })
    expect(pair.pcB.remoteChannel?.sent).toEqual([])

    // After the exchange but before the channel opens, still nothing.
    await a.acceptAnswer(answerBlob)
    await expect(a.sendDm('aún no')).rejects.toMatchObject({ code: 'not-connected' })
    expect(pair.pcA.localChannel?.sent).toEqual([])
  })

  it('rejects over-limit text before any crypto or wire work', async () => {
    const handshake = await connectedPair()
    await expect(handshake.a.sendDm('x'.repeat(MAX_PLAINTEXT_LENGTH + 1))).rejects.toMatchObject({
      code: 'too-long',
    })
    expect(handshake.pair.pcA.localChannel?.sent).toEqual([])
  })

  it('key derivation parity: the manual channel derives the SAME v2 key as the room path', async () => {
    const received: string[] = []
    const handshake = await connectedPair({
      callbacks: { onDmMessage: (_envelope, text) => received.push(text) },
    })

    // The standalone §9.2 derivation (exactly what roomManager's sendDm
    // feeds: own ephemeral private key, peer's raw ephemeral key, all four
    // fingerprints) must produce a key B's engine holds too — proven by
    // cross-decryption, since the AES keys are non-extractable.
    const envelope = await sealStandaloneEnvelope('paridad §9.2')
    handshake.pair.pcB.remoteChannel?.receive(JSON.stringify({ action: 'dm', payload: envelope }))
    await flushCrypto()
    expect(received).toEqual(['paridad §9.2'])

    // And in the other direction: the engine's send opens under the
    // standalone derivation.
    const sent = await handshake.a.sendDm('paridad inversa')
    const keyB = await deriveDmKeyV2(
      ephB.keypair.privateKey,
      ephA.rawPublicKey,
      sessionB.identity.fingerprint,
      sessionA.identity.fingerprint,
      ephB.fingerprint,
      ephA.fingerprint,
    )
    const text = await import('../src/lib/crypto/dm').then((dm) =>
      dm.decryptDm(keyB, { iv: sent.iv ?? '', payload: sent.body }),
    )
    expect(text).toBe('paridad inversa')
  })

  it('passes user ICE servers to the factory; empty keeps browser defaults', async () => {
    const created = installRecordingFactory()

    const withIce = makeEngine('invite', { iceServers: [{ urls: 'stun:stun.example.com' }] })
    const inviting = withIce.createInvite()
    await pumpUntilParked(() => created[0]!)
    created[0]?.completeGathering()
    await inviting

    const session = await createSessionIdentity('otro')
    const ephemeral = await generateEphemeralSession()
    const withoutIce = new ManualPeerEngine({ role: 'invite', session, ephemeral })
    const inviting2 = withoutIce.createInvite()
    await pumpUntilParked(() => created[1]!)
    created[1]?.completeGathering()
    await inviting2

    // Non-empty user list replaces the defaults (room-path rule, RF-07);
    // an empty list never builds an rtcConfig at all.
    expect(created[0]?.rtcConfig).toEqual({ iceServers: [{ urls: 'stun:stun.example.com' }] })
    expect(created[1]?.rtcConfig).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Connection drop + dispose
// ---------------------------------------------------------------------------

describe('connection drop and dispose', () => {
  it('a drop after connected lands on «disconnected» with the fingerprint intact', async () => {
    const handshake = await connectedPair()
    dropPair(handshake.pair)
    expect(handshake.a.currentState).toBe('disconnected')
    expect(handshake.b.currentState).toBe('disconnected')
    expect(handshake.a.remoteFingerprint).toBe(sessionB.identity.fingerprint)
    await expect(handshake.a.sendDm('¿ahí?')).rejects.toMatchObject({ code: 'not-connected' })
  })

  it('dispose clears every timer (fake timers) and detaches every listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const handshake = await connectedPair()

    // One dm in flight: B's debounced receipt timer is the pending timer.
    void (await handshake.a.sendDm('hola'))
    await tick()
    await tick()
    await tick()
    expect(vi.getTimerCount()).toBe(1)

    handshake.a.dispose()
    handshake.b.dispose()
    expect(vi.getTimerCount()).toBe(0)

    // The terminal state sticks; the transports are closed and detached.
    expect(handshake.a.currentState).toBe('closed')
    expect(handshake.b.currentState).toBe('closed')
    for (const pc of [handshake.pair.pcA, handshake.pair.pcB]) {
      expect(pc.closed).toBe(true)
      expect(pc.oniceconnectionstatechange).toBeNull()
      expect(pc.onconnectionstatechange).toBeNull()
      expect(pc.ondatachannel).toBeNull()
    }
    for (const channel of [handshake.pair.pcA.localChannel, handshake.pair.pcB.remoteChannel]) {
      expect(channel?.onopen).toBeNull()
      expect(channel?.onclose).toBeNull()
      expect(channel?.onmessage).toBeNull()
    }

    // Idempotent.
    expect(() => {
      handshake.a.dispose()
      handshake.b.dispose()
    }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose mid-handshake (while the gather guard is armed) leaves no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const created = installRecordingFactory()
    const a = makeEngine('invite')
    // The pending gather wait rejects on dispose (cancel semantics) — the
    // rejection is the expected outcome, so it is swallowed here.
    void a.createInvite().catch(() => {})
    await pumpUntilParked(() => created[0]!)
    expect(vi.getTimerCount()).toBe(1) // the 5 s gather guard

    a.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(created[0]?.closed).toBe(true)
    expect(a.currentState).toBe('closed')
  })
})
