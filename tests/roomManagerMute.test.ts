// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { canonicalFingerprint, deriveDmKeyV2, encryptDm } from '../src/lib/crypto/dm'
import { computeFingerprint } from '../src/lib/crypto/identity'
import { deriveRoomKey, encryptRoomMessage } from '../src/lib/crypto/roomKey'
import { createEnvelope, DM_PROTOCOL_VERSION, type Envelope } from '../src/lib/p2p/protocol'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'

/**
 * Issue #95 (phase 2) — receive-path enforcement of the local mute list:
 * a muted peer's room chat never appends (nor mentions, nor queues a
 * receipt), its dms are ignored before any decrypt work, its typing flags
 * and join/leave system lines never surface — while receipts and ping/pong
 * keep processing so ✓✓ and the latency dots stay honest. A peer whose
 * fingerprint is not known yet is NOT muted (fail-open decision, #95), and
 * the mute list rehydrated from `gritos:settings` on boot enforces too.
 * jsdom environment: the rehydration test reads the real storage key.
 */

let fake: ReturnType<typeof installFakeTrystero>
let A: FakeRemotePeer
let C: FakeRemotePeer

beforeEach(async () => {
  fake = installFakeTrystero()
  A = await makeFakeRemotePeer('peer-a')
  C = await makeFakeRemotePeer('peer-c')
})

afterEach(() => {
  // resetManagerForTests also restores the default (empty) settings store.
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  localStorage.clear()
})

/** Lets the keys handler's async computeFingerprint tail settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

function waitForReceiptDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, manager.RECEIPT_DEBOUNCE_MS + 100))
}

async function join(
  name = 'lobby',
  password?: string,
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name, password)
  return { roomId: connection.roomId, room: fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom }
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

function chatEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: A.id,
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola',
    ...overrides,
  }
}

/** The manager's announced v2 material (identity + ephemeral keys), read
 * back from the fake room's send log — the B side of the DM derivation. */
