import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore, type DmChannel } from '../src/stores/useAppStore'
import {
  computeFingerprint,
  exportRawPublicKey,
  generateSessionKeypair,
} from '../src/lib/crypto/identity'
import { decryptDm, deriveDmKey, encryptDm, clearDmKeyCache } from '../src/lib/crypto/dm'
import { createEnvelope, MAX_CLOCK_SKEW_MS, MAX_ENVELOPE_AGE_MS, type Envelope } from '../src/lib/p2p/protocol'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * M3 — E2EE DM flow over the fake Trystero mesh. The manager under test
 * plays peer B; the tests play peer A (building real sealed envelopes with
 * an A-side keypair against B's announced raw key) and peer C (a third peer
 * that must never decrypt or store what is not addressed to it).
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  // Real timers: the E2EE receive path chains several Web Crypto threadpool
  // roundtrips (ECDH → HKDF → AES-GCM) that vitest fake timers do not pump;
  // the debounced receipt and the typing TTL below wait real milliseconds.
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
})

/** Lets the async decrypt/store tail (and its crypto) settle. The M4 suite
 * runs PBKDF2 workloads alongside, so the fixed sleep needs real headroom
 * over the ECDH → HKDF → AES-GCM threadpool roundtrips. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

function waitForReceiptDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, manager.RECEIPT_DEBOUNCE_MS + 100))
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

function dmChannel(peerId: string): DmChannel {
  const channel = useAppStore.getState().dms[peerId]
  if (channel === undefined) throw new Error(`dm channel ${peerId} not in store`)
  return channel
}

interface RemotePeer {
  keypair: CryptoKeyPair
  rawPublicKey: Uint8Array
  fingerprint: string
  id: string
}

async function makeRemotePeer(id: string): Promise<RemotePeer> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  return { keypair, rawPublicKey, fingerprint: await computeFingerprint(rawPublicKey), id }
}

let A: RemotePeer
let C: RemotePeer

beforeEach(async () => {
  clearDmKeyCache()
  A = await makeRemotePeer('peer-a')
  C = await makeRemotePeer('peer-c')
})

/** Joins the manager into a room and introduces remote peer A into it. */
async function joinWithPeerA(
  name = 'lobby',
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name)
  const room = fake.rooms[fake.rooms.length - 1]
  room.peerJoin(A.id)
  room.receive('presence', { nick: 'zorro-bravo', fp: A.fingerprint }, A.id)
  room.receive('keys', A.rawPublicKey, A.id)
  await flushMicrotasks()
  return { roomId: connection.roomId, room }
}

/** Seals a DM from A's side against B's announced raw public key. */
async function sealFromA(text: string, toPeerId: string, bRawPub: Uint8Array, bFp: string): Promise<Envelope> {
  const key = await deriveDmKey(A.keypair.privateKey, bRawPub, A.fingerprint, bFp)
  return sealFromAWithKey(key, text, toPeerId)
}

function sealFromAWithKey(key: CryptoKey, text: string, toPeerId: string): Promise<Envelope> {
  return encryptDm(key, text).then((sealed) =>
    createEnvelope({
      from: A.id,
      nick: 'zorro-bravo',
      kind: 'dm',
      to: toPeerId,
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
    }),
  )
}

async function myRawKeyAndFingerprint(room: FakeTrysteroRoom): Promise<{
  rawPublicKey: Uint8Array
  fingerprint: string
}> {
  await flushMicrotasks()
  const keys = room.action('keys').sends
  expect(keys.length).toBeGreaterThan(0)
  const rawPublicKey = keys[0]?.data as Uint8Array
  return { rawPublicKey, fingerprint: await computeFingerprint(rawPublicKey) }
}

