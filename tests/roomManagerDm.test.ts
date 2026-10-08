import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore, type DmChannel } from '../src/stores/useAppStore'
import { computeFingerprint } from '../src/lib/crypto/identity'
import {
  bytesToBase64,
  clearDmKeyCache,
  decryptDm,
  deriveDmKeyV2,
  encryptDm,
} from '../src/lib/crypto/dm'
import {
  createEnvelope,
  DM_PROTOCOL_VERSION,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_AGE_MS,
  type Envelope,
} from '../src/lib/p2p/protocol'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'

/**
 * M3 — E2EE DM flow over the fake Trystero mesh. Since issue #93 (spec
 * §12.1, phase 4) the flow runs v2: keys derive from SESSION-EPHEMERAL
 * ECDH pairs (`ephkeys` announces) with both fingerprint pairs in the
 * salt, envelopes carry `v: DM_PROTOCOL_VERSION`, and a connected peer
 * without an ephemeral announce is an explicit legacy state. The manager
 * under test plays peer B; the tests play peer A (building real sealed
 * envelopes with an A-side ephemeral keypair against B's announced one)
 * and peer C (a third peer that must never decrypt or store what is not
 * addressed to it).
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

let A: FakeRemotePeer
let C: FakeRemotePeer

beforeEach(async () => {
  clearDmKeyCache()
  A = await makeFakeRemotePeer('peer-a')
  C = await makeFakeRemotePeer('peer-c')
})

/** Joins the manager into a room and introduces remote peer A into it as a
 * v2-capable peer (join + presence + `keys` + `ephkeys`). */
async function joinWithPeerA(
  name = 'lobby',
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name)
  const room = fake.rooms[fake.rooms.length - 1]
  await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
  await flushMicrotasks()
  return { roomId: connection.roomId, room }
}

/** The manager's announced material as the tests' B side: identity pair
 * (`keys`) plus session-ephemeral pair (`ephkeys`), key + fingerprint. */
async function myRawKeyAndFingerprint(room: FakeTrysteroRoom): Promise<{
  rawPublicKey: Uint8Array
  fingerprint: string
  ephRawKey: Uint8Array
  ephFingerprint: string
}> {
  await flushMicrotasks()
  const keys = room.action('keys').sends
  expect(keys.length).toBeGreaterThan(0)
  const ephKeys = room.action('ephkeys').sends
  expect(ephKeys.length).toBeGreaterThan(0)
  const rawPublicKey = keys[0]?.data as Uint8Array
  const ephRawKey = ephKeys[0]?.data as Uint8Array
  expect(ephRawKey.byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)
  return {
    rawPublicKey,
    fingerprint: await computeFingerprint(rawPublicKey),
    ephRawKey,
    ephFingerprint: await computeFingerprint(ephRawKey),
  }
}

/** Seals a DM from A's side against B's announced material — the v2
 * derivation over the session-ephemeral pairs (spec §12.1). */
async function sealFromA(
  text: string,
  toPeerId: string,
  mine: Awaited<ReturnType<typeof myRawKeyAndFingerprint>>,
): Promise<Envelope> {
  const key = await deriveDmKeyV2(
    A.ephKeypair.privateKey,
    mine.ephRawKey,
    A.fingerprint,
    mine.fingerprint,
    A.ephFingerprint,
    mine.ephFingerprint,
  )
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
      v: DM_PROTOCOL_VERSION,
    }),
  )
}

/**
 * Issue #21 — seals `text` with `key` via raw crypto.subtle, BYPASSING
 * encryptDm's send-side 4000-char cap (which only binds honest clients):
 * what a key-holding malicious peer can produce.
 */
async function sealFromAWithKeyRaw(
  key: CryptoKey,
  text: string,
  toPeerId: string,
): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(text) as BufferSource,
    ),
  )
  const combined = new Uint8Array(iv.length + ciphertext.length)
  combined.set(iv)
  combined.set(ciphertext, iv.length)
  return createEnvelope({
    from: A.id,
    nick: 'zorro-bravo',
    kind: 'dm',
    to: toPeerId,
    enc: true,
    iv: bytesToBase64(iv),
    body: bytesToBase64(combined),
    v: DM_PROTOCOL_VERSION,
  })
}

/** Seals a DM from an arbitrary peer's side against B's announced material. */
async function sealFromX(
  peer: FakeRemotePeer,
  text: string,
  mine: Awaited<ReturnType<typeof myRawKeyAndFingerprint>>,
): Promise<Envelope> {
  const key = await deriveDmKeyV2(
    peer.ephKeypair.privateKey,
    mine.ephRawKey,
    peer.fingerprint,
    mine.fingerprint,
    peer.ephFingerprint,
    mine.ephFingerprint,
  )
  const sealed = await encryptDm(key, text)
  return createEnvelope({
    from: peer.id,
    nick: 'desconocido',
    kind: 'dm',
    to: manager.getSelfPeerId(),
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
    v: DM_PROTOCOL_VERSION,
  })
}