async function myAnnouncedMaterial(room: FakeTrysteroRoom) {
  const keys = room.action('keys').sends
  const ephKeys = room.action('ephkeys').sends
  expect(keys.length).toBeGreaterThan(0)
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

/** Seals a v2 dm from A against the manager's announced material. */
async function sealDmFromA(
  text: string,
  mine: Awaited<ReturnType<typeof myAnnouncedMaterial>>,
): Promise<Envelope> {
  const key = await deriveDmKeyV2(
    A.ephKeypair.privateKey,
    mine.ephRawKey,
    A.fingerprint,
    mine.fingerprint,
    A.ephFingerprint,
    mine.ephFingerprint,
  )
  const sealed = await encryptDm(key, text)
  return createEnvelope({
    from: A.id,
    nick: 'zorro-bravo',
    kind: 'dm',
    to: manager.getSelfPeerId(),
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
    v: DM_PROTOCOL_VERSION,
  })
}

describe('room chat enforcement (issue #95)', () => {
  it('drops a muted peer chat before append, mention seam and receipt', async () => {
    const { roomId, room } = await join()
    // Muted in advance (the list persists across sessions): the peer joins
    // already muted — no join line either.
    expect(useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')).toBe(true)
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()

    const mention = vi.fn()
    const unsubscribe = manager.onMentionReceived(mention)
    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    room.receive('chat', chatEnvelope({ body: `hola @${ownNick}` }), A.id)

    // No store append, hence no mention notification either.
    expect(storedRoom(roomId).messages).toHaveLength(0)
    expect(mention).not.toHaveBeenCalled()
    // And the dropped envelope never queues a receipt back.
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
    unsubscribe()
  })

  it('keeps the unread badge at zero while muted', async () => {
    const { roomId, room } = await join()
    await fakePeerJoins(room, A)
    await flushMicrotasks()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')

    room.receive('chat', chatEnvelope(), A.id)
    expect(storedRoom(roomId).unread).toBe(0)

    // Positive control: an unmuted peer's message counts as before.
    await fakePeerJoins(room, C)
    await flushMicrotasks()
    room.receive('chat', chatEnvelope({ from: C.id, nick: 'luna' }), C.id)
    expect(storedRoom(roomId).unread).toBe(1)
  })

  it('drops the encrypted-room variant before the async decrypt append', async () => {
    const { roomId, room } = await join('secreta', 'clave-compartida')
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    await fakePeerJoins(room, A)
    await flushMicrotasks()

    const key = await deriveRoomKey('clave-compartida', 'secreta')
    const sealed = await encryptRoomMessage(key, 'en secreto')
    room.receive('chat', chatEnvelope({ enc: true, iv: sealed.iv, body: sealed.payload }), A.id)
    await flushMicrotasks()

    expect(storedRoom(roomId).messages).toHaveLength(0)
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('unmuting restores normal processing live, no reconnect needed', async () => {
    const { roomId, room } = await join()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()

    room.receive('chat', chatEnvelope({ body: 'silenciado' }), A.id)
    expect(storedRoom(roomId).messages).toHaveLength(0)

    expect(useSettingsStore.getState().unmuteFingerprint(A.fingerprint)).toBe(true)
    const mention = vi.fn()
    const unsubscribe = manager.onMentionReceived(mention)
    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    const envelope = chatEnvelope({ body: `hola @${ownNick}` })
    room.receive('chat', envelope, A.id)

    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: envelope.id, text: `hola @${ownNick}` })
    expect(mention).toHaveBeenCalledTimes(1)
    await waitForReceiptDebounce()
    expect(room.lastSend('receipt').data).toEqual({ ids: [envelope.id] })
    unsubscribe()
  })
})

describe('dm enforcement (issue #95)', () => {
  it('ignores a muted peer dm before any decrypt work; unmuting lets it through', async () => {
    const { room } = await join()
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    const mine = await myAnnouncedMaterial(room)

    const dmListener = vi.fn()
    const unsubscribeDm = manager.onDmReceived(dmListener)
    const envelope = await sealDmFromA('en secreto', mine)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    // No channel, no message, no notification, no debounced receipt.
    expect(useAppStore.getState().dms[A.id]).toBeUndefined()
    expect(dmListener).not.toHaveBeenCalled()
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)

    // The muted delivery never even burned its dedup id — the gate runs
    // before `shouldProcess` (and therefore before every decrypt step):
    // redelivering the SAME envelope after an unmute decrypts normally.
    expect(useSettingsStore.getState().unmuteFingerprint(A.fingerprint)).toBe(true)
    room.receive('dm', envelope, A.id)
    await flushMicrotasks()

    const channel = useAppStore.getState().dms[A.id]
    expect(channel?.messages).toHaveLength(1)
    expect(channel?.messages[0]).toMatchObject({ id: envelope.id, text: 'en secreto' })
    expect(dmListener).toHaveBeenCalledTimes(1)
    unsubscribeDm()
  })
})

describe('typing and system lines (issue #95)', () => {
  it('never sets typing state from a muted peer (room and dm flags)', async () => {
    const { roomId, room } = await join()
    await fakePeerJoins(room, A)
    await flushMicrotasks()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    expect(manager.openDmChannel(A.id)).toBe(true)

    room.receive('typing', { on: true }, A.id)
    room.receive('typing', { on: true, dm: true }, A.id)
    expect(storedRoom(roomId).typing).toEqual({})
    expect(useAppStore.getState().dms[A.id]?.typing[A.id]).toBeUndefined()

    // Unmuted, the flags land again.
    useSettingsStore.getState().unmuteFingerprint(A.fingerprint)
    room.receive('typing', { on: true }, A.id)
    expect(storedRoom(roomId).typing[A.id]).toBeDefined()
  })

  it('suppresses join/leave system lines for muted peers, deferred until unmuted', async () => {
    const { roomId, room } = await join()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()

    // The peer entry is still tracked (the peer list needs it), but no
    // join line ever surfaces…
    expect(storedRoom(roomId).peers.map((peer) => peer.id)).toEqual([A.id])
    expect(storedRoom(roomId).messages).toHaveLength(0)
    // …nor a leave line on the way out.
    room.peerLeave(A.id)
    expect(storedRoom(roomId).messages).toHaveLength(0)

    // A peer that is not muted is announced as always.
    await fakePeerJoins(room, C, { nick: 'luna-cauta' })
    await flushMicrotasks()
    expect(storedRoom(roomId).messages.map((message) => message.text)).toEqual([
      '— luna-cauta se ha unido —',
    ])

    // Unmuted, the deferred join announcement goes through on the next
    // presence frame.
    useSettingsStore.getState().unmuteFingerprint(A.fingerprint)
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()
    expect(storedRoom(roomId).messages.map((message) => message.text)).toEqual([
      '— luna-cauta se ha unido —',
      '— zorro-bravo se ha unido —',
    ])
  })
})

describe('reactions stay mute-gated (issue #98 through the issue #95 gate)', () => {
  it('delivers reactions while unmuted and drops a muted peer before the seam', async () => {
    const { roomId, room } = await join()
    await fakePeerJoins(room, A)
    await flushMicrotasks()
    const deliveries: unknown[] = []
    const unsubscribe = manager.onReact((rid, peerId, payload) => {
      deliveries.push({ roomId: rid, peerId, payload })
    })

    // Unmuted, a reaction flows through the seam (phase 1: no store effect
    // beyond the join line fakePeerJoins already produced).
    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, A.id)
    expect(deliveries).toEqual([
      { roomId, peerId: A.id, payload: { ids: ['m-1'], emo: '👍', on: true } },
    ])
    expect(storedRoom(roomId).messages.filter((message) => message.kind === 'user')).toHaveLength(0)

    // Muted, the gate drops it like the typing flags (cosmetic class).
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')
    room.receive('react', { ids: ['m-2'], emo: '🎉', on: true }, A.id)
    expect(deliveries).toHaveLength(1)
    unsubscribe()
  })
})

