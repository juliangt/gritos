import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import type { Envelope } from '../src/lib/p2p/protocol'
import { encryptRoomMessage, deriveRoomKey } from '../src/lib/crypto/roomKey'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * M5 (RF-09) — the roomManager mention seam: a RECEIVED room message that
 * mentions the own nickname (M2 matcher rules: case-insensitive, word
 * boundary) surfaces through onMentionReceived; non-mentions, own messages
 * and encrypted placeholders never do. The hidden/settings/permission gate
 * lives downstream in the notifications layer.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  // Real timers: the encrypted path chains PBKDF2 + AES-GCM roundtrips that
  // fake timers do not pump.
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
})

function chatEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: 1,
    id: crypto.randomUUID(),
    ts: Date.now(),
    from: 'peer-1',
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: false,
    iv: null,
    body: 'hola',
    ...overrides,
  }
}

async function join(name: string, password?: string) {
  const connection = await manager.joinRoom(name, password)
  return {
    connection,
    room: fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom,
    roomId: connection.roomId,
  }
}

describe('mention seam (RF-09)', () => {
  it('fires for a received message mentioning the own nickname, with room context', async () => {
    const { room, roomId } = await join('general')
    room.peerJoin('peer-1')
    const listener = vi.fn()
    const unsubscribe = manager.onMentionReceived(listener)

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    room.receive('chat', chatEnvelope({ body: `hola @${ownNick.toUpperCase()}` }), 'peer-1')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(roomId, 'general', 'zorro-bravo', `hola @${ownNick.toUpperCase()}`)
    unsubscribe()
  })

  it('does not fire for non-mentions or other nicknames', async () => {
    const { room } = await join('general')
    room.peerJoin('peer-1')
    const listener = vi.fn()
    const unsubscribe = manager.onMentionReceived(listener)

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    room.receive('chat', chatEnvelope({ body: 'sin mención' }), 'peer-1')
    room.receive('chat', chatEnvelope({ body: `@${ownNick}extra` }), 'peer-1') // no word boundary
    room.receive('chat', chatEnvelope({ body: `correo x@${ownNick}` }), 'peer-1')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not fire for own outgoing messages', async () => {
    const { room, roomId } = await join('general')
    room.peerJoin('peer-1')
    const listener = vi.fn()
    const unsubscribe = manager.onMentionReceived(listener)

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    manager.sendChat(roomId, `nota para mi mismo @${ownNick}`)

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('fires through the encrypted-room decrypt path', async () => {
    const { room, roomId } = await join('secreta', 'clave-compartida')
    room.peerJoin('peer-1')
    const listener = vi.fn()
    const unsubscribe = manager.onMentionReceived(listener)

    const ownNick = manager.getSessionIdentity()?.identity.nickname as string
    const key = await deriveRoomKey('clave-compartida', 'secreta')
    const sealed = await encryptRoomMessage(key, `psst @${ownNick}`)
    room.receive(
      'chat',
      chatEnvelope({ enc: true, iv: sealed.iv, body: sealed.payload }),
      'peer-1',
    )
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    expect(listener).toHaveBeenCalledWith(roomId, 'secreta', 'zorro-bravo', `psst @${ownNick}`)
    unsubscribe()
  })
})
