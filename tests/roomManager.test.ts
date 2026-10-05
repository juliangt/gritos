import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { deriveRoomId, sha256Hex } from '../src/lib/crypto/hashes'
import { formatFingerprint } from '../src/lib/crypto/identity'
import { MAX_CLOCK_SKEW_MS, MAX_ENVELOPE_AGE_MS, type Envelope } from '../src/lib/p2p/protocol'
import { NICKNAME_MAX_LENGTH } from '../src/lib/nickname'
import {
  PENDING_CHATS_CAP,
  SYSTEM_LINE_RATE_CAP,
  SYSTEM_LINE_RATE_WINDOW_MS,
} from '../src/lib/p2p/roomManager'
import { installFakeTrystero } from './fakeTrystero'

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

async function join(name: string, password?: string) {
  const connection = await manager.joinRoom(name, password)
  return {
    connection,
    room: fake.rooms[fake.rooms.length - 1],
    roomId: connection.roomId,
  }
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

function flushMicrotasks(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0).then(() => undefined)
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

// ---------------------------------------------------------------------------
// Join / cap / status
// ---------------------------------------------------------------------------

describe('joinRoom (RF-02, spec §6.3)', () => {
  it('rejects an invalid name before any network call', async () => {
    await expect(manager.joinRoom('!!!')).rejects.toThrowError(manager.RoomNameError)
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
  })

  it('normalizes the name and derives the roomId per §9.4', async () => {
    const { connection } = await join('  Mi Sala  ')
    expect(connection.name).toBe('mi-sala')
    expect(fake.configs[0]?.roomId).toBe(await deriveRoomId('mi-sala'))
    expect(storedRoom(connection.roomId).name).toBe('mi-sala')
  })

  it('rejects the (cap+1)-th room with the typed RF-02 error', async () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 2 })
    await manager.joinRoom('lobby')
    await manager.joinRoom('dev')
    const rejection = manager.joinRoom('random')
    await expect(rejection).rejects.toThrowError(manager.RoomLimitError)
    await expect(rejection).rejects.toThrow('Límite de salas activas alcanzado (2)')
    expect(manager.getActiveRoomCount()).toBe(2)
    expect(Object.keys(useAppStore.getState().rooms)).toHaveLength(2)
  })

  it('is idempotent per room id', async () => {
    const first = await manager.joinRoom('lobby')
    const second = await manager.joinRoom('LOBBY ')
    expect(second.roomId).toBe(first.roomId)
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    expect(manager.getActiveRoomCount()).toBe(1)
  })

  it('passes appId always; custom trackers and ICE only when configured', async () => {
    await manager.joinRoom('lobby')
    expect(fake.configs[0]?.config).toEqual({ appId: 'gritos-app-v1' })

    useSettingsStore.getState().setSettings({
      trackers: ['wss://custom.example'],
      iceServers: [{ urls: 'stun:stun.example:19302' }],
    })
    await manager.joinRoom('dev')
    expect(fake.configs[1]?.config).toEqual({
      appId: 'gritos-app-v1',
      relayConfig: { urls: ['wss://custom.example'] },
      rtcConfig: { iceServers: [{ urls: 'stun:stun.example:19302' }] },
    })
  })

  it('registers exactly the 8 protocol actions (§7.1)', async () => {
    const { room } = await join('lobby')
    expect([...room.actions.keys()].sort()).toEqual(
      ['chat', 'dm', 'keys', 'ping', 'pong', 'presence', 'receipt', 'typing'].sort(),
    )
  })
})

