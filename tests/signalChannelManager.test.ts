// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import {
  KnockError,
  acceptKnock,
  getPendingKnocks,
  getSignalPresence,
  isSignalChannelJoined,
  knockPeer,
  onKnock,
  rejectKnock,
  resetSignalChannelForTests,
  sendSignalDm,
  sendSignalDmTyping,
  setGlobalDmEnabled,
  signalDmTransport,
  type SignalKnock,
} from '../src/lib/p2p/signalChannel'
import { MAX_SIGNAL_PRESENCE, deriveSignalRoomId } from '../src/lib/p2p/signalChannelConstants'
import type { DmTransport } from '../src/lib/p2p/dmTransport'
import { deriveDmSessionKey } from '../src/lib/p2p/dmTransport'
import { createEnvelope, DM_PROTOCOL_VERSION, type Envelope } from '../src/lib/p2p/protocol'
import {
  clearDmKeyCache,
  canonicalFingerprint,
  decryptDm,
  deriveDmKeyV2,
  encryptDm,
} from '../src/lib/crypto/dm'
import { IDENTITY_STORAGE_KEY, computeFingerprint } from '../src/lib/crypto/identity'
import { INITIAL_APP_STATE, useAppStore } from '../src/stores/useAppStore'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../src/stores/useSettingsStore'
import { ROOMS_STORAGE_KEY } from '../src/lib/recentRooms'
import { UI_STORAGE_KEY } from '../src/stores/useUiStore'
import { TOFU_STORAGE_KEY, loadTofuPins } from '../src/lib/tofu'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'
import { panicWipe } from '../src/lib/panic'

/**
 * Issue #105 phase 2 (spec §12.5) — the signal-channel manager: toggle
 * lifecycle (off → NO join attempt, on → join + announce, off → teardown),
 * the presence LRU, the knock flow (typed errors, rate cap, mute gate,
 * accept/reject), the E2EE dm round-trip over the swarm (real crypto through
 * the shared v2 derivation), the room/signal DmTransport parity, TOFU
 * pinning (identity fps only) and the settings integration (persistence,
 * panic, five-key invariant).
 */

let fake: ReturnType<typeof installFakeTrystero>
let SIGNAL_ID: string

beforeEach(async () => {
  localStorage.clear()
  clearDmKeyCache()
  SIGNAL_ID = await deriveSignalRoomId()
  fake = installFakeTrystero()
})