describe('incoming DM (RF-04, §9.2)', () => {
  it('A sends to B: B decrypts, stores it on the channel and answers a directed receipt', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('hola en secreto', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    const channel = dmChannel(A.id)
    expect(channel.messages).toHaveLength(1)
    expect(channel.messages[0]).toMatchObject({
      id: envelope.id,
      roomId: `dm:${A.id}`,
      authorId: A.id,
      authorNick: 'zorro-bravo',
      text: 'hola en secreto',
      status: 'delivered',
      kind: 'user',
    })
    // The sender is in a shared room: the channel is available.
    expect(channel.available).toBe(true)
    expect(channel.peerNick).toBe('zorro-bravo')
    // The channel fingerprint is the keys-derived one.
    expect(channel.peerFingerprint).toBe(A.fingerprint)

    // Read receipt, debounced and directed to the sender (§7.1).
    expect(room.action('receipt').sends).toHaveLength(0)
    await waitForReceiptDebounce()
    const receipt = room.lastSend('receipt')
    expect(receipt.data).toEqual({ ids: [envelope.id] })
    expect(receipt.options).toEqual({ target: A.id })
  })

  it('fires the onDmReceived seam for the notifications layer', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    const listener = vi.fn()
    const unsubscribe = manager.onDmReceived(listener)

    const envelope = await sealFromA('psst', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(listener).toHaveBeenCalledWith(A.id, 'zorro-bravo', 'psst')
    unsubscribe()
    room.receive('dm', { ...envelope, id: crypto.randomUUID() }, A.id)
    await flushMicrotasks()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('a third peer (C) receiving the same envelope must not decrypt or store it', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    void mine // B's raw key is only needed implicitly: C's payload can never open.

    // C joins and announces its (different) keypair.
    room.peerJoin(C.id)
    room.receive('keys', C.rawPublicKey, C.id)
    await flushMicrotasks()

    // Addressed to us, but sealed for the A↔C pair — C's transport relays
    // it (or C forges it): the payload cannot open under our A↔B key.
    const keyAC = await deriveDmKey(A.keypair.privateKey, C.rawPublicKey, A.fingerprint, C.fingerprint)
    const sealed = await encryptDm(keyAC, 'secreto ajeno')
    const foreign = createEnvelope({
      from: A.id,
      nick: 'zorro-bravo',
      kind: 'dm',
      to: manager.getSelfPeerId(),
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
    })
    room.receive('dm', foreign, C.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    expect(useAppStore.getState().dms[C.id]).toBeUndefined()
    // And the manager never answered a receipt for it.
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  // Defense in depth (issue #18): sends are now directed at the recipient,
  // but peers running older builds may still broadcast — a `dm` addressed
  // to somebody else must still be discarded here (§7.3, never relayed).
  it('discards dms addressed to somebody else (never relayed, §7.3)', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('para otro', 'someone-else', mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })

  it('discards dms from peers whose public key is unknown', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const stranger = await makeRemotePeer('peer-x')
    const envelope = await sealFromX(stranger, '¿quién eres?', mine.rawPublicKey)
    room.receive('dm', envelope, stranger.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[stranger.id]).toBeUndefined()
  })

  it('ignores dm envelopes that are not encrypted (§7.2: dm is always enc)', async () => {
    const { room } = await joinWithPeerA()
    const envelope = createEnvelope({
      from: A.id,
      nick: 'zorro-bravo',
      kind: 'dm',
      to: manager.getSelfPeerId(),
      enc: false,
      body: 'en claro',
    })
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })
})

async function sealFromX(
  peer: RemotePeer,
  text: string,
  bRawPub: Uint8Array,
): Promise<Envelope> {
  const key = await deriveDmKey(peer.keypair.privateKey, bRawPub, peer.fingerprint, peer.fingerprint)
  const sealed = await encryptDm(key, text)
  return createEnvelope({
    from: peer.id,
    nick: 'desconocido',
    kind: 'dm',
    to: manager.getSelfPeerId(),
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
  })
}

describe('outgoing DM (RF-04, §9.2)', () => {
  it('sendDm sends the encrypted envelope directed at the recipient (issue #18) and echoes the own message', async () => {
    await manager.ensureSessionIdentity()
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    expect(manager.openDmChannel(A.id)).toBe(true)

    const envelope = await manager.sendDm(A.id, 'hola desde B')
    expect(envelope).not.toBeNull()
    const sent = room.lastSend('dm')
    expect(sent.data).toEqual(envelope)
    // Targeted delivery: the ciphertext reaches A only, never the rest of
    // the shared room's mesh (metadata leak, issue #18).
    expect(sent.options).toEqual({ target: A.id })
    const wire = envelope as Envelope
    expect(wire.kind).toBe('dm')
    expect(wire.to).toBe(A.id)
    expect(wire.enc).toBe(true)

    // Only the holder of A's private key can open it.
    const key = await deriveDmKey(A.keypair.privateKey, mine.rawPublicKey, A.fingerprint, mine.fingerprint)
    await expect(decryptDm(key, { iv: wire.iv as string, payload: wire.body })).resolves.toBe(
      'hola desde B',
    )

    const channel = dmChannel(A.id)
    expect(channel.messages).toHaveLength(1)
    expect(channel.messages[0]).toMatchObject({
      authorId: 'self',
      text: 'hola desde B',
      status: 'sent',
    })
  })

  it('flips own DM messages to delivered when the peer receipts them', async () => {
    await manager.ensureSessionIdentity()
    await joinWithPeerA()
    manager.openDmChannel(A.id)

    const envelope = await manager.sendDm(A.id, 'acuse')
    expect(envelope).not.toBeNull()

    fake.rooms[0]?.receive('receipt', { ids: [envelope?.id] }, A.id)
    expect(dmChannel(A.id).messages[0]?.status).toBe('delivered')
  })

  it('rejects text above the 4000-char limit at the send-API level', async () => {
    await manager.ensureSessionIdentity()
    await joinWithPeerA()
    manager.openDmChannel(A.id)
    const envelope = await manager.sendDm(A.id, 'a'.repeat(4001))
    expect(envelope).toBeNull()
    expect(dmChannel(A.id).messages).toHaveLength(0)
  })

  it('refuses to send when the peer shares no active room (RF-04 disconnected)', async () => {
    await manager.ensureSessionIdentity()
    await joinWithPeerA()
    manager.openDmChannel(A.id)
    expect(await manager.sendDm(A.id, 'hola')).not.toBeNull()

    // A leaves the last shared room → the channel goes unavailable and the
    // send is refused, while the history stays in memory.
    fake.rooms[0]?.peerLeave(A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).available).toBe(false)
    expect(dmChannel(A.id).messages.length).toBeGreaterThan(0)
    expect(await manager.sendDm(A.id, '¿sigues ahí?')).toBeNull()

    // Back into a shared room → available again.
    fake.rooms[0]?.peerJoin(A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).available).toBe(true)
  })

  it('returns null for unknown peers and without identity', async () => {
    await joinWithPeerA()
    // No channel opened for the stranger: refused.
    expect(await manager.sendDm('peer-desconocido', 'hola')).toBeNull()

    // No identity (fresh manager): refused too.
    manager.resetManagerForTests()
    fake = installFakeTrystero()
    expect(await manager.sendDm(A.id, 'sin identidad')).toBeNull()
  })

  it('openDmChannel refuses peers that share no room', async () => {
    await manager.ensureSessionIdentity()
    await joinWithPeerA()
    expect(manager.openDmChannel('peer-fantasma')).toBe(false)
    expect(useAppStore.getState().dms['peer-fantasma']).toBeUndefined()
    expect(manager.openDmChannel(A.id)).toBe(true)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: A.id })
  })
})