describe('status transitions (spec §10.3)', () => {
  it('starts searching, flips to connected on the first peer join', async () => {
    const { connection, room, roomId } = await join('lobby')
    expect(connection.status).toBe('searching')
    expect(storedRoom(roomId).status).toBe('searching')

    room.peerJoin('peer-1')
    expect(manager.getRoomConnection(roomId)?.status).toBe('connected')
    expect(storedRoom(roomId).status).toBe('connected')
    expect(storedRoom(roomId).peers.map((peer) => peer.id)).toEqual(['peer-1'])
  })

  it('flips to error after 15 s without any peer activity', async () => {
    const { connection, roomId } = await join('lobby')
    await vi.advanceTimersByTimeAsync(14_999)
    expect(connection.status).toBe('searching')
    await vi.advanceTimersByTimeAsync(1)
    expect(manager.getRoomConnection(roomId)?.status).toBe('error')
    expect(storedRoom(roomId).status).toBe('error')
  })

  it('clears the error heuristic once connected', async () => {
    const { room, roomId } = await join('lobby')
    await vi.advanceTimersByTimeAsync(5_000)
    room.peerJoin('peer-1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(storedRoom(roomId).status).toBe('connected')
  })

  it('returns to searching when the last peer leaves, with a fresh heuristic', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.peerLeave('peer-1')
    expect(storedRoom(roomId).status).toBe('searching')
    expect(storedRoom(roomId).peers).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(storedRoom(roomId).status).toBe('error')
  })
})

describe('presence and keys on peer join (§7.1)', () => {
  it('sends presence {nick, fp} and the raw 65-byte key, directed', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    await flushMicrotasks()

    const identity = manager.getSessionIdentity()
    expect(identity).not.toBeNull()

    const presence = room.lastSend('presence')
    expect(presence.data).toEqual({
      nick: identity?.identity.nickname,
      fp: identity?.identity.fingerprint,
    })
    expect(presence.options).toEqual({ target: 'peer-1' })

    const keys = room.lastSend('keys')
    expect(keys.data).toBeInstanceOf(Uint8Array)
    expect((keys.data as Uint8Array).byteLength).toBe(65)
    expect(keys.options).toEqual({ target: 'peer-1' })
  })

  it('applies received presence to the peer entry', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'zorro-bravo', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const peer = storedRoom(roomId).peers[0]
    expect(peer.nickname).toBe('zorro-bravo')
    expect(peer.fingerprint).toBe('A31F 09BC 77D2 4E5A')
  })

  it('caps an oversized remote nick at the local max (issue #28)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'x'.repeat(4000), fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const peer = storedRoom(roomId).peers[0]
    expect(peer.nickname).toHaveLength(NICKNAME_MAX_LENGTH)
    // The join line shows the sanitized nick, never the raw broadcast.
    expect(storedRoom(roomId).messages[0]?.text).toBe(
      `— ${'x'.repeat(NICKNAME_MAX_LENGTH)} se ha unido —`,
    )
  })

  it('strips control characters from a remote nick (issue #28)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive(
      'presence',
      { nick: 'lu\x00na\u200b-\u202eca\x1futa', fp: 'A31F 09BC 77D2 4E5A' },
      'peer-1',
    )
    expect(storedRoom(roomId).peers[0]?.nickname).toBe('luna-cauta')
    expect(storedRoom(roomId).messages[0]?.text).toBe('— luna-cauta se ha unido —')
  })

  it('keeps the peerId-prefix default for a nick that sanitizes to empty (issue #28)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: '\u0000\u200b\u202e', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    // The unusable nick never overwrites the peerId-prefix display default…
    expect(storedRoom(roomId).peers[0]?.nickname).toBe('peer-1'.slice(0, 8))
    // …and no join line is announced for it.
    expect(storedRoom(roomId).messages).toHaveLength(0)
    // A later legible announcement still gets its (one) join line.
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('— luna-cauta se ha unido —')
  })

  it('stores received raw public keys and derives the fingerprint', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const rawKey = new Uint8Array(65).fill(7)
    room.receive('keys', rawKey, 'peer-1')
    const expected = formatFingerprint(await sha256Hex(rawKey))
    await vi.waitFor(() => {
      expect(manager.getPeerRawKey(roomId, 'peer-1')).toEqual(rawKey)
      expect(storedRoom(roomId).peers[0]?.fingerprint).toBe(expected)
    })
  })

  it('discards oversized or wrong-length keys (§7.3 64 KB cap)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    room.receive('keys', new Uint8Array(64 * 1024 + 1), 'peer-1')
    room.receive('keys', new Uint8Array(64), 'peer-1')
    await flushMicrotasks()
    expect(manager.getPeerRawKey(roomId, 'peer-1')).toBeNull()
  })

  it('re-announces presence to all rooms when the nickname changes (RF-01)', async () => {
    const lobby = await join('lobby')
    const dev = await join('dev')
    lobby.room.peerJoin('peer-1')
    dev.room.peerJoin('peer-2')
    await flushMicrotasks()

    const lobbySendsBefore = lobby.room.action('presence').sends.length
    const devSendsBefore = dev.room.action('presence').sends.length
    expect(lobbySendsBefore).toBe(1)
    expect(devSendsBefore).toBe(1)

    manager.setNickname('nuevo-apodo')
    await flushMicrotasks()

    const identity = manager.getSessionIdentity()
    expect(identity?.identity.nickname).toBe('nuevo-apodo')
    expect(useAppStore.getState().identity?.nickname).toBe('nuevo-apodo')

    // Broadcast (no target) with the new nick on every active room.
    const lobbyBroadcast = lobby.room.lastSend('presence')
    expect(lobbyBroadcast.options).toBeUndefined()
    expect(lobbyBroadcast.data).toEqual({ nick: 'nuevo-apodo', fp: identity?.identity.fingerprint })
    const devBroadcast = dev.room.lastSend('presence')
    expect(devBroadcast.options).toBeUndefined()
    expect(dev.room.action('presence').sends).toHaveLength(devSendsBefore + 1)
  })
})