afterEach(() => {
  resetSignalChannelForTests()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  useAppStore.setState({ ...INITIAL_APP_STATE })
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The canonical (compact) form of a raw fingerprint: the signal channel's
 * key space is canonical everywhere (whoami/knock fps are canonicalized by
 * the payload validators; the keys-derived fps are canonicalized by the
 * manager), while `makeFakeRemotePeer` carries the spaced display form.
 */
function canon(fp: string): string {
  return canonicalFingerprint(fp)
}

/** Lets the async fingerprint/decrypt tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return sleep(120)
}

/** Polls `cond` with real sleeps (Web Crypto completions must land). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return
    await sleep(10)
  }
  throw new Error(`timeout: ${what}`)
}

/** The fake room instance of the signal swarm (the last one joined). */
function signalRoom(): FakeTrysteroRoom {
  for (let i = fake.configs.length - 1; i >= 0; i -= 1) {
    if (fake.configs[i]?.roomId === SIGNAL_ID) return fake.rooms[i] as FakeTrysteroRoom
  }
  throw new Error('signal swarm never joined')
}

/** The canonical fingerprint of the manager's (test's) own session identity. */
function ownFingerprint(): string {
  const identity = manager.getSessionIdentity()
  if (identity === null) throw new Error('no session identity')
  return canonicalFingerprint(identity.identity.fingerprint)
}

/**
 * Enables the setting (the subscription does the join) and returns the fake
 * signal room once the swarm is installed.
 */
async function enableSwarm(): Promise<FakeTrysteroRoom> {
  setGlobalDmEnabled(true)
  await until(() => isSignalChannelJoined(), 'signal swarm never joined')
  await flushCrypto()
  return signalRoom()
}

/**
 * Introduces a v2-capable remote peer into the signal swarm exactly like a
 * real build: peer join (the manager answers with its directed whoami/
 * keys/ephkeys burst) + the peer's own whoami/keys/ephkeys announces.
 */
async function signalPeerJoins(
  room: FakeTrysteroRoom,
  peer: FakeRemotePeer,
  nick = 'zorro-b',
): Promise<void> {
  room.peerJoin(peer.id)
  room.receive('whoami', { nick, fp: peer.fingerprint }, peer.id)
  room.receive('keys', peer.rawPublicKey, peer.id)
  room.receive('ephkeys', peer.ephRawKey, peer.id)
  await flushCrypto()
}

/** The manager's announced ephemeral material as the tests' B side sees it. */
async function ownEphemeral(room: FakeTrysteroRoom): Promise<{
  rawKey: Uint8Array
  fingerprint: string
}> {
  const sends = room.action('ephkeys').sends
  expect(sends.length).toBeGreaterThan(0)
  const rawKey = sends[0]?.data as Uint8Array
  return { rawKey, fingerprint: await computeFingerprint(rawKey) }
}

/** Derives the shared v2 key from B's side against the manager's material. */
async function keyFromBSide(
  peer: FakeRemotePeer,
  mine: { rawKey: Uint8Array; fingerprint: string },
): Promise<CryptoKey> {
  return deriveDmKeyV2(
    peer.ephKeypair.privateKey,
    mine.rawKey,
    peer.fingerprint,
    ownFingerprint(),
    peer.ephFingerprint,
    mine.fingerprint,
  )
}

/** Seals a dm envelope from B's side with the shared v2 key. */
async function sealFromB(key: CryptoKey, text: string): Promise<Envelope> {
  const sealed = await encryptDm(key, text)
  return createEnvelope({
    from: 'peer-b',
    nick: 'zorro-b',
    kind: 'dm',
    to: manager.getSelfPeerId(),
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
    v: DM_PROTOCOL_VERSION,
  })
}

// ---------------------------------------------------------------------------
// Toggle lifecycle (the issue's acceptance criterion)
// ---------------------------------------------------------------------------

describe('toggle lifecycle (spec §12.5)', () => {
  it('default off: no joinRoom call ever happens for the signal room id', async () => {
    expect(useSettingsStore.getState().settings.globalDm).toBe(false)
    expect(isSignalChannelJoined()).toBe(false)
    await flushCrypto()
    expect(fake.configs.find((entry) => entry.roomId === SIGNAL_ID)).toBeUndefined()
    // Nothing to knock through: the typed error, not a silent send.
    expect(() => knockPeer('A31F09BC77D24E5A51C0FFEE12345678')).toThrow(KnockError)
    try {
      knockPeer('A31F09BC77D24E5A51C0FFEE12345678')
    } catch (error) {
      expect((error as KnockError).reason).toBe('signal-off')
    }
  })

  it('on: joins the signal swarm and announces whoami + keys + ephkeys on peer join', async () => {
    const room = await enableSwarm()
    // The join went through the SAME injectable factory, for the derived
    // signal room id (assert the connection attempt the issue pins).
    expect(fake.configs.some((entry) => entry.roomId === SIGNAL_ID)).toBe(true)

    const peer = await makeFakeRemotePeer('peer-b')
    room.peerJoin(peer.id)
    await flushCrypto()

    const whoami = room.action('whoami').sends
    expect(whoami.length).toBeGreaterThan(0)
    expect(whoami[0]?.options).toEqual({ target: peer.id })
    expect(canon((whoami[0]?.data as { nick: string; fp: string }).fp)).toBe(ownFingerprint())

    const keys = room.action('keys').sends
    expect(keys[0]?.options).toEqual({ target: peer.id })
    expect((keys[0]?.data as Uint8Array).byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)

    const ephkeys = room.action('ephkeys').sends
    expect(ephkeys[0]?.options).toEqual({ target: peer.id })
    expect((ephkeys[0]?.data as Uint8Array).byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)
  })

  it('off again: leaves the swarm, tears every map down and disconnects signal channels', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    // An inbound knock accepted → channel open.
    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )
    acceptKnock(peer.fingerprint)
    const key = canon(peer.fingerprint)
    expect(useAppStore.getState().dms[key]?.available).toBe(true)

    setGlobalDmEnabled(false)
    await until(() => !isSignalChannelJoined(), 'swarm never left')

    // The swarm left (fake room.leave called) and no signal state remains.
    expect(room.leave).toHaveBeenCalled()
    expect(signalDmTransport(key)).toBeNull()
    expect(() => knockPeer(key)).toThrow(KnockError)
    expect(getSignalPresence()).toEqual([])
    expect(getPendingKnocks()).toEqual([])
    // The affected channel passes to «El par se ha desconectado» (RF-04):
    // unavailable, history in memory, still listed.
    const channel = useAppStore.getState().dms[key]
    expect(channel?.available).toBe(false)
    expect(channel?.global).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Presence LRU
// ---------------------------------------------------------------------------

describe('presence LRU (MAX_SIGNAL_PRESENCE)', () => {
  it('whoami updates the list; re-announces refresh the nick', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    room.receive('whoami', { nick: 'zorro-b', fp: peer.fingerprint }, peer.id)
    expect(getSignalPresence()).toEqual([{ fp: canon(peer.fingerprint), nick: 'zorro-b' }])
    // A nickname change re-announces and updates the same entry.
    room.receive('whoami', { nick: 'zorro-nuevo', fp: peer.fingerprint }, peer.id)
    expect(getSignalPresence()).toEqual([{ fp: canon(peer.fingerprint), nick: 'zorro-nuevo' }])
  })

  it('the 101st entry evicts the least-recently-seen one', async () => {
    const room = await enableSwarm()
    const fpAt = (index: number): string =>
      `A31F09BC77D24E5A51C0FFEE${index.toString(16).padStart(8, '0').toUpperCase()}`
    for (let i = 0; i < MAX_SIGNAL_PRESENCE + 1; i += 1) {
      room.receive('whoami', { nick: `par-${i}`, fp: fpAt(i) }, `peer-${i}`)
    }
    const presence = getSignalPresence()
    expect(presence).toHaveLength(MAX_SIGNAL_PRESENCE)
    // The oldest (index 0) is gone; the newest survived.
    expect(presence.find((entry) => entry.fp === fpAt(0))).toBeUndefined()
    expect(presence.find((entry) => entry.fp === fpAt(MAX_SIGNAL_PRESENCE))).toBeDefined()
  })

  it('a peer leave evicts its presence entry', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    room.receive('whoami', { nick: 'zorro-b', fp: peer.fingerprint }, peer.id)
    expect(getSignalPresence()).toHaveLength(1)
    room.peerLeave(peer.id)
    expect(getSignalPresence()).toEqual([])
  })

  it('malformed whoami payloads never create entries (parseWhoami gate)', async () => {
    const room = await enableSwarm()
    room.receive('whoami', { nick: '', fp: 'A31F09BC77D24E5A51C0FFEE12345678' }, 'peer-x')
    room.receive('whoami', { nick: 'x', fp: 'nope' }, 'peer-y')
    room.receive('whoami', 'whoami', 'peer-z')
    expect(getSignalPresence()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Knocking out
// ---------------------------------------------------------------------------

describe('knockPeer (knocking out)', () => {
  it('sends a directed knock to a present fingerprint', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)

    knockPeer(peer.fingerprint, 'hola')

    const knock = room.action('knock').sends[0]
    expect(knock?.options).toEqual({ target: peer.id })
    expect(knock?.data).toEqual({
      type: 'knock',
      from: { fp: ownFingerprint(), nick: manager.getSessionIdentity()?.identity.nickname },
      note: 'hola',
    })
  })

  it('throws the typed error for a fingerprint that is not present', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    expect(() => knockPeer('A31F09BC77D24E5A51C0FFEE12345678')).toThrowError(KnockError)
    try {
      knockPeer('A31F09BC77D24E5A51C0FFEE12345678')
    } catch (error) {
      expect((error as KnockError).reason).toBe('peer-not-present')
    }
    expect(room.action('knock').sends).toHaveLength(0)
  })

  it('opens the channel when the accept ack comes back, keyed by the target fp', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)

    knockPeer(peer.fingerprint)
    // No channel before consent.
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()

    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    await flushCrypto()

    const channel = useAppStore.getState().dms[canon(peer.fingerprint)]
    expect(channel?.global).toBe(true)
    expect(channel?.available).toBe(true)
    expect(channel?.peerFingerprint).toBe(canon(peer.fingerprint))
    // The TOFU pin (identity fp only) was written on channel creation.
    expect(loadTofuPins()[canon(peer.fingerprint)]).toBe(canon(peer.fingerprint))
  })

  it('a rejection ack opens nothing and forgets the knock', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)

    knockPeer(peer.fingerprint)
    room.receive('knock-ack', { accept: false, fp: ownFingerprint() }, peer.id)
    await flushCrypto()

    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()
    expect(loadTofuPins()[canon(peer.fingerprint)]).toBeUndefined()
  })

  it('an ack matching no pending knock (or a foreign fp) is discarded', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)

    // No knock was sent: even a well-formed ack for us opens nothing.
    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    // An ack carrying ANOTHER fingerprint is not ours to match.
    knockPeer(peer.fingerprint)
    room.receive('knock-ack', { accept: true, fp: 'A31F09BC77D24E5A51C0FFEE12345678' }, peer.id)
    await flushCrypto()

    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Knocking in: mute gate, rate cap, consent
// ---------------------------------------------------------------------------

describe('inbound knocks (mute gate, rate cap, consent)', () => {
  it('rate-caps at KNOCK_RATE_CAP per peer per minute, silently', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    const knocks: SignalKnock[] = []
    onKnock((knock) => knocks.push(knock))

    for (let i = 0; i < 6; i += 1) {
      room.receive(
        'knock',
        { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' }, note: `n${i}` },
        peer.id,
      )
    }

    // Five surface on the seam; the 6th is discarded without effect (the
    // pending entry keeps the LATEST accepted knock).
    expect(knocks).toHaveLength(5)
    expect(knocks[4]?.note).toBe('n4')
    expect(getPendingKnocks()).toEqual([
      { fp: canon(peer.fingerprint), nick: 'zorro-b', note: 'n4' },
    ])
  })

  it('a muted peer’s knock is dropped before any effect (mute gate first)', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    expect(useSettingsStore.getState().muteFingerprint(peer.fingerprint, 'molesto')).toBe(true)
    const knocks: SignalKnock[] = []
    onKnock((knock) => knocks.push(knock))

    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )

    expect(knocks).toEqual([])
    expect(getPendingKnocks()).toEqual([])
  })

  it('a muted DECLARED fingerprint drops too (defense in depth)', async () => {
    const room = await enableSwarm()
    const foreign = 'A31F09BC77D24E5A51C0FFEE12345678'
    expect(useSettingsStore.getState().muteFingerprint(foreign, 'molesto')).toBe(true)
    const knocks: SignalKnock[] = []
    onKnock((knock) => knocks.push(knock))

    // Keys never landed for this transport peer: the declared-fp gate bites.
    room.receive('knock', { type: 'knock', from: { fp: foreign, nick: 'luna' } }, 'peer-x')
    expect(knocks).toEqual([])
  })

  it('accept: directed knock-ack(true) + signal-backed channel opened', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )

    acceptKnock(peer.fingerprint)

    const ack = room.action('knock-ack').sends[0]
    expect(ack?.options).toEqual({ target: peer.id })
    expect(ack?.data).toEqual({ accept: true, fp: canon(peer.fingerprint) })
    const channel = useAppStore.getState().dms[canon(peer.fingerprint)]
    expect(channel?.global).toBe(true)
    expect(channel?.available).toBe(true)
    expect(channel?.peerNick).toBe('zorro-b')
    expect(getPendingKnocks()).toEqual([])
  })

  it('reject: directed knock-ack(false), no channel, not remembered', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )

    rejectKnock(peer.fingerprint)

    const ack = room.action('knock-ack').sends[0]
    expect(ack?.data).toEqual({ accept: false, fp: canon(peer.fingerprint) })
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]).toBeUndefined()
    expect(getPendingKnocks()).toEqual([])
    expect(loadTofuPins()[canon(peer.fingerprint)]).toBeUndefined()
  })

  it('accept/reject are no-ops for an unknown fingerprint', async () => {
    await enableSwarm()
    acceptKnock('A31F09BC77D24E5A51C0FFEE12345678')
    rejectKnock('A31F09BC77D24E5A51C0FFEE12345678')
    expect(useAppStore.getState().dms).toEqual({})
  })

  it('a knock from the own fingerprint is ignored', async () => {
    const room = await enableSwarm()
    const knocks: SignalKnock[] = []
    onKnock((knock) => knocks.push(knock))
    room.receive(
      'knock',
      { type: 'knock', from: { fp: ownFingerprint(), nick: 'imitador' } },
      'peer-x',
    )
    expect(knocks).toEqual([])
  })

  it('a peer leave drops its pending inbound knock and the channel disconnects', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    room.receive(
      'knock',
      { type: 'knock', from: { fp: peer.fingerprint, nick: 'zorro-b' } },
      peer.id,
    )
    acceptKnock(peer.fingerprint)
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.available).toBe(true)

    room.peerLeave(peer.id)
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.available).toBe(false)
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.messages).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DM over the signal swarm (real crypto, both directions)
// ---------------------------------------------------------------------------