describe('incoming DM (RF-04, §9.2, §12.1 v2)', () => {
  it('A sends to B: B decrypts, stores it on the channel and answers a directed receipt', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('hola en secreto', manager.getSelfPeerId(), mine)
    // Issue #93 — the wire field the whole v2 path hangs off.
    expect(envelope.v).toBe(DM_PROTOCOL_VERSION)
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
    // A announced `ephkeys`: a v2-capable peer, never flagged legacy.
    expect(channel.legacyPeer).toBe(false)
    expect(channel.peerNick).toBe('zorro-bravo')
    // The channel fingerprint is the keys-derived (identity) one.
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

    const envelope = await sealFromA('psst', manager.getSelfPeerId(), mine)
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

    // C joins and announces its (different) identity AND ephemeral keys.
    await fakePeerJoins(room, C)
    await flushMicrotasks()

    // Addressed to us, but sealed for the A↔C pair — C's transport relays
    // it (or C forges it): the payload cannot open under our A↔B key.
    const keyAC = await deriveDmKeyV2(
      A.ephKeypair.privateKey,
      C.ephRawKey,
      A.fingerprint,
      C.fingerprint,
      A.ephFingerprint,
      C.ephFingerprint,
    )
    const sealed = await encryptDm(keyAC, 'secreto ajeno')
    const foreign = createEnvelope({
      from: A.id,
      nick: 'zorro-bravo',
      kind: 'dm',
      to: manager.getSelfPeerId(),
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
      v: DM_PROTOCOL_VERSION,
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

    const envelope = await sealFromA('para otro', 'someone-else', mine)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })

  it('discards dms from peers whose public key is unknown', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const stranger = await makeFakeRemotePeer('peer-x')
    const envelope = await sealFromX(stranger, '¿quién eres?', mine)
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
      v: DM_PROTOCOL_VERSION,
    })
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })

  // Issue #21 — the ciphertext cap still admits ~12 KB of ciphertext and the
  // send-side 4000-char cap only binds honest clients, so a key-holding peer
  // can seal an over-limit plaintext that opens validly. The receive path
  // discards it with zero side effects.
  it('discards a decrypted plaintext above the 4000-char limit (issue #21)', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    // 4001 chars seals to ~5.4 KB of base64: inside the ciphertext cap, so
    // only the post-decrypt limit can reject it.
    const keyAB = await deriveDmKeyV2(
      A.ephKeypair.privateKey,
      mine.ephRawKey,
      A.fingerprint,
      mine.fingerprint,
      A.ephFingerprint,
      mine.ephFingerprint,
    )
    const envelope = await sealFromAWithKeyRaw(keyAB, 'a'.repeat(4001), manager.getSelfPeerId())
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    // No channel, no message, no debounced receipt (§7.3 silence).
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })
})