// ---------------------------------------------------------------------------
// Issue #28 — the manager's setNickname validates with the local RF-01 rules
// (the same isValidNickname the UI applies), so every path — including the
// debug panel, which reaches it through useRoomManager.changeNickname —
// produces spec-valid presence. Invalid input throws NicknameError (the
// joinRoom/RoomNameError style) before any state or presence change.
// ---------------------------------------------------------------------------

describe('setNickname validation (issue #28, RF-01)', () => {
  it('rejects an over-max nickname with the typed error, changing nothing', async () => {
    const lobby = await join('lobby')
    lobby.room.peerJoin('peer-1')
    await flushMicrotasks()
    const sendsBefore = lobby.room.action('presence').sends.length
    const identityBefore = manager.getSessionIdentity()?.identity.nickname

    const rejected = 'a'.repeat(NICKNAME_MAX_LENGTH + 1)
    expect(() => manager.setNickname(rejected)).toThrowError(manager.NicknameError)
    expect(() => manager.setNickname(rejected)).toThrowError(
      `Apodo no válido: «${rejected}»`,
    )
    expect(manager.getSessionIdentity()?.identity.nickname).toBe(identityBefore)
    expect(useAppStore.getState().identity?.nickname).toBe(identityBefore)
    await flushMicrotasks()
    expect(lobby.room.action('presence').sends).toHaveLength(sendsBefore)
  })

  it('rejects forbidden characters on every path, including the debug panel shape', () => {
    for (const invalid of ['zorro!', 'a'.repeat(25), '', '   ', 'ñandú🐦', 'zorro.bravo']) {
      expect(() => manager.setNickname(invalid)).toThrowError(manager.NicknameError)
    }
  })

  it('accepts a spec-valid nickname and announces it (UI parity)', async () => {
    const lobby = await join('lobby')
    lobby.room.peerJoin('peer-1')
    await flushMicrotasks()

    manager.setNickname('  luna-cauta  ')
    expect(manager.getSessionIdentity()?.identity.nickname).toBe('luna-cauta')
    await flushMicrotasks()
    expect(lobby.room.lastSend('presence').data).toMatchObject({ nick: 'luna-cauta' })
  })
})

