import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { MESSAGE_CAP, useAppStore } from '../src/stores/useAppStore'
import { MIN_MESSAGE_TTL_S, SEEN_IDS_CAP, type Envelope } from '../src/lib/p2p/protocol'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #96 Phase 2 — TTL enforcement on the receive/send append paths:
 * receiver-clock `expiresAt`, the expiry sweep through the manager, the
 * no-resurrection guard and the receipts-stay rule.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.useRealTimers()
})

async function joinWithPeer(name = 'lobby') {
  const connection = await manager.joinRoom(name)
  const room = fake.rooms[fake.rooms.length - 1]
  room.peerJoin('peer-1')
  return { connection, room, roomId: connection.roomId }
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
    from: 'peer-1',
    nick: 'peer-nick',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola',
    ...overrides,
  }
}

describe('receiver-clock expiry on append (issue #96)', () => {
  it('sets expiresAt = receivedAt + ttl*1000 on a received message', async () => {
    const { room, roomId } = await joinWithPeer()
    const receivedAt = Date.now() // fake timers: frozen receiver clock
    const envelope = chatEnvelope({ ttl: 60, ts: receivedAt - 1_000 })

    room.receive('chat', envelope, 'peer-1')

    const message = storedRoom(roomId).messages[0]
    expect(message?.expiresAt).toBe(receivedAt + 60_000)
    // The author ts is kept for display order but never feeds expiry.
    expect(message?.ts).toBe(receivedAt - 1_000)
  })

  it('keeps ttl-less messages session-lived (no expiresAt field)', async () => {
    const { room, roomId } = await joinWithPeer()
    room.receive('chat', chatEnvelope({ body: 'sin ttl' }), 'peer-1')
    const message = storedRoom(roomId).messages[0]
    expect(message?.expiresAt).toBeUndefined()
    expect('expiresAt' in (message ?? {})).toBe(false)
  })

  it('expires the own echo of sendChat on the same receiver-clock rule', async () => {
    const { roomId } = await joinWithPeer()
    const sentAt = Date.now()

    const ttlEnvelope = manager.sendChat(roomId, 'autodestruye', 45)
    const noTtlEnvelope = manager.sendChat(roomId, 'normal')

    const messages = storedRoom(roomId).messages
    expect(messages.at(-2)?.id).toBe(ttlEnvelope?.id)
    expect(messages.at(-2)?.expiresAt).toBe(sentAt + 45_000)
    expect(messages.at(-1)?.id).toBe(noTtlEnvelope?.id)
    expect(messages.at(-1)?.expiresAt).toBeUndefined()
  })
})

describe('expiry sweep through the manager (issue #96)', () => {
  it('removes the expired message, accumulates the separator count and frees slots', async () => {
    const { room, roomId } = await joinWithPeer()
    room.receive('chat', chatEnvelope({ ttl: MIN_MESSAGE_TTL_S, body: 'fugaz' }), 'peer-1')
    room.receive('chat', chatEnvelope({ body: 'persistente' }), 'peer-1')

    expect(manager.pruneExpiredMessages(Date.now())).toEqual([]) // not due yet
    await vi.advanceTimersByTimeAsync(MIN_MESSAGE_TTL_S * 1_000)

    expect(manager.pruneExpiredMessages(Date.now())).toHaveLength(1)
    const stored = storedRoom(roomId)
    expect(stored.messages.map((message) => message.text)).toEqual(['persistente'])
    expect(stored.expiredCount).toBe(1)
  })

  it('never revokes delivered receipts: own ✓✓ survives every sweep', async () => {
    const { room, roomId } = await joinWithPeer()
    // Own message goes ✓✓ on the peer's receipt...
    const own = manager.sendChat(roomId, 'mío')
    room.receive('receipt', { ids: [own?.id ?? ''] }, 'peer-1')
    expect(storedRoom(roomId).messages[0]?.status).toBe('delivered')

    // ...a peer TTL message expires and is swept...
    room.receive('chat', chatEnvelope({ ttl: MIN_MESSAGE_TTL_S }), 'peer-1')
    await vi.advanceTimersByTimeAsync(MIN_MESSAGE_TTL_S * 1_000)
    manager.pruneExpiredMessages(Date.now())
    expect(storedRoom(roomId).messages).toHaveLength(1)

    // ...and the own ✓✓ is untouched, including receipts for swept ids.
    const removedId = 'already-swept'
    expect(() => room.receive('receipt', { ids: [removedId] }, 'peer-1')).not.toThrow()
    expect(storedRoom(roomId).messages[0]?.status).toBe('delivered')
  })
})

describe('no resurrection of expired messages (issue #96)', () => {
  it('drops a replay whose dedup entry was evicted by a flood', async () => {
    const { room, roomId } = await joinWithPeer()
    const doomed = chatEnvelope({ ttl: MIN_MESSAGE_TTL_S, body: 'fugaz' })
    room.receive('chat', doomed, 'peer-1')
    await vi.advanceTimersByTimeAsync(MIN_MESSAGE_TTL_S * 1_000)
    manager.pruneExpiredMessages(Date.now())
    expect(storedRoom(roomId).messages).toHaveLength(0)

    // Replay while dedup still holds the id: dropped as a duplicate.
    room.receive('chat', doomed, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(0)

    // Evict the id from the per-connection dedup window with fresh traffic.
    for (let i = 0; i < SEEN_IDS_CAP; i += 1) {
      room.receive('chat', chatEnvelope({ body: `flood-${i}` }), 'peer-1')
    }
    await vi.advanceTimersByTimeAsync(1_000) // flush the receipt flood
    expect(storedRoom(roomId).messages).toHaveLength(MESSAGE_CAP)

    // Dedup no longer knows the id — the expired-id guard must drop it.
    room.receive('chat', doomed, 'peer-1')
    const ids = storedRoom(roomId).messages.map((message) => message.id)
    expect(ids).not.toContain(doomed.id)
    expect(storedRoom(roomId).expiredCount).toBe(1)

    // The guard is id-scoped: fresh traffic still lands.
    room.receive('chat', chatEnvelope({ body: 'fresco' }), 'peer-1')
    expect(storedRoom(roomId).messages.at(-1)?.text).toBe('fresco')
  })
})