describe('DM unread (RF-04)', () => {
  it('increments unread for background DMs and clears it on open', async () => {
    await manager.ensureSessionIdentity()
    const { roomId, room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    // A room is the active view: the DM stays in the background.
    useAppStore.getState().setActiveView({ kind: 'room', id: roomId })

    const first = await sealFromA('uno', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', first, A.id)
    const second = await sealFromA('dos', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', second, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).unread).toBe(2)

    // Opening the DM clears the badge (RF-04).
    useAppStore.getState().setActiveView({ kind: 'dm', peerId: A.id })
    expect(dmChannel(A.id).unread).toBe(0)

    // Messages arriving while the DM is focused do not count.
    const third = await sealFromA('tres', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', third, A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).unread).toBe(0)
  })
})

describe('DM FIFO cap (RF-04: 500)', () => {
  it('keeps the last 500 messages, FIFO', async () => {
    await manager.ensureSessionIdentity()
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    useAppStore.getState().setActiveView({ kind: 'dm', peerId: A.id })

    // Derive the A↔B key once; only the AES sealing runs per message.
    const keyAB = await deriveDmKey(A.keypair.privateKey, mine.rawPublicKey, A.fingerprint, mine.fingerprint)
    for (let i = 0; i < 505; i += 1) {
      const envelope = await sealFromAWithKey(keyAB, `msg-${i}`, manager.getSelfPeerId())
      room.receive('dm', envelope, A.id)
    }
    await flushMicrotasks()

    const messages = dmChannel(A.id).messages
    expect(messages).toHaveLength(500)
    expect(messages[0]?.text).toBe('msg-5')
    expect(messages[499]?.text).toBe('msg-504')
  })
})

describe('DM typing (RF-04, §7.1)', () => {
  it('sends the dm-typing signal directed at the peer', async () => {
    await manager.ensureSessionIdentity()
    await joinWithPeerA()
    manager.sendDmTyping(A.id, true)
    const send = fake.rooms[0]?.lastSend('typing')
    expect(send?.data).toEqual({ on: true, dm: true })
    expect(send?.options).toEqual({ target: A.id })
    manager.sendDmTyping(A.id, false)
    expect(fake.rooms[0]?.lastSend('typing').data).toEqual({ on: false, dm: true })
  })

  it('routes dm-flagged typing to the channel and expires it after 4 s', async () => {
    await manager.ensureSessionIdentity()
    const { room } = await joinWithPeerA()
    manager.openDmChannel(A.id)

    room.receive('typing', { on: true, dm: true }, A.id)
    expect(dmChannel(A.id).typing[A.id]).toBeDefined()

    // Under the 4 s TTL the entry survives.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(dmChannel(A.id).typing[A.id]).toBeDefined()

    // Past the TTL the sweeper (1 s cadence) prunes it.
    await new Promise((resolve) => setTimeout(resolve, 4_200))
    expect(dmChannel(A.id).typing[A.id]).toBeUndefined()
  }, 10_000)

  it('keeps room typing unaffected by the dm flag and clears on peer leave', async () => {
    await manager.ensureSessionIdentity()
    const { roomId, room } = await joinWithPeerA()
    manager.openDmChannel(A.id)

    room.receive('typing', { on: true }, A.id)
    expect(storedRoom(roomId).typing[A.id]).toBeDefined()
    expect(dmChannel(A.id).typing[A.id]).toBeUndefined()

    room.receive('typing', { on: true, dm: true }, A.id)
    expect(dmChannel(A.id).typing[A.id]).toBeDefined()
    room.peerLeave(A.id)
    expect(dmChannel(A.id).typing[A.id]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Issue #19 — replay protection on the DM receive path: a freshness window
// around the local clock plus a session-wide dedup set (shared across rooms
// and surviving connection churn). Real timers here: the envelopes are aged
// by rewriting `ts` — the ciphertext does not cover it, exactly as with a
// captured envelope an attacker replays.
// ---------------------------------------------------------------------------

describe('DM freshness and replay (issue #19)', () => {
  it('discards a DM older than 5 minutes with zero state change', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('capturada', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', { ...envelope, ts: Date.now() - MAX_ENVELOPE_AGE_MS - 1 }, A.id)
    await flushMicrotasks()

    // No channel, no message, no debounced receipt.
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('discards a DM dated beyond the 90 s future skew tolerance', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('del futuro', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', { ...envelope, ts: Date.now() + MAX_CLOCK_SKEW_MS + 1 }, A.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })

  it('keeps a DM just inside the 5-minute edge', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('al límite', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    room.receive('dm', { ...envelope, ts: Date.now() - MAX_ENVELOPE_AGE_MS }, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).messages).toHaveLength(1)
    expect(dmChannel(A.id).messages[0]?.text).toBe('al límite')
  })

  it('drops a still-fresh replay delivered through a fresh connection (session-wide dedup)', async () => {
    const first = await joinWithPeerA('lobby')
    const mine = await myRawKeyAndFingerprint(first.room)

    const envelope = await sealFromA('única', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    first.room.receive('dm', envelope, A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).messages).toHaveLength(1)

    // A brand-new connection (new room join): its per-connection dedup set
    // is empty, but the session-wide DM set still knows the id.
    await manager.joinRoom('dev')
    const secondRoom = fake.rooms[fake.rooms.length - 1]
    secondRoom.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).messages).toHaveLength(1)
  })

  it('discards an aged replay by the window; the aged copy burns no dedup id', async () => {
    const first = await joinWithPeerA('lobby')
    const mine = await myRawKeyAndFingerprint(first.room)

    const envelope = await sealFromA('vieja', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    // First-ever delivery of this id, already aged beyond the window — a
    // captured envelope replayed after a reload reset the dedup set.
    first.room.receive('dm', { ...envelope, ts: Date.now() - MAX_ENVELOPE_AGE_MS - 1 }, A.id)
    await flushMicrotasks()
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()

    // Freshness runs before dedup: the rejected stale copy must not block
    // the same id arriving inside the window.
    first.room.receive('dm', envelope, A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).messages).toHaveLength(1)
  })

  it('keeps dropping the replay after leaving and rejoining the room', async () => {
    const first = await joinWithPeerA('lobby')
    const mine = await myRawKeyAndFingerprint(first.room)

    const envelope = await sealFromA('insistente', manager.getSelfPeerId(), mine.rawPublicKey, mine.fingerprint)
    first.room.receive('dm', envelope, A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).messages).toHaveLength(1)

    await manager.leaveRoom(first.roomId)
    const rejoined = await manager.joinRoom('lobby')
    const room = fake.rooms[fake.rooms.length - 1]
    expect(rejoined.roomId).toBe(first.roomId)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).messages).toHaveLength(1)
  })
})