describe('chat flow (§6.4, §7.3)', () => {
  it('appends a valid received chat and answers with a debounced directed receipt', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = chatEnvelope({ body: 'hola mundo' })
    room.receive('chat', envelope, 'peer-1')

    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: envelope.id,
      roomId,
      authorId: 'peer-1',
      authorNick: 'peer-nick',
      text: 'hola mundo',
      status: 'delivered',
      encrypted: false,
      kind: 'user',
    })

    // Receipts are debounced (M2 §7.1 batching), not immediate.
    expect(room.action('receipt').sends).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    const receipt = room.lastSend('receipt')
    expect(receipt.data).toEqual({ ids: [envelope.id] })
    expect(receipt.options).toEqual({ target: 'peer-1' })
  })

  it('dedups by envelope id (full-mesh duplicates)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = chatEnvelope()
    room.receive('chat', envelope, 'peer-1')
    room.receive('chat', envelope, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(1)
  })

  it('ignores envelopes with v ≠ 1', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ v: 2 }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(0)
  })

  it('ignores oversized plaintext bodies and ciphertext until M4', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ body: 'a'.repeat(4001) }), 'peer-1')
    room.receive('chat', chatEnvelope({ enc: true, iv: 'AAAA', body: 'a'.repeat(100) }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(0)
  })

  it('discards foreign dms and ignores addressed ones until M3 (§7.3)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    // Addressed to somebody else: discarded, never relayed nor stored.
    room.receive('chat', chatEnvelope({ kind: 'dm', to: 'someone-else', body: 'secret' }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(0)
    expect(room.action('chat').sends).toHaveLength(0)

    // Addressed to us: protocol-filtered OK, but M1 has no DM crypto yet.
    room.receive(
      'chat',
      chatEnvelope({ kind: 'dm', to: manager.getSelfPeerId(), body: 'secret' }),
      'peer-1',
    )
    expect(storedRoom(roomId).messages).toHaveLength(0)
  })

  it('caps the room feed at 500 messages, FIFO (RF-03)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    for (let i = 0; i < 505; i += 1) {
      room.receive('chat', chatEnvelope({ body: `msg-${i}` }), 'peer-1')
    }
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(500)
    expect(messages[0]?.text).toBe('msg-5')
    expect(messages[499]?.text).toBe('msg-504')
  })

  it('marks own messages delivered on valid receipts (≤50 batch)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = manager.sendTestChat(roomId, 'hola')
    expect(envelope).not.toBeNull()

    room.receive('receipt', { ids: [envelope?.id] }, 'peer-1')
    expect(storedRoom(roomId).messages[0]?.status).toBe('delivered')

    // An oversized receipt batch is discarded (§7.1 max 50).
    const second = manager.sendTestChat(roomId, 'otra')
    const tooMany = Array.from({ length: 51 }, (_, i) => `id-${i}`)
    room.receive('receipt', { ids: tooMany }, 'peer-1')
    expect(storedRoom(roomId).messages[1]?.id).toBe(second?.id)
    expect(storedRoom(roomId).messages[1]?.status).toBe('sent')
  })
})

// ---------------------------------------------------------------------------
// Issue #19 — freshness window on the chat receive path: a captured envelope
// replayed after a dedup reset (reload/rejoin) is discarded by age, closing
// the social-engineering replay. Date.now is frozen by the fake timers, so
// the tests place `ts` explicitly around it.
// ---------------------------------------------------------------------------

describe('chat freshness window (issue #19)', () => {
  it('processes fresh chat envelopes', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ ts: Date.now() }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(1)
  })

  it('discards an envelope older than 5 minutes with zero state change', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ ts: Date.now() - MAX_ENVELOPE_AGE_MS - 1 }), 'peer-1')

    // No feed entry, and no debounced receipt either.
    expect(storedRoom(roomId).messages).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('discards an envelope dated 2 minutes into the future', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ ts: Date.now() + 120_000 }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(0)
  })

  it('keeps boundary envelopes just inside the window', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('chat', chatEnvelope({ ts: Date.now() - MAX_ENVELOPE_AGE_MS }), 'peer-1')
    room.receive('chat', chatEnvelope({ ts: Date.now() + MAX_CLOCK_SKEW_MS }), 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(2)
  })
})