describe('DM over the signal swarm (E2EE v2 round trip)', () => {
  interface Connected {
    room: FakeTrysteroRoom
    peer: FakeRemotePeer
    key: CryptoKey
    myEph: { rawKey: Uint8Array; fingerprint: string }
  }

  /** Full happy path: enable → introduce B → knock out → accepted. */
  async function connectPair(): Promise<Connected> {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    knockPeer(peer.fingerprint)
    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    await flushCrypto()
    const myEph = await ownEphemeral(room)
    const key = await keyFromBSide(peer, myEph)
    return { room, peer, key, myEph }
  }

  it('sendSignalDm seals v2, delivers directed and echoes into the fp-keyed channel', async () => {
    const { room, peer, key } = await connectPair()

    expect(await sendSignalDm(peer.fingerprint, 'hola señal')).toBe(true)

    const own = useAppStore.getState().dms[canon(peer.fingerprint)]?.messages[0]
    expect(own?.text).toBe('hola señal')
    expect(own?.authorId).toBe('self')
    expect(own?.status).toBe('sent')

    // B opens the directed envelope with the SAME shared v2 key.
    const sent = room.action('dm').sends[0]
    expect(sent?.options).toEqual({ target: peer.id })
    const envelope = sent?.data as Envelope
    expect(envelope.kind).toBe('dm')
    expect(envelope.v).toBe(DM_PROTOCOL_VERSION)
    expect(envelope.to).toBe(peer.id)
    const opened = await decryptDm(key, { iv: envelope.iv ?? '', payload: envelope.body })
    expect(opened).toBe('hola señal')
  })

  it('a received dm lands on the channel and answers with the debounced receipt', async () => {
    const { room, peer, key } = await connectPair()

    const reply = await sealFromB(key, 'hola de vuelta')
    room.receive('dm', reply, peer.id)
    await flushCrypto()

    const messages = useAppStore.getState().dms[canon(peer.fingerprint)]?.messages ?? []
    const landed = messages.find((message) => message.text === 'hola de vuelta')
    expect(landed?.authorId).toBe(canon(peer.fingerprint))
    expect(landed?.authorNick).toBe('zorro-b')
    expect(landed?.status).toBe('delivered')
    // The channel focused nobody: an unfocused receive badges unread.
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.unread).toBe(1)

    // §7.1 — the debounced directed receipt goes back to B.
    await sleep(manager.RECEIPT_DEBOUNCE_MS + 100)
    const receipt = room.action('receipt').sends[0]
    expect(receipt?.options).toEqual({ target: peer.id })
    expect((receipt?.data as { ids: string[] }).ids).toContain(reply.id)
  }, 15_000)

  it('typing flows both ways and expires like the room path', async () => {
    const { room, peer } = await connectPair()

    sendSignalDmTyping(peer.fingerprint, true)
    const typing = room.action('typing').sends[0]
    expect(typing?.options).toEqual({ target: peer.id })
    expect(typing?.data).toEqual({ on: true, dm: true })

    room.receive('typing', { on: true, dm: true }, peer.id)
    expect(
      Object.keys(useAppStore.getState().dms[canon(peer.fingerprint)]?.typing ?? {}),
    ).toHaveLength(1)

    room.receive('typing', { on: false, dm: true }, peer.id)
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.typing).toEqual({})
  })

  it('an incoming receipt flips own messages to delivered (✓✓)', async () => {
    const { room, peer } = await connectPair()
    expect(await sendSignalDm(peer.fingerprint, 'confírmame')).toBe(true)
    const id = useAppStore.getState().dms[canon(peer.fingerprint)]?.messages[0]?.id as string

    room.receive('receipt', { ids: [id] }, peer.id)
    await flushCrypto()

    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.messages[0]?.status).toBe(
      'delivered',
    )
  })

  it('sends are refused for unknown fps or when the channel is gone', async () => {
    await enableSwarm()
    expect(await sendSignalDm('A31F09BC77D24E5A51C0FFEE12345678', 'x')).toBe(false)
  })

  it('TOFU pins stay identity-fp-only (never an ephemeral fingerprint)', async () => {
    const { room, peer, myEph } = await connectPair()
    expect(await sendSignalDm(peer.fingerprint, 'pin check')).toBe(true)
    room.receive('dm', await sealFromB(await keyFromBSide(peer, myEph), 'y'), peer.id)
    await flushCrypto()

    const pins = loadTofuPins()
    expect(Object.keys(pins)).toContain(canon(peer.fingerprint))
    const ephemeralFps = new Set([canon(peer.ephFingerprint), canon(myEph.fingerprint)])
    for (const [key, value] of Object.entries(pins)) {
      // Every pin key and value is a 32-hex identity fingerprint; nothing
      // ephemeral was ever written under `gritos:tofu` (spec §12.1 guard).
      expect(key).toMatch(/^[0-9A-F]{32}$/)
      expect(value).toMatch(/^[0-9A-F]{32}$/)
      expect(ephemeralFps.has(key)).toBe(false)
      expect(ephemeralFps.has(value)).toBe(false)
    }
  })

  it('refreshDmAvailability never clobbers a signal channel (room churn)', async () => {
    const { peer } = await connectPair()
    // Room churn (peer join/leave recomputes dms availability) must leave
    // signal-backed channels alone — they are keyed by fingerprint and
    // owned by the signal manager.
    const connection = await manager.joinRoom('lobby')
    const lobby = fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom
    lobby.peerJoin('peer-roomly')
    lobby.peerLeave('peer-roomly')
    await flushCrypto()
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.available).toBe(true)
    await manager.leaveRoom(connection.roomId)
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.available).toBe(true)
  })

  it('identity regeneration re-announces the FINAL new material to the swarm', async () => {
    const { room, peer } = await connectPair()
    const keysBefore = room.action('keys').sends.length
    const firstKey = room.action('keys').sends[0]?.data as Uint8Array

    await manager.regenerateSessionIdentity()
    await flushCrypto()

    // The rebroadcast seam fires after the fresh ephemeral keypair exists:
    // whoami + keys + ephkeys directed at every present peer, with NEW bytes.
    const whoamiSends = room.action('whoami').sends
    expect(canon((whoamiSends[whoamiSends.length - 1]?.data as { fp: string }).fp)).toBe(
      ownFingerprint(),
    )
    const keysSends = room.action('keys').sends
    expect(keysSends.length).toBeGreaterThan(keysBefore)
    const lastKey = keysSends[keysSends.length - 1]?.data as Uint8Array
    expect(lastKey).not.toEqual(firstKey)
    expect(lastKey.byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)
    const ephSends = room.action('ephkeys').sends
    expect(ephSends[ephSends.length - 1]?.options).toEqual({ target: peer.id })
    // The channel keeps working (keys re-announced, not invalidated).
    expect(useAppStore.getState().dms[canon(peer.fingerprint)]?.available).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DmTransport parity: room-backed vs signal-backed, same expectations
// ---------------------------------------------------------------------------

describe('DmTransport parity (room vs signal)', () => {
  interface TransportRow {
    readonly name: string
    readonly kind: 'room' | 'signal'
    readonly setup: () => Promise<{
      transport: DmTransport
      room: FakeTrysteroRoom
      peerId: string
      peer: FakeRemotePeer
      expire: () => Promise<void>
    }>
  }

  const rows: TransportRow[] = [
    {
      name: 'room-backed',
      kind: 'room',
      setup: async () => {
        const connection = await manager.joinRoom('lobby')
        const room = fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom
        const peer = await makeFakeRemotePeer('peer-a')
        await fakePeerJoins(room, peer, { nick: 'zorro-a' })
        // Lets the keys-derived fingerprint tail land (the transport reads it).
        await flushCrypto()
        expect(manager.openDmChannel(peer.id)).toBe(true)
        const transport = manager.roomDmTransport(peer.id)
        if (transport === null) throw new Error('no room transport')
        return {
          transport,
          room,
          peerId: peer.id,
          peer,
          expire: async () => {
            await manager.leaveRoom(connection.roomId)
          },
        }
      },
    },
    {
      name: 'signal-backed',
      kind: 'signal',
      setup: async () => {
        const room = await enableSwarm()
        const peer = await makeFakeRemotePeer('peer-b')
        await signalPeerJoins(room, peer)
        knockPeer(peer.fingerprint)
        room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
        await flushCrypto()
        const transport = signalDmTransport(peer.fingerprint)
        if (transport === null) throw new Error('no signal transport')
        return {
          transport,
          room,
          peerId: peer.id,
          peer,
          expire: async () => {
            setGlobalDmEnabled(false)
            await until(() => !isSignalChannelJoined(), 'swarm never left')
          },
        }
      },
    },
  ]

  for (const row of rows) {
    it(`exposes identical behavior [${row.name}]`, async () => {
      const { transport, room, peerId, peer, expire } = await row.setup()

      expect(transport.kind).toBe(row.kind)
      expect(transport.available()).toBe(true)
      // Keys-derived identity fingerprint — the TOFU anchor, never the
      // self-declared presence value.
      expect(transport.peerIdentityFingerprint()).toBe(canon(peer.fingerprint))
      const eph = transport.peerEphemeralKey()
      expect(eph?.rawKey.byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)
      expect(eph?.fingerprint).toBe(canon(peer.ephFingerprint))

      // §7.1 typing, directed and flagged dm.
      transport.sendTyping(true)
      expect(room.lastSend('typing')).toEqual({
        data: { on: true, dm: true },
        options: { target: peerId },
      })
      // §7.1 receipts, directed.
      transport.sendReceipts(['id-1', 'id-2'])
      expect(room.lastSend('receipt')).toEqual({
        data: { ids: ['id-1', 'id-2'] },
        options: { target: peerId },
      })
      // Sealed dm envelopes ride the transport, directed.
      const envelope = createEnvelope({
        from: 'someone-else',
        nick: 'n',
        kind: 'dm',
        to: peerId,
        enc: true,
        iv: 'aXY=',
        body: 'Ym9keQ==',
        v: DM_PROTOCOL_VERSION,
      })
      transport.sendDmEnvelope(envelope)
      expect(room.lastSend('dm').data).toEqual(envelope)
      expect(room.lastSend('dm').options?.target).toBe(peerId)

      // The shared v2 key resolution works through BOTH backings.
      const key = await deriveDmSessionKey(ownFingerprint(), transport)
      expect(key).not.toBeNull()

      // After the backing dies (room left / swarm left): unavailable.
      await expire()
      expect(transport.available()).toBe(false)
      expect(transport.peerIdentityFingerprint()).toBe(canon(peer.fingerprint))
    })
  }
})

// ---------------------------------------------------------------------------
// Settings integration: persistence, panic, five-key invariant
// ---------------------------------------------------------------------------

describe('Settings.globalDm integration (spec §8.2/§12.5)', () => {
  it('persists inside gritos:settings (no sixth key) and defaults back on reset', () => {
    expect(DEFAULT_SETTINGS.globalDm).toBe(false)
    setGlobalDmEnabled(true)
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as Record<
      string,
      unknown
    >
    expect(stored.globalDm).toBe(true)
    useSettingsStore.getState().resetSettings()
    expect(useSettingsStore.getState().settings.globalDm).toBe(false)
  })

  it('a full signal session stays within the five documented gritos:* keys', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    knockPeer(peer.fingerprint)
    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    expect(await sendSignalDm(peer.fingerprint, 'invariant check')).toBe(true)
    await flushCrypto()

    const documented = [
      SETTINGS_STORAGE_KEY,
      IDENTITY_STORAGE_KEY,
      ROOMS_STORAGE_KEY,
      UI_STORAGE_KEY,
      TOFU_STORAGE_KEY,
    ]
    const gritosKeys = Object.keys(localStorage).filter((key) => key.startsWith('gritos:'))
    for (const key of gritosKeys) {
      expect(documented).toContain(key)
    }
    // The signal session's only persisted traces: the settings record (the
    // opt-in flag) and the contact's TOFU pin. No message content anywhere.
    expect(gritosKeys).toContain(SETTINGS_STORAGE_KEY)
    expect(gritosKeys).toContain(TOFU_STORAGE_KEY)
    expect(localStorage.getItem(TOFU_STORAGE_KEY)).not.toContain('invariant check')
  })

  it('panicWipe leaves the swarm, its state and every gritos:* key behind', async () => {
    const room = await enableSwarm()
    const peer = await makeFakeRemotePeer('peer-b')
    await signalPeerJoins(room, peer)
    knockPeer(peer.fingerprint)
    room.receive('knock-ack', { accept: true, fp: ownFingerprint() }, peer.id)
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })

    panicWipe({ reload: false })

    // The swarm REALLY left (abortSignalChannel ran — the store reset alone
    // would not prove it) and the settings flag is back to off.
    expect(isSignalChannelJoined()).toBe(false)
    expect(room.leave).toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.globalDm).toBe(false)
    expect(useAppStore.getState().dms).toEqual({})
    expect(Object.keys(localStorage).filter((key) => key.startsWith('gritos:'))).toEqual([])
    expect(reload).not.toHaveBeenCalled()
  })
})