describe('outgoing DM (RF-04, §9.2, §12.1 v2)', () => {
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
    // Issue #93 (spec §12.1) — the sender is flipped to v2 envelopes.
    expect(wire.v).toBe(DM_PROTOCOL_VERSION)
    expect(wire.kind).toBe('dm')
    expect(wire.to).toBe(A.id)
    expect(wire.enc).toBe(true)

    // Only the holder of A's ephemeral private key can open it: the v2
    // derivation mirrors the manager's (ephemeral pairs, identity fps in
    // the salt).
    const key = await deriveDmKeyV2(
      A.ephKeypair.privateKey,
      mine.ephRawKey,
      A.fingerprint,
      mine.fingerprint,
      A.ephFingerprint,
      mine.ephFingerprint,
    )
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

    // Back into a shared room, announcing identity AND ephemeral keys →
    // available again.
    await fakePeerJoins(fake.rooms[0] as FakeTrysteroRoom, A)
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

// ---------------------------------------------------------------------------
// Issue #93 (spec §12.1) — mixed-version rules: a connected peer without an
// `ephkeys` announce is a legacy (v1) build and gets an explicit unavailable
// state; v1 dm envelopes are dropped at the parser; a v2 dm from a peer with
// no announced ephemeral key is undecryptable and dropped (§7.3 silence).
// ---------------------------------------------------------------------------

describe('legacy peers and version gates (issue #93, spec §12.1)', () => {
  it('a legacy peer (keys but no ephkeys): sendDm refuses, legacyPeer flags true, a late announce unlocks the channel', async () => {
    await manager.ensureSessionIdentity()
    await manager.joinRoom('lobby')
    const room = fake.rooms[fake.rooms.length - 1]
    // A announces its identity keys but never `ephkeys`: a v1 build.
    await fakePeerJoins(room, A, { nick: 'zorro-bravo', announceEphemeral: false })
    await flushMicrotasks()
    manager.openDmChannel(A.id)

    // Sending is refused — never put on the wire — and the channel flags
    // the honest legacy state instead of losing the message silently.
    expect(await manager.sendDm(A.id, 'hola')).toBeNull()
    expect(dmChannel(A.id).available).toBe(true)
    expect(dmChannel(A.id).legacyPeer).toBe(true)
    expect(room.action('dm').sends).toHaveLength(0)

    // A announces `ephkeys` late → the flag flips false and the DM goes
    // through as a v2 envelope.
    room.receive('ephkeys', A.ephRawKey, A.id)
    await flushMicrotasks()
    expect(dmChannel(A.id).legacyPeer).toBe(false)

    const envelope = await manager.sendDm(A.id, 'hola ahora sí')
    expect(envelope).not.toBeNull()
    expect(envelope?.v).toBe(DM_PROTOCOL_VERSION)
    expect(room.lastSend('dm').options).toEqual({ target: A.id })
  })

  it('an incoming v1 dm envelope is silently dropped (dm is v2-only since phase 4)', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('legado', manager.getSelfPeerId(), mine)
    // The v1 copy is exactly what an old build would put on the wire.
    room.receive('dm', { ...envelope, v: 1 }, A.id)
    await flushMicrotasks()

    // No channel, no message, no debounced receipt (§7.3 silence).
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('an incoming v2 dm from a peer with no announced ephemeral key is silently dropped', async () => {
    await manager.joinRoom('lobby')
    const room = fake.rooms[fake.rooms.length - 1]
    // A never announces `ephkeys`, yet seals a structurally valid v2
    // envelope against B's (announced) ephemeral key — a forged or
    // forwarded v2 dm the manager cannot possibly open.
    await fakePeerJoins(room, A, { nick: 'zorro-bravo', announceEphemeral: false })
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('sin anuncio', manager.getSelfPeerId(), mine)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })
})

describe('DM unread (RF-04)', () => {
  it('increments unread for background DMs and clears it on open', async () => {
    await manager.ensureSessionIdentity()
    const { roomId, room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)
    // A room is the active view: the DM stays in the background.
    useAppStore.getState().setActiveView({ kind: 'room', id: roomId })

    const first = await sealFromA('uno', manager.getSelfPeerId(), mine)
    room.receive('dm', first, A.id)
    const second = await sealFromA('dos', manager.getSelfPeerId(), mine)
    room.receive('dm', second, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).unread).toBe(2)

    // Opening the DM clears the badge (RF-04).
    useAppStore.getState().setActiveView({ kind: 'dm', peerId: A.id })
    expect(dmChannel(A.id).unread).toBe(0)

    // Messages arriving while the DM is focused do not count.
    const third = await sealFromA('tres', manager.getSelfPeerId(), mine)
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

    // Derive the A↔B v2 key once; only the AES sealing runs per message.
    const keyAB = await deriveDmKeyV2(
      A.ephKeypair.privateKey,
      mine.ephRawKey,
      A.fingerprint,
      mine.fingerprint,
      A.ephFingerprint,
      mine.ephFingerprint,
    )
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

    const envelope = await sealFromA('capturada', manager.getSelfPeerId(), mine)
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

    const envelope = await sealFromA('del futuro', manager.getSelfPeerId(), mine)
    // Far beyond the tolerance, not +1ms: the gate runs after real async
    // crypto work, so a hair-thin margin flips whenever the run is slow
    // (the exact boundary is pinned by the protocol unit tests instead).
    room.receive('dm', { ...envelope, ts: Date.now() + MAX_CLOCK_SKEW_MS + 30_000 }, A.id)
    await flushMicrotasks()

    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
  })

  it('keeps a DM just inside the 5-minute edge', async () => {
    const { room } = await joinWithPeerA()
    const mine = await myRawKeyAndFingerprint(room)

    const envelope = await sealFromA('al límite', manager.getSelfPeerId(), mine)
    // 30s of slack inside the window, same real-timer reasoning as above.
    room.receive('dm', { ...envelope, ts: Date.now() - MAX_ENVELOPE_AGE_MS + 30_000 }, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).messages).toHaveLength(1)
    expect(dmChannel(A.id).messages[0]?.text).toBe('al límite')
  })

  it('drops a still-fresh replay delivered through a fresh connection (session-wide dedup)', async () => {
    const first = await joinWithPeerA('lobby')
    const mine = await myRawKeyAndFingerprint(first.room)

    const envelope = await sealFromA('única', manager.getSelfPeerId(), mine)
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

    const envelope = await sealFromA('vieja', manager.getSelfPeerId(), mine)
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

    const envelope = await sealFromA('insistente', manager.getSelfPeerId(), mine)
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