describe('typing (RF-03: 4 s expiry)', () => {
  it('records typing on receipt and expires entries after 4 s', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    room.receive('typing', { on: true }, 'peer-1')
    expect(Object.keys(storedRoom(roomId).typing)).toEqual(['peer-1'])

    await vi.advanceTimersByTimeAsync(3_500)
    expect(storedRoom(roomId).typing['peer-1']).toBeDefined()
    await vi.advanceTimersByTimeAsync(700)
    expect(storedRoom(roomId).typing['peer-1']).toBeUndefined()
  })

  it('clears typing immediately on {on: false} and on peer leave', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('typing', { on: true }, 'peer-1')
    room.receive('typing', { on: false }, 'peer-1')
    expect(storedRoom(roomId).typing).toEqual({})

    room.receive('typing', { on: true }, 'peer-1')
    room.peerLeave('peer-1')
    expect(storedRoom(roomId).typing).toEqual({})
  })
})

describe('ping/pong (§7.1)', () => {
  it('echoes received pings with the same timestamp, directed', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('ping', { t: 1234 }, 'peer-1')
    const pong = room.lastSend('pong')
    expect(pong.data).toEqual({ t: 1234 })
    expect(pong.options).toEqual({ target: 'peer-1' })
  })

  it('notifies pong listeners with the echoed timestamp', async () => {
    const { room, roomId } = await join('lobby')
    const listener = vi.fn()
    const unsubscribe = manager.onPong(listener)
    room.peerJoin('peer-1')
    room.receive('pong', { t: 555 }, 'peer-1')
    expect(listener).toHaveBeenCalledWith(roomId, 'peer-1', 555)
    unsubscribe()
    room.receive('pong', { t: 556 }, 'peer-1')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed ping/pong payloads', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('ping', { t: 'x' }, 'peer-1')
    room.receive('pong', { t: 'x' }, 'peer-1')
    expect(room.action('pong').sends).toHaveLength(0)
  })
})

describe('debug surface (M1)', () => {
  it('sendTestChat broadcasts an envelope and echoes it as a self message', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    await flushMicrotasks()

    const envelope = manager.sendTestChat(roomId, 'prueba')
    expect(envelope).not.toBeNull()
    expect(room.lastSend('chat').data).toEqual(envelope)

    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: envelope?.id,
      authorId: 'self',
      authorNick: manager.getSessionIdentity()?.identity.nickname,
      text: 'prueba',
      status: 'sent',
    })
  })

  it('sendTestChat returns null for unknown rooms', () => {
    expect(manager.sendTestChat('nope', 'prueba')).toBeNull()
  })
})