describe('receipts and ping/pong stay honest (issue #95)', () => {
  it('still processes receipt, ping and pong from a muted peer', async () => {
    const { roomId, room } = await join()
    await fakePeerJoins(room, A)
    await flushMicrotasks()
    useSettingsStore.getState().muteFingerprint(A.fingerprint, 'zorro-bravo')

    // Receipts flip own messages to ✓✓ regardless of the mute.
    const envelope = manager.sendChat(roomId, 'mía')
    expect(envelope).not.toBeNull()
    room.receive('receipt', { ids: [envelope?.id] }, A.id)
    expect(storedRoom(roomId).messages[0]?.status).toBe('delivered')

    // Pings are echoed (latency probes keep working both ways).
    room.receive('ping', { t: 1234 }, A.id)
    const pong = room.lastSend('pong')
    expect(pong.data).toEqual({ t: 1234 })
    expect(pong.options).toEqual({ target: A.id })

    const listener = vi.fn()
    const unsubscribe = manager.onPong(listener)
    room.receive('pong', { t: 555 }, A.id)
    expect(listener).toHaveBeenCalledWith(roomId, A.id, 555)
    unsubscribe()
  })
})

describe('fail-open on unknown fingerprints (issue #95 decision)', () => {
  it('processes a chat from a peer whose keys announce has not landed', async () => {
    const { roomId, room } = await join()
    // Peer join WITHOUT presence/keys: no fingerprint is known yet.
    room.peerJoin('peer-x')
    const envelope = chatEnvelope({ from: 'peer-x', nick: 'fantasma' })
    room.receive('chat', envelope, 'peer-x')

    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe(envelope.id)
  })
})

describe('rehydrated mute list (gritos:settings on boot)', () => {
  it('enforces a mute list loaded from persisted settings', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ mutedFingerprints: [canonicalFingerprint(A.fingerprint)] }),
    )
    await useSettingsStore.persist.rehydrate()
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([
      canonicalFingerprint(A.fingerprint),
    ])

    const { roomId, room } = await join()
    await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
    await flushMicrotasks()

    room.receive('chat', chatEnvelope(), A.id)
    expect(storedRoom(roomId).messages).toHaveLength(0)
    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })
})