describe('leave and reconnect (RF-02, RF-07)', () => {
  it('leaveRoom closes the mesh and drops room state', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    await manager.leaveRoom(roomId)

    expect(room.leave).toHaveBeenCalledTimes(1)
    expect(manager.getRoomConnection(roomId)).toBeUndefined()
    expect(useAppStore.getState().rooms[roomId]).toBeUndefined()
    expect(manager.getActiveRoomCount()).toBe(0)
  })

  it('frees a cap slot when a room is left', async () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 1 })
    const first = await manager.joinRoom('lobby')
    await expect(manager.joinRoom('dev')).rejects.toThrowError(manager.RoomLimitError)
    await manager.leaveRoom(first.roomId)
    await expect(manager.joinRoom('dev')).resolves.toBeDefined()
  })

  it('reconnectAll re-joins every room with the current settings', async () => {
    const lobby = await join('lobby')
    const dev = await join('dev')
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(2)

    useSettingsStore.getState().setSettings({ trackers: ['wss://new.example'] })
    await manager.reconnectAll()

    expect(fake.joinRoomFn).toHaveBeenCalledTimes(4)
    expect(lobby.room.leave).toHaveBeenCalledTimes(1)
    expect(dev.room.leave).toHaveBeenCalledTimes(1)
    expect(fake.configs[2]?.config).toEqual({
      appId: 'gritos-app-v1',
      relayConfig: { urls: ['wss://new.example'] },
    })
    expect(fake.configs[3]?.roomId).toBe(dev.connection.roomId)
    expect(useAppStore.getState().rooms[lobby.roomId]).toBeDefined()
    expect(useAppStore.getState().rooms[dev.roomId]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// M2 — outgoing chat queue, receipts batching, system lines, recents
// ---------------------------------------------------------------------------

describe('M2 outgoing chat (RF-03, §10.3)', () => {
  it('queues sends while searching and flushes them on the first peer join', async () => {
    const { room, roomId } = await join('lobby')
    // Room is 'searching': the envelope is queued, not sent.
    const first = manager.sendChat(roomId, 'en cola')
    expect(first).not.toBeNull()
    expect(room.action('chat').sends).toHaveLength(0)

    const second = manager.sendChat(roomId, 'también en cola')
    room.peerJoin('peer-1')
    await flushMicrotasks()

    expect(second).not.toBeNull()
    const sends = room.action('chat').sends
    expect(sends).toHaveLength(2)
    expect(sends[0]?.data).toMatchObject({ body: 'en cola' })
    expect(sends[1]?.data).toMatchObject({ body: 'también en cola' })

    const messages = storedRoom(roomId).messages
    expect(messages.filter((message) => message.authorId === 'self')).toHaveLength(2)
  })

  it('sends immediately once connected', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = manager.sendChat(roomId, 'hola')
    expect(envelope).not.toBeNull()
    expect(room.lastSend('chat').data).toEqual(envelope)
  })

  it('emits typing signals via sendTyping', async () => {
    const { room, roomId } = await join('lobby')
    manager.sendTyping(roomId, true)
    expect(room.lastSend('typing').data).toEqual({ on: true })
    manager.sendTyping(roomId, false)
    expect(room.lastSend('typing').data).toEqual({ on: false })
  })

  it('caps the feed at 500 and flags the FIFO separator', async () => {
    const { roomId } = await join('lobby')
    const fakeRoom = fake.rooms[fake.rooms.length - 1]
    fakeRoom.peerJoin('peer-1')
    for (let i = 0; i < 505; i += 1) {
      fakeRoom.receive('chat', chatEnvelope({ body: `msg-${i}` }), 'peer-1')
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(storedRoom(roomId).fifoTrimmed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Issue #20 — the §10.3 offline chat queue is capped at PENDING_CHATS_CAP:
// a room that never reaches `connected` must not grow it without bound.
// ---------------------------------------------------------------------------

describe('pendingChats cap (issue #20)', () => {
  it('caps the offline queue at 100 envelopes, dropping the oldest', async () => {
    const { room, roomId } = await join('lobby')
    expect(manager.getRoomConnection(roomId)?.status).toBe('searching')

    // The room never connects while typing: every envelope is queued.
    for (let i = 0; i < PENDING_CHATS_CAP + 20; i += 1) {
      expect(manager.sendChat(roomId, `msg-${i}`)).not.toBeNull()
    }
    expect(room.action('chat').sends).toHaveLength(0)

    // The flush still delivers what remains, oldest-first in send order.
    room.peerJoin('peer-1')
    await flushMicrotasks()
    const sends = room.action('chat').sends
    expect(sends).toHaveLength(PENDING_CHATS_CAP)
    expect(sends[0]?.data).toMatchObject({ body: 'msg-20' })
    expect(sends[PENDING_CHATS_CAP - 1]?.data).toMatchObject({ body: 'msg-119' })
    expect(sends.map((send) => (send.data as Envelope).body)).toEqual(
      Array.from({ length: PENDING_CHATS_CAP }, (_, i) => `msg-${i + 20}`),
    )
  })
})

describe('M2 receipts batching (§7.1: debounce + ≤50 ids)', () => {
  it('debounces ~300 ms and batches several ids into one directed payload', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')

    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const envelope = chatEnvelope({ body: `m${i}` })
      ids.push(envelope.id)
      room.receive('chat', envelope, 'peer-1')
    }
    // Nothing before the debounce window elapses.
    await vi.advanceTimersByTimeAsync(299)
    expect(room.action('receipt').sends).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    const receipt = room.lastSend('receipt')
    expect(receipt.options).toEqual({ target: 'peer-1' })
    expect((receipt.data as { ids: string[] }).ids).toEqual(ids)
  })

  it('splits large bursts into payloads of at most 50 ids', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    for (let i = 0; i < 120; i += 1) {
      room.receive('chat', chatEnvelope({ body: `m${i}` }), 'peer-1')
    }
    await vi.advanceTimersByTimeAsync(300)

    const receipts = room.action('receipt').sends
    expect(receipts.map((send) => (send.data as { ids: string[] }).ids.length)).toEqual([
      50, 50, 20,
    ])
    for (const send of receipts) {
      expect(send.options).toEqual({ target: 'peer-1' })
    }
  })

  it('keeps receipts per author, directed to each', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.peerJoin('peer-2')

    const a = chatEnvelope({ body: 'de a' })
    const b = chatEnvelope({ body: 'de b' })
    room.receive('chat', a, 'peer-1')
    room.receive('chat', b, 'peer-2')
    await vi.advanceTimersByTimeAsync(300)

    const sends = room.action('receipt').sends
    expect(sends).toHaveLength(2)
    const byTarget = new Map(
      sends.map((send) => [send.options?.target, (send.data as { ids: string[] }).ids]),
    )
    expect(byTarget.get('peer-1')).toEqual([a.id])
    expect(byTarget.get('peer-2')).toEqual([b.id])
  })
})

describe('M2 system feed lines (RF-06)', () => {
  it('adds a join line on the first presence, silent on nickname changes', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')

    let messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'system',
      authorId: 'system',
      text: '— luna-cauta se ha unido —',
    })

    room.receive('presence', { nick: 'luna-c', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
  })

  it('adds a leave line with the last known nickname on peer leave', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    room.peerLeave('peer-1')

    const messages = storedRoom(roomId).messages
    expect(messages[messages.length - 1]).toMatchObject({
      kind: 'system',
      text: '— luna-cauta ha salido —',
    })
    // A returning peer re-announces its join.
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const again = storedRoom(roomId).messages
    expect(again[again.length - 1]).toMatchObject({
      text: '— luna-cauta se ha unido —',
    })
  })

  it('does not count system lines as unread for a non-active room', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F' }, 'peer-1')
    expect(storedRoom(roomId).unread).toBe(0)

    room.receive('chat', chatEnvelope(), 'peer-1')
    expect(storedRoom(roomId).unread).toBe(1)
  })
})

describe('issue #36 — system-line rate cap (per peer, rolling minute)', () => {
  it('suppresses lines beyond the cap for one peer without touching other peers', async () => {
    const { room, roomId } = await join('lobby')
    const presence = { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }

    // Join → leave → rejoin: exactly SYSTEM_LINE_RATE_CAP lines go through.
    room.peerJoin('peer-1')
    room.receive('presence', presence, 'peer-1')
    room.peerLeave('peer-1')
    room.peerJoin('peer-1')
    room.receive('presence', presence, 'peer-1')
    let texts = storedRoom(roomId).messages.map((message) => message.text)
    expect(texts).toHaveLength(SYSTEM_LINE_RATE_CAP)

    // The 4th line (a leave) and the 5th attempt (a rejoin announcement)
    // are suppressed: the forged-churn flood cannot evict history.
    room.peerLeave('peer-1')
    room.peerJoin('peer-1')
    room.receive('presence', presence, 'peer-1')
    texts = storedRoom(roomId).messages.map((message) => message.text)
    expect(texts).toHaveLength(SYSTEM_LINE_RATE_CAP)

    // A different peer is never affected by peer-1's exhausted budget.
    room.peerJoin('peer-2')
    room.receive('presence', { nick: 'zorro-bravo', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-2')
    texts = storedRoom(roomId).messages.map((message) => message.text)
    expect(texts).toHaveLength(SYSTEM_LINE_RATE_CAP + 1)
    expect(texts[texts.length - 1]).toBe('— zorro-bravo se ha unido —')

    // Once the rolling window rolls off, the suppressed join announcement
    // of peer-1 (still unannounced) goes through.
    await vi.advanceTimersByTimeAsync(SYSTEM_LINE_RATE_WINDOW_MS + 1)
    room.receive('presence', presence, 'peer-1')
    texts = storedRoom(roomId).messages.map((message) => message.text)
    expect(texts).toHaveLength(SYSTEM_LINE_RATE_CAP + 2)
    expect(texts[texts.length - 1]).toBe('— luna-cauta se ha unido —')
  })

  it('never caps the first join line of a peer (fresh budget announces immediately)', async () => {
    const { room, roomId } = await join('lobby')
    // An instant before any churn: the very first presence becomes a line.
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'system', text: '— luna-cauta se ha unido —' })
  })
})

describe('M2 recent rooms (§8.2 gritos:rooms)', () => {
  it('records joined rooms most-recent-first while rememberRooms is on', async () => {
    await manager.joinRoom('lobby')
    await manager.joinRoom('dev')
    expect(useAppStore.getState().recentRooms).toEqual(['dev', 'lobby'])
  })

  it('keeps the list deduped and most-recent-first through re-joins', async () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 6 })
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await manager.joinRoom(name)
    }
    await manager.joinRoom('a') // re-join moves 'a' to the front, no dup
    const recent = useAppStore.getState().recentRooms
    expect(recent).toEqual(['a', 'e', 'd', 'c', 'b'])
  })

  it('records nothing when rememberRooms is off', async () => {
    useSettingsStore.getState().setSettings({ rememberRooms: false })
    await manager.joinRoom('lobby')
    expect(useAppStore.getState().recentRooms).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Issue #45 — every send is routed through safeSend: a data channel that
// closes mid-flight must never escape as an unhandled rejection. Vitest
// fails the run on any unhandled rejection, so a bare `void send(...)`
// (no .catch) would fail these tests; each one also pins the flow that
// must keep working when the channel rejects.
// ---------------------------------------------------------------------------

describe('safeSend routing (issue #45: rejecting sends stay handled)', () => {
  it('the peer-join presence+keys announce survives a closed channel', async () => {
    const { room, roomId } = await join('lobby')
    room.failSends = true
    room.peerJoin('peer-1')
    await flushMicrotasks()

    // The join flow completed: the peer landed in the store and both
    // directed sends were attempted before the channel rejected them.
    expect(storedRoom(roomId).peers.map((peer) => peer.id)).toEqual(['peer-1'])
    expect(room.lastSend('presence').options).toEqual({ target: 'peer-1' })
    expect(room.lastSend('keys').options).toEqual({ target: 'peer-1' })
  })

  it('sendPing survives a closed channel and still reports the attempt', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    await flushMicrotasks()

    room.failSends = true
    expect(manager.sendPing(roomId, 'peer-1', 1234)).toBe(true)
    await flushMicrotasks()

    const ping = room.lastSend('ping')
    expect(ping.data).toEqual({ t: 1234 })
    expect(ping.options).toEqual({ target: 'peer-1' })
  })

  it('the regenerateSessionIdentity keys re-announce survives a closed channel', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    // Make the peer known so the re-announce loop targets it.
    room.receive('keys', new Uint8Array(65).fill(7), 'peer-1')
    await flushMicrotasks()

    room.failSends = true
    const session = await manager.regenerateSessionIdentity()
    await flushMicrotasks()

    expect(session).not.toBeNull()
    const reannounce = room.lastSend('keys')
    expect(reannounce.data).toEqual(session?.rawPublicKey)
    expect(reannounce.options).toEqual({ target: 'peer-1' })
  })

  it('a synchronously throwing channel does not break the peer-join flow', async () => {
    const { room, roomId } = await join('lobby')
    room.action('keys').send = () => {
      throw new Error('channel closed synchronously')
    }

    expect(() => room.peerJoin('peer-1')).not.toThrow()
    await flushMicrotasks()
    expect(storedRoom(roomId).peers.map((peer) => peer.id)).toEqual(['peer-1'])
  })
})
