import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { deriveRoomId, sha256Hex } from '../src/lib/crypto/hashes'
import { formatFingerprint } from '../src/lib/crypto/identity'
import { deriveRoomKey, decryptRoomMessage, encryptRoomMessage } from '../src/lib/crypto/roomKey'
import {
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_AGE_MS,
  MAX_HISTORY_BATCH,
  MAX_HISTORY_BATCH_BYTES,
  MAX_HISTORY_REQUEST,
  MAX_REACT_BATCH,
  parseEnvelope,
  type Envelope,
} from '../src/lib/p2p/protocol'
import { NICKNAME_MAX_LENGTH } from '../src/lib/nickname'
import {
  HISTORY_ASK_RATE_CAP,
  HISTORY_ASK_RATE_WINDOW_MS,
  HISTORY_RATE_CAP,
  HISTORY_RATE_WINDOW_MS,
  HISTORY_REQ_RATE_CAP,
  HISTORY_REQ_RATE_WINDOW_MS,
  MAX_RECOVERED_PER_JOIN,
  PENDING_CHATS_CAP,
  REACT_RATE_CAP,
  REACT_RATE_WINDOW_MS,
  SYSTEM_LINE_RATE_CAP,
  SYSTEM_LINE_RATE_WINDOW_MS,
} from '../src/lib/p2p/roomManager'
import { installFakeTrystero, makeFakeRemotePeer } from './fakeTrystero'

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

/**
 * Phase 3 helper — waits (REAL timers) for the recovered-append chain to
 * land: password-room recovery awaits genuine crypto work (a 600k-iteration
 * PBKDF2 room-key derivation plus AES-GCM), which fake-timer advances alone
 * cannot clock. Polls `check` until it passes, then restores fake timers.
 */
async function untilRecoveredSettled(check: () => void): Promise<void> {
  vi.useRealTimers()
  try {
    await vi.waitFor(check, { timeout: 10_000, interval: 25 })
  } finally {
    vi.useFakeTimers()
  }
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
    await expect(rejection).rejects.toThrow('Active room limit reached (2)')
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

  it('registers exactly the 17 protocol actions (§7.1, incl. ephkeys #93, react #98, hist #102, file #103)', async () => {
    const { room } = await join('lobby')
    expect([...room.actions.keys()].sort()).toEqual(
      [
        'chat',
        'dm',
        'ephkeys',
        'file-abort',
        'file-ack',
        'file-chunk',
        'file-end',
        'file-meta',
        'hist',
        'hist-req',
        'keys',
        'ping',
        'pong',
        'presence',
        'react',
        'receipt',
        'typing',
      ].sort(),
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
      `— ${'x'.repeat(NICKNAME_MAX_LENGTH)} joined —`,
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
    expect(storedRoom(roomId).messages[0]?.text).toBe('— luna-cauta joined —')
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
    expect(messages[0]?.text).toBe('— luna-cauta joined —')
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
    expect(() => manager.setNickname(rejected)).toThrowError(`Invalid nickname: "${rejected}"`)
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

  it('attaches an optional ttl to the outgoing envelope (issue #96)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = manager.sendChat(roomId, 'se autodestruye', 300)
    expect(envelope?.ttl).toBe(300)
    // Test guard: ttl rides the CURRENT chat version — no v bump — and the
    // receiving parser (every peer's gate) accepts it.
    const wire = room.lastSend('chat').data as Envelope
    expect(wire.v).toBe(1)
    expect(wire.ttl).toBe(300)
    expect(parseEnvelope(wire)?.ttl).toBe(300)
  })

  it('keeps the no-ttl wire form byte-identical to pre-TTL builds (issue #96)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const envelope = manager.sendChat(roomId, 'hola')
    expect(Object.keys(envelope as object)).not.toContain('ttl')
    expect(Object.keys(room.lastSend('chat').data as object)).not.toContain('ttl')
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
      text: '— luna-cauta joined —',
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
      text: '— luna-cauta left —',
    })
    // A returning peer re-announces its join.
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const again = storedRoom(roomId).messages
    expect(again[again.length - 1]).toMatchObject({
      text: '— luna-cauta joined —',
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
    expect(texts[texts.length - 1]).toBe('— zorro-bravo joined —')

    // Once the rolling window rolls off, the suppressed join announcement
    // of peer-1 (still unannounced) goes through.
    await vi.advanceTimersByTimeAsync(SYSTEM_LINE_RATE_WINDOW_MS + 1)
    room.receive('presence', presence, 'peer-1')
    texts = storedRoom(roomId).messages.map((message) => message.text)
    expect(texts).toHaveLength(SYSTEM_LINE_RATE_CAP + 2)
    expect(texts[texts.length - 1]).toBe('— luna-cauta joined —')
  })

  it('never caps the first join line of a peer (fresh budget announces immediately)', async () => {
    const { room, roomId } = await join('lobby')
    // An instant before any churn: the very first presence becomes a line.
    room.peerJoin('peer-1')
    room.receive('presence', { nick: 'luna-cauta', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-1')
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'system', text: '— luna-cauta joined —' })
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

// ---------------------------------------------------------------------------
// Issue #98 — emoji reactions, phase 1 (protocol spike + action)
// ---------------------------------------------------------------------------

interface ReactDelivery {
  roomId: string
  peerId: string
  payload: unknown
}

function collectReactDeliveries(): ReactDelivery[] {
  const deliveries: ReactDelivery[] = []
  manager.onReact((roomId, peerId, payload) => {
    deliveries.push({ roomId, peerId, payload })
  })
  return deliveries
}

describe('issue #98 — react receive path (validation + onReact seam)', () => {
  it('delivers a valid broadcast reaction through the onReact seam', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()

    room.receive('react', { ids: ['m-1', 'm-2'], emo: '🎉', on: true }, 'peer-1')
    expect(deliveries).toEqual([
      { roomId, peerId: 'peer-1', payload: { ids: ['m-1', 'm-2'], emo: '🎉', on: true } },
    ])
  })

  it('drops invalid payloads silently (cosmetic class: no seam call)', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()

    room.receive('react', { ids: ['m-1'], emo: '🚀', on: true }, 'peer-1') // not whitelisted
    room.receive('react', { ids: ['m-1'], emo: '👍' }, 'peer-1') // on missing
    room.receive('react', { ids: [], emo: '👍', on: true }, 'peer-1') // empty batch
    room.receive(
      'react',
      { ids: Array.from({ length: MAX_REACT_BATCH + 1 }, (_, i) => `m-${i}`), emo: '👍', on: true },
      'peer-1',
    ) // over the batch cap
    room.receive('react', { emo: '👍', on: true }, 'peer-1') // ids missing
    room.receive('react', '👍', 'peer-1') // not even an object
    expect(deliveries).toHaveLength(0)
  })

  it('delivers DM reactions addressed to self and drops foreign-directed ones', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()

    room.receive(
      'react',
      { ids: ['dm-1'], emo: '❤️', on: true, to: manager.getSelfPeerId() },
      'peer-1',
    )
    expect(deliveries).toHaveLength(1)

    // Directed at another peer: dropped, never relayed (§7.3).
    room.receive('react', { ids: ['dm-1'], emo: '❤️', on: true, to: 'someone-else' }, 'peer-1')
    expect(deliveries).toHaveLength(1)
  })
})

describe('issue #98 — react rate cap (per peer, rolling minute)', () => {
  it('accepts REACT_RATE_CAP payloads per peer and drops the excess within the window', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()

    // Unique id sets: only the rate cap can drop any of these.
    for (let i = 0; i < REACT_RATE_CAP; i++) {
      room.receive('react', { ids: [`m-${i}`], emo: '👍', on: true }, 'peer-1')
    }
    expect(deliveries).toHaveLength(REACT_RATE_CAP)

    room.receive('react', { ids: ['m-over'], emo: '👍', on: true }, 'peer-1')
    expect(deliveries).toHaveLength(REACT_RATE_CAP)
  })

  it('processes again once the rolling window rolls off', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()
    for (let i = 0; i < REACT_RATE_CAP; i++) {
      room.receive('react', { ids: [`m-${i}`], emo: '👍', on: true }, 'peer-1')
    }
    expect(deliveries).toHaveLength(REACT_RATE_CAP)

    await vi.advanceTimersByTimeAsync(REACT_RATE_WINDOW_MS + 1)
    room.receive('react', { ids: ['m-after'], emo: '👍', on: true }, 'peer-1')
    expect(deliveries).toHaveLength(REACT_RATE_CAP + 1)
  })

  it('caps per peer without touching other peers', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.peerJoin('peer-2')
    const deliveries = collectReactDeliveries()
    for (let i = 0; i < REACT_RATE_CAP; i++) {
      room.receive('react', { ids: [`m-${i}`], emo: '👍', on: true }, 'peer-1')
    }
    expect(deliveries).toHaveLength(REACT_RATE_CAP)

    // peer-2 has its own fresh budget.
    room.receive('react', { ids: ['m-other'], emo: '👍', on: true }, 'peer-2')
    expect(deliveries).toHaveLength(REACT_RATE_CAP + 1)
    expect(deliveries[deliveries.length - 1]?.peerId).toBe('peer-2')
  })
})

describe('issue #98 — react replay dedup (through the connection BoundedSeenIds)', () => {
  it('drops an identical replayed payload', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()
    const payload = { ids: ['m-1'], emo: '👍', on: true }

    room.receive('react', payload, 'peer-1')
    room.receive('react', payload, 'peer-1')
    expect(deliveries).toHaveLength(1)
  })

  it('still processes the inverse toggle after a replay is dropped', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()

    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, 'peer-1')
    room.receive('react', { ids: ['m-1'], emo: '👍', on: true }, 'peer-1') // replay
    room.receive('react', { ids: ['m-1'], emo: '👍', on: false }, 'peer-1') // unreact
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]?.payload).toEqual({ ids: ['m-1'], emo: '👍', on: false })
  })

  it('keeps dropping replays across peer churn on the same connection', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()
    const payload = { ids: ['m-1'], emo: '👍', on: true }
    room.receive('react', payload, 'peer-1')
    expect(deliveries).toHaveLength(1)

    room.peerLeave('peer-1')
    room.peerJoin('peer-1')
    room.receive('react', payload, 'peer-1')
    expect(deliveries).toHaveLength(1)
  })

  it('starts a fresh dedup window on a NEW connection (per-connection set)', async () => {
    const first = await join('lobby')
    first.room.peerJoin('peer-1')
    const deliveries = collectReactDeliveries()
    const payload = { ids: ['m-1'], emo: '👍', on: true }
    first.room.receive('react', payload, 'peer-1')
    expect(deliveries).toHaveLength(1)

    await manager.leaveRoom(first.roomId)
    const second = await join('lobby')
    second.room.peerJoin('peer-1')
    second.room.receive('react', payload, 'peer-1')
    expect(deliveries).toHaveLength(2)
  })
})

describe('issue #98 — sendReact (batched like receipts, directed vs broadcast)', () => {
  it('broadcasts room-wide reactions with no target', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    expect(manager.sendReact(roomId, ['m-1', 'm-2'], '🎉', true)).toBe(true)
    const send = room.lastSend('react')
    expect(send.data).toEqual({ ids: ['m-1', 'm-2'], emo: '🎉', on: true })
    expect(send.options).toBeUndefined()
  })

  it('sends DM reactions directed at the peer with `to` set', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    expect(manager.sendReact(roomId, ['dm-1'], '❤️', true, 'peer-1')).toBe(true)
    const send = room.lastSend('react')
    expect(send.data).toEqual({ ids: ['dm-1'], emo: '❤️', on: true, to: 'peer-1' })
    expect(send.options).toEqual({ target: 'peer-1' })
  })

  it('chunks oversized batches to MAX_REACT_BATCH ids like receipts', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const ids = Array.from({ length: MAX_REACT_BATCH + 5 }, (_, i) => `m-${i}`)
    expect(manager.sendReact(roomId, ids, '👍', true)).toBe(true)
    const sends = room.action('react').sends
    expect(sends).toHaveLength(2)
    expect((sends[0]?.data as { ids: string[] }).ids).toHaveLength(MAX_REACT_BATCH)
    expect((sends[1]?.data as { ids: string[] }).ids).toHaveLength(5)
  })

  it('dedups input ids before batching', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    expect(manager.sendReact(roomId, ['a', 'a', 'b', 'a'], '👍', true)).toBe(true)
    expect(room.lastSend('react').data).toEqual({ ids: ['a', 'b'], emo: '👍', on: true })
  })

  it('refuses unknown, disconnected or invalid requests without sending', async () => {
    expect(manager.sendReact('nope', ['m-1'], '👍', true)).toBe(false)
    const { room, roomId } = await join('lobby') // still searching
    expect(manager.sendReact(roomId, ['m-1'], '👍', true)).toBe(false)
    room.peerJoin('peer-1')
    expect(manager.sendReact(roomId, ['m-1'], '🚀', true)).toBe(false) // whitelist
    expect(manager.sendReact(roomId, [], '👍', true)).toBe(false)
    expect(manager.sendReact(roomId, ['m-1', ''], '👍', true)).toBe(false)
    expect(manager.sendReact(roomId, ['m-1'], '👍', 'yes' as unknown as boolean)).toBe(false)
    expect(room.action('react').sends).toHaveLength(0)
  })

  it('does not send any chunk when a later batch is invalid', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const ids = [...Array.from({ length: MAX_REACT_BATCH }, (_, i) => `m-${i}`), '']
    expect(manager.sendReact(roomId, ids, '👍', true)).toBe(false)
    expect(room.action('react').sends).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Issue #102 — history gossip, phase 1 (protocol). The replay path bypasses
// ONLY the freshness AGE window (recovered messages are older than 5 minutes
// by definition); every parseEnvelope shape check — including the ±90 s
// future-skew bound — stays. Delivery is seam-only at the TRANSPORT level
// (no unread, no mention, no receipt, no typing — ✓✓ means LIVE delivery);
// since phase 3 the onRecovered seam is wired at module level and appends
// the rows flagged `recovered` (see the phase-3 describes below).
// The consent layer is phase 2: the transport never answers a hist-req.
// ---------------------------------------------------------------------------

function collectHistDeliveries(): {
  requests: { roomId: string; peerId: string; n: number }[]
  recovered: { roomId: string; envelopes: Envelope[] }[]
} {
  const requests: { roomId: string; peerId: string; n: number }[] = []
  const recovered: { roomId: string; envelopes: Envelope[] }[] = []
  manager.onHistRequest((roomId, peerId, n) => {
    requests.push({ roomId, peerId, n })
  })
  manager.onRecovered((roomId, envelopes) => {
    recovered.push({ roomId, envelopes })
  })
  return { requests, recovered }
}

/** UTF-8 byte length of an encoded `hist` payload — the sender-side measure. */
function histPayloadBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify(data)).byteLength
}

describe('issue #102 — hist-req receive path (validation + rate cap + seam)', () => {
  it('delivers a valid request through the onHistRequest seam', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const { requests } = collectHistDeliveries()

    room.receive('hist-req', { n: 50 }, 'peer-1')
    expect(requests).toEqual([{ roomId, peerId: 'peer-1', n: 50 }])
  })

  it('drops invalid n silently without consuming the rate budget', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const { requests } = collectHistDeliveries()

    room.receive('hist-req', { n: 0 }, 'peer-1')
    room.receive('hist-req', { n: -1 }, 'peer-1')
    room.receive('hist-req', { n: MAX_HISTORY_REQUEST + 1 }, 'peer-1')
    room.receive('hist-req', { n: 2.5 }, 'peer-1')
    room.receive('hist-req', { n: '5' }, 'peer-1')
    room.receive('hist-req', {}, 'peer-1')
    room.receive('hist-req', '50', 'peer-1')
    expect(requests).toHaveLength(0)

    // The violations burned no budget: the first valid ask still goes through.
    room.receive('hist-req', { n: 10 }, 'peer-1')
    expect(requests).toEqual([{ roomId: requests[0]?.roomId, peerId: 'peer-1', n: 10 }])
  })

  it('caps at HISTORY_REQ_RATE_CAP per rolling minute per peer', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.peerJoin('peer-2')
    const { requests } = collectHistDeliveries()

    room.receive('hist-req', { n: 5 }, 'peer-1')
    expect(requests).toHaveLength(1)
    // Second ask within the window: dropped.
    room.receive('hist-req', { n: 6 }, 'peer-1')
    expect(requests).toHaveLength(1)
    // peer-2 has its own fresh budget.
    room.receive('hist-req', { n: 7 }, 'peer-2')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.peerId).toBe('peer-2')

    // Once the window rolls off, peer-1 may ask again.
    await vi.advanceTimersByTimeAsync(HISTORY_REQ_RATE_WINDOW_MS + 1)
    room.receive('hist-req', { n: 8 }, 'peer-1')
    expect(requests).toHaveLength(3)
    expect(HISTORY_REQ_RATE_CAP).toBe(1)
  })

  it('drops a muted peer request before validation and rate cap', async () => {
    const { room, roomId } = await join('lobby')
    const muted = await makeFakeRemotePeer('peer-muted')
    expect(useSettingsStore.getState().muteFingerprint(muted.fingerprint, 'molesto')).toBe(true)
    // Join with `keys` only (no presence announce): then the store peer
    // fingerprint is written by the SAME async tail that arms peerKeyFps,
    // so waiting on it gates exactly on the mute gate being armed (issue
    // #95 fail-open until then).
    room.peerJoin(muted.id)
    room.receive('keys', muted.rawPublicKey, muted.id)
    await vi.waitFor(() => {
      expect(storedRoom(roomId).peers.find((peer) => peer.id === muted.id)?.fingerprint).toBe(
        muted.fingerprint,
      )
    })
    const { requests } = collectHistDeliveries()

    room.receive('hist-req', { n: 10 }, muted.id)
    expect(requests).toHaveLength(0)
  })

  it('the transport still never answers by itself (the consent layer owns all sends)', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    collectHistDeliveries()

    room.receive('hist-req', { n: 25 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room.action('hist').sends).toHaveLength(0)
  })
})

describe('issue #102 — hist receive path (replay: bypass + skew + dedup + silence)', () => {
  it('delivers a valid batch through onRecovered, normalized', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()

    const a = chatEnvelope({ id: 'id-a', body: ' viejo' })
    const b = chatEnvelope({ id: 'id-b' })
    room.receive('hist', { batch: [{ ...a, unexpected: 'x' }, b] }, 'peer-1')
    expect(recovered).toEqual([{ roomId, envelopes: [a, b] }])
  })

  it('drops invalid batches whole, without consuming the rate budget', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()

    const good = chatEnvelope()
    room.receive('hist', { batch: [] }, 'peer-1') // empty
    room.receive(
      'hist',
      { batch: Array.from({ length: MAX_HISTORY_BATCH + 1 }, () => chatEnvelope()) },
      'peer-1',
    ) // over the count cap
    room.receive('hist', { batch: [good, { ...good, id: '' }] }, 'peer-1') // malformed inside
    room.receive(
      'hist',
      {
        batch: [
          good,
          { ...good, kind: 'dm', to: 'peer-2' }, // DMs are never gossiped
        ],
      },
      'peer-1',
    )
    room.receive('hist', { batch: good }, 'peer-1') // not a batch array
    room.receive('hist', 'hola', 'peer-1') // not even an object
    expect(recovered).toHaveLength(0)

    // The violations burned no budget: HISTORY_RATE_CAP valid batches after
    // them all still go through.
    for (let i = 0; i < HISTORY_RATE_CAP; i++) {
      room.receive('hist', { batch: [chatEnvelope({ id: `id-${i}` })] }, 'peer-1')
    }
    expect(recovered).toHaveLength(HISTORY_RATE_CAP)
  })

  it('bypasses the AGE window but keeps the future-skew check', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()

    const ancient = chatEnvelope({
      id: 'id-ancient',
      ts: Date.now() - MAX_ENVELOPE_AGE_MS - 3_600_000,
    })
    const skewed = chatEnvelope({ id: 'id-skew', ts: Date.now() + MAX_CLOCK_SKEW_MS + 1 })
    room.receive('hist', { batch: [ancient, skewed] }, 'peer-1')

    // The hour-old envelope rides the replay path (the live path drops it);
    // the future-skewed one still dies: shape checks stay, only age is
    // bypassed — and a rejected envelope consumes no dedup id.
    expect(recovered).toEqual([{ roomId: recovered[0]?.roomId, envelopes: [ancient] }])
    // Phase 3 wiring: the survivor lands in the feed through the recovered
    // append (an async tail — let the chain settle).
    await flushMicrotasks()
    expect(storedRoom(recovered[0]?.roomId ?? '').messages).toHaveLength(1)

    // Contrast pin: the SAME ancient envelope through the LIVE path is
    // dropped by the freshness window (and by dedup — already seen).
    room.receive('chat', ancient, 'peer-1')
    expect(storedRoom(recovered[0]?.roomId ?? '').messages).toHaveLength(1)
  })

  it('appends recovered rows but keeps zero arrival side effects: no unread, no mention, no receipt, no typing', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()
    const mention = vi.fn()
    manager.onMentionReceived(mention)
    const ownNick = manager.getSessionIdentity()?.identity.nickname as string

    room.receive('hist', { batch: [chatEnvelope({ body: `hola @${ownNick}` })] }, 'peer-1')
    expect(recovered).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)

    // Phase 3: the row IS appended (flagged recovered), but the arrival is
    // silent at store level — the mention in the body must not notify, no
    // badge, no receipt (✓✓ means LIVE delivery), no typing flag.
    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(1)
    expect(messages[0]?.recovered).toBe(true)
    expect(storedRoom(roomId).unread).toBe(0)
    expect(storedRoom(roomId).typing).toEqual({})
    expect(mention).not.toHaveBeenCalled()
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('dedups a replayed batch and a later LIVE resend of the same id', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()

    const shared = chatEnvelope({ ts: Date.now() })
    room.receive('hist', { batch: [shared] }, 'peer-1')
    await flushMicrotasks() // the recovered append is an async tail
    expect(recovered).toHaveLength(1)
    expect(storedRoom(roomId).messages).toHaveLength(1)
    // Replay of the whole batch: every id already seen — no listener call,
    // no second append.
    room.receive('hist', { batch: [shared] }, 'peer-1')
    await flushMicrotasks()
    expect(recovered).toHaveLength(1)
    expect(storedRoom(roomId).messages).toHaveLength(1)

    // The issue's pin: a later LIVE resend of the same id dedups through the
    // live path's shouldProcess (the batch marked it seen) — no double
    // append even though the recovered row now exists.
    room.receive('chat', shared, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(1)
  })

  it('dedups the other way: a live-seen id is dropped from a later batch', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const { recovered } = collectHistDeliveries()

    const live = chatEnvelope({ ts: Date.now() })
    room.receive('chat', live, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(1)

    room.receive('hist', { batch: [live] }, 'peer-1')
    expect(recovered).toHaveLength(0) // fully deduped: no listener call
    expect(storedRoom(roomId).messages).toHaveLength(1)
  })

  it('caps at HISTORY_RATE_CAP batches per rolling minute per peer', async () => {
    const { room } = await join('lobby')
    room.peerJoin('peer-1')
    room.peerJoin('peer-2')
    const { recovered } = collectHistDeliveries()

    for (let i = 0; i < HISTORY_RATE_CAP; i++) {
      room.receive('hist', { batch: [chatEnvelope({ id: `id-${i}`, ts: Date.now() })] }, 'peer-1')
    }
    expect(recovered).toHaveLength(HISTORY_RATE_CAP)
    // 7th batch within the window: dropped by the rate cap (fresh ids, so
    // only the cap can drop it).
    room.receive('hist', { batch: [chatEnvelope({ id: 'id-over', ts: Date.now() })] }, 'peer-1')
    expect(recovered).toHaveLength(HISTORY_RATE_CAP)
    // peer-2 has its own budget.
    room.receive('hist', { batch: [chatEnvelope({ id: 'id-other', ts: Date.now() })] }, 'peer-2')
    expect(recovered).toHaveLength(HISTORY_RATE_CAP + 1)
    expect(recovered[recovered.length - 1]?.roomId).toBe(recovered[0]?.roomId)

    await vi.advanceTimersByTimeAsync(HISTORY_RATE_WINDOW_MS + 1)
    room.receive('hist', { batch: [chatEnvelope({ id: 'id-after', ts: Date.now() })] }, 'peer-1')
    expect(recovered).toHaveLength(HISTORY_RATE_CAP + 2)
  })

  it('drops a muted sharer batch before validation and rate cap', async () => {
    const { room, roomId } = await join('lobby')
    const muted = await makeFakeRemotePeer('peer-muted')
    expect(useSettingsStore.getState().muteFingerprint(muted.fingerprint, 'molesto')).toBe(true)
    // Keys-only join: the same arming trick as the hist-req mute test.
    room.peerJoin(muted.id)
    room.receive('keys', muted.rawPublicKey, muted.id)
    await vi.waitFor(() => {
      expect(storedRoom(roomId).peers.find((peer) => peer.id === muted.id)?.fingerprint).toBe(
        muted.fingerprint,
      )
    })
    const { recovered } = collectHistDeliveries()

    room.receive('hist', { batch: [chatEnvelope({ from: muted.id, ts: Date.now() })] }, muted.id)
    expect(recovered).toHaveLength(0)
  })
})

describe('issue #102 — sendHistory (sanitize, chat-only, chunking, sealing)', () => {
  it('refuses unknown or not-connected rooms without sending', async () => {
    expect(await manager.sendHistory('nope', [])).toBe(0)
    const { room, roomId } = await join('lobby') // searching
    expect(await manager.sendHistory(roomId, [chatEnvelope()])).toBe(0)
    expect(room.action('hist').sends).toHaveLength(0)
  })

  it('filters to chat-only and re-validates each envelope', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const good = chatEnvelope({ id: 'id-good' })

    expect(
      await manager.sendHistory(roomId, [
        good,
        { ...good, id: 'id-dm', kind: 'dm', to: 'peer-2' }, // never gossiped
        { ...good, id: 'id-v3', v: 3 }, // malformed for a chat
        { ...good, id: 'id-fat', body: 'a'.repeat(4001) }, // over the body cap
      ]),
    ).toBe(1)
    const send = room.lastSend('hist')
    expect(send.data).toEqual({ batch: [good] })
    expect(send.options).toBeUndefined() // broadcast, room scope
  })

  it('returns 0 and sends nothing when nothing survives sanitization', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const dm = { ...chatEnvelope(), kind: 'dm' as const, to: 'peer-2' }

    expect(await manager.sendHistory(roomId, [])).toBe(0)
    expect(await manager.sendHistory(roomId, [dm])).toBe(0)
    expect(room.action('hist').sends).toHaveLength(0)
  })

  it('truncates the input to the first 50 and chunks by count', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const fiftyFive = Array.from({ length: MAX_HISTORY_REQUEST + 5 }, (_, i) =>
      chatEnvelope({ id: `id-${i}`, body: `m-${i}` }),
    )

    expect(await manager.sendHistory(roomId, fiftyFive)).toBe(3)
    const sends = room.action('hist').sends
    expect(sends.map((send) => (send.data as { batch: Envelope[] }).batch.length)).toEqual([
      20, 20, 10,
    ])
    // Truncation keeps the FIRST 50, in input order.
    const bodies = sends
      .flatMap((send) => (send.data as { batch: Envelope[] }).batch)
      .map((envelope) => envelope.body)
    expect(bodies).toEqual(Array.from({ length: MAX_HISTORY_REQUEST }, (_, i) => `m-${i}`))
  })

  it('chunks fat envelopes by measured encoded size under the margin', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    // 13 × 4000-char bodies ≈ 54 KB encoded: a single count-batch would be
    // over the 48 KiB margin, so size must split before the count cap.
    const fat = Array.from({ length: 13 }, (_, i) =>
      chatEnvelope({ id: `id-${i}`, body: 'a'.repeat(4000) }),
    )

    expect(await manager.sendHistory(roomId, fat)).toBeGreaterThanOrEqual(2)
    const sends = room.action('hist').sends
    const delivered = sends.flatMap((send) => (send.data as { batch: Envelope[] }).batch)
    expect(delivered).toEqual(fat) // order preserved across batches
    for (const send of sends) {
      const batch = (send.data as { batch: Envelope[] }).batch
      expect(batch.length).toBeLessThanOrEqual(MAX_HISTORY_BATCH)
      expect(histPayloadBytes(send.data)).toBeLessThanOrEqual(MAX_HISTORY_BATCH_BYTES)
    }
  })

  it('re-seals plaintext bodies with the room key in a password room', async () => {
    const { room, roomId } = await join('privada', 'clave-secreta')
    room.peerJoin('peer-1')
    const secret = chatEnvelope({ id: 'id-sec', body: 'mensaje secreto' })
    const alreadySealed = chatEnvelope({
      id: 'id-wire',
      enc: true,
      iv: 'AAAA',
      body: 'a'.repeat(100),
    })

    expect(await manager.sendHistory(roomId, [secret, alreadySealed])).toBe(1)
    const batch = (room.lastSend('hist').data as { batch: Envelope[] }).batch
    expect(batch).toHaveLength(2)

    // The plaintext body was sealed; the already-wire-form passed through
    // untouched (no double seal).
    const sealed = batch[0] as Envelope
    expect(sealed.id).toBe('id-sec')
    expect(sealed.enc).toBe(true)
    expect(sealed.iv).not.toBeNull()
    expect(sealed.body).not.toBe('mensaje secreto')
    expect(batch[1]).toEqual(alreadySealed)

    // The joining peer's room key (same password) opens it: recovered
    // ciphertext decrypts for free.
    const key = await deriveRoomKey('clave-secreta', 'privada')
    const text = await decryptRoomMessage(key, { iv: sealed.iv ?? '', payload: sealed.body })
    expect(text).toBe('mensaje secreto')
  })
})

// ---------------------------------------------------------------------------
// Issue #102 phase 2 — the consent layer. The module-level
// respondToHistoryRequest wiring answers a DELIVERED hist-req only while
// `gritos:settings`.shareHistory is on; the default (and any mid-session
// toggle-off) is enforced silence, so no hist ever leaves for any trigger.
// With consent the share is the last n ≤ 50 chat rows of the in-memory
// feed — never system lines, encrypted placeholders or already-expired
// rows — handed to the phase-1 sendHistory (which re-validates and
// re-seals). The onRecovered append path stays unwired (phase 3).
// ---------------------------------------------------------------------------

/** All envelopes the fake room has gossiped so far, across batches. */
function gossipedEnvelopes(
  room: ReturnType<typeof installFakeTrystero>['rooms'][number],
): Envelope[] {
  return room.action('hist').sends.flatMap((send) => (send.data as { batch: Envelope[] }).batch)
}

describe('issue #102 phase 2 — consent layer (shareHistory honoring)', () => {
  it('toggle off (default): no hist is ever sent, fresh request or repeat', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    // A non-empty feed changes nothing: the consent gate fires first.
    manager.sendChat(roomId, 'visible')
    expect(useSettingsStore.getState().settings.shareHistory).toBe(false)

    // Trigger 1: a fresh, valid request.
    room.receive('hist-req', { n: 10 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room.action('hist').sends).toHaveLength(0)

    // Trigger 2: a repeat ask once the rate window rolled off (it reaches
    // the honoring layer fresh): still silence.
    await vi.advanceTimersByTimeAsync(HISTORY_REQ_RATE_WINDOW_MS + 1)
    room.receive('hist-req', { n: 10 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room.action('hist').sends).toHaveLength(0)
  })

  it('toggling off mid-session stops answering immediately', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    manager.sendChat(roomId, 'hola')
    useSettingsStore.getState().setSettings({ shareHistory: true })
    room.receive('hist-req', { n: 5 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room.action('hist').sends).toHaveLength(1)

    useSettingsStore.getState().setSettings({ shareHistory: false })
    await vi.advanceTimersByTimeAsync(HISTORY_REQ_RATE_WINDOW_MS + 1)
    room.receive('hist-req', { n: 5 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room.action('hist').sends).toHaveLength(1) // no new batch
  })

  it('with consent: answers with the last ≤50 chat messages, in feed order', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    useSettingsStore.getState().setSettings({ shareHistory: true })
    for (let i = 0; i < MAX_HISTORY_REQUEST + 5; i++) {
      manager.sendChat(roomId, `m-${i}`)
    }

    room.receive('hist-req', { n: MAX_HISTORY_REQUEST }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)

    const delivered = gossipedEnvelopes(room)
    // The 50-cap is enforced even though the feed could only ever offer
    // 500 (the FIFO cap): exactly the LAST 50 rows go out.
    expect(delivered).toHaveLength(MAX_HISTORY_REQUEST)
    expect(delivered.map((envelope) => envelope.body)).toEqual(
      Array.from({ length: MAX_HISTORY_REQUEST }, (_, i) => `m-${i + 5}`),
    )
    // Rebuilt chat wire forms: plaintext v1, room scope.
    for (const envelope of delivered) {
      expect(envelope.kind).toBe('chat')
      expect(envelope.enc).toBe(false)
      expect(envelope.v).toBe(1)
    }
  })

  it('honors the requested n instead of always sending the full 50', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    useSettingsStore.getState().setSettings({ shareHistory: true })
    for (let i = 0; i < 10; i++) {
      manager.sendChat(roomId, `m-${i}`)
    }

    room.receive('hist-req', { n: 3 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gossipedEnvelopes(room).map((envelope) => envelope.body)).toEqual(['m-7', 'm-8', 'm-9'])
  })

  it('filters system lines, encrypted placeholders and already-expired rows', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    useSettingsStore.getState().setSettings({ shareHistory: true })

    const first = manager.sendChat(roomId, 'primero')
    // Local feed furniture: a system line never gossips.
    useAppStore.getState().appendMessage(roomId, {
      id: 'sys-1',
      roomId,
      authorId: 'system',
      authorNick: '',
      text: 'peer-1 joined',
      ts: Date.now(),
      encrypted: false,
      status: 'delivered',
      kind: 'system',
    })
    // Undecryptable placeholder row: neither its plaintext nor the original
    // ciphertext is held, so there is nothing honest to forward.
    useAppStore.getState().appendMessage(roomId, {
      id: 'enc-1',
      roomId,
      authorId: 'peer-1',
      authorNick: 'x',
      text: '🔒 encrypted message',
      ts: Date.now(),
      encrypted: true,
      status: 'delivered',
      kind: 'user',
    })
    // Already-expired row still sitting in the feed between sweep ticks.
    useAppStore.getState().appendMessage(roomId, {
      id: 'exp-1',
      roomId,
      authorId: 'self',
      authorNick: 'yo',
      text: 'caducado',
      ts: Date.now(),
      encrypted: false,
      status: 'sent',
      expiresAt: Date.now() - 1,
    })
    // A live TTL row is NOT expired: it shares (as session-lived — the
    // author's ttl seconds are not recoverable from the store).
    useAppStore.getState().appendMessage(roomId, {
      id: 'ttl-1',
      roomId,
      authorId: 'self',
      authorNick: 'yo',
      text: 'efimero',
      ts: Date.now(),
      encrypted: false,
      status: 'sent',
      expiresAt: Date.now() + 60_000,
    })
    const last = manager.sendChat(roomId, 'ultimo')

    room.receive('hist-req', { n: 50 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gossipedEnvelopes(room).map((envelope) => envelope.id)).toEqual([
      first?.id,
      'ttl-1',
      last?.id,
    ])
  })

  it('an empty (or foreign) feed stays silent: the share is scoped to the requesting room', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const other = await join('dev')
    useSettingsStore.getState().setSettings({ shareHistory: true })
    // Only lobby holds rows; DMs never enter a room feed at all.
    manager.sendChat(roomId, 'de lobby')

    // A request in the empty room shares nothing.
    other.room.peerJoin('peer-2')
    other.room.receive('hist-req', { n: 50 }, 'peer-2')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(other.room.action('hist').sends).toHaveLength(0)

    // The lobby request shares only lobby rows.
    room.receive('hist-req', { n: 50 }, 'peer-1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(gossipedEnvelopes(room).map((envelope) => envelope.body)).toEqual(['de lobby'])
  })

  it('password rooms: the honored share re-seals bodies with the room key', async () => {
    const { room, roomId } = await join('privada', 'clave-secreta')
    room.peerJoin('peer-1')
    useSettingsStore.getState().setSettings({ shareHistory: true })
    const first = manager.sendChat(roomId, 'mensaje secreto')
    manager.sendChat(roomId, 'segundo')

    room.receive('hist-req', { n: 10 }, 'peer-1')
    // The PBKDF2 key derivation and the re-sealing are real async work on a
    // fire-and-forget promise: wait for the batches to land on the wire.
    await vi.waitFor(() => expect(room.action('hist').sends).toHaveLength(1))

    const delivered = gossipedEnvelopes(room)
    expect(delivered).toHaveLength(2)
    // The stored plaintext left re-sealed (fresh IVs), never as plaintext.
    expect(delivered[0]?.id).toBe(first?.id)
    expect(delivered[0]?.enc).toBe(true)
    expect(delivered[0]?.body).not.toBe('mensaje secreto')
    // Only a same-password peer can read it back.
    const key = await deriveRoomKey('clave-secreta', 'privada')
    const text = await decryptRoomMessage(key, {
      iv: delivered[0]?.iv ?? '',
      payload: delivered[0]?.body ?? '',
    })
    expect(text).toBe('mensaje secreto')
  })
})

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the request UX's transport seam (requestHistory, the
// [Ask] button) and the recovered-state append wiring (onRecovered →
// store). The card dismisses on tap; the manager's per-room ask budget
// rate-limits repeat joins. Recovered batches append in wire order as
// `recovered: true` rows under the latched separator counter — never
// badging, never notifying, never receipting — with the recipient-side
// 50-per-join cap, the muted-AUTHOR gate (fail-open for unknown authors)
// and receiver-clock TTL expiry mirrored from the live path.
// ---------------------------------------------------------------------------

describe('issue #102 phase 3 — requestHistory (the [Ask] transport)', () => {
  it('refuses an unknown room without throwing', () => {
    expect(manager.requestHistory('nope')).toBe(false)
  })

  it('broadcasts hist-req {n: 50} on a connected room', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    expect(manager.requestHistory(roomId)).toBe(true)
    const send = room.lastSend('hist-req')
    expect(send.data).toEqual({ n: MAX_HISTORY_REQUEST })
    expect(send.options).toBeUndefined() // broadcast: every consenting peer may answer
  })

  it('parks the ask while the room is still searching and flushes it on the first peer join', async () => {
    const { room, roomId } = await join('lobby') // searching

    expect(manager.requestHistory(roomId)).toBe(true)
    expect(room.action('hist-req').sends).toHaveLength(0)

    room.peerJoin('peer-1')
    expect(room.lastSend('hist-req').data).toEqual({ n: MAX_HISTORY_REQUEST })

    // The flush is one-shot: a later peer join repeats nothing, and the
    // immediate next ask is budget-dropped (the park consumed it).
    room.peerJoin('peer-2')
    expect(room.action('hist-req').sends).toHaveLength(1)
    expect(manager.requestHistory(roomId)).toBe(false)
  })

  it('rate-caps the card flow: a second ask within the window is dropped', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    expect(manager.requestHistory(roomId)).toBe(true)
    expect(manager.requestHistory(roomId)).toBe(false) // inside the window
    expect(room.action('hist-req').sends).toHaveLength(1)

    // After the window rolls off, a fresh join (or a still-joined tab) may
    // ask again.
    await vi.advanceTimersByTimeAsync(HISTORY_ASK_RATE_WINDOW_MS + 1)
    expect(manager.requestHistory(roomId)).toBe(true)
    expect(room.action('hist-req').sends).toHaveLength(2)
    expect(HISTORY_ASK_RATE_CAP).toBe(1)
  })

  it('refuses an out-of-bounds n without consuming the budget', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')

    expect(manager.requestHistory(roomId, 0)).toBe(false)
    expect(manager.requestHistory(roomId, MAX_HISTORY_REQUEST + 1)).toBe(false)
    expect(room.action('hist-req').sends).toHaveLength(0)

    // The violations burned no budget: the first valid ask still goes out.
    expect(manager.requestHistory(roomId)).toBe(true)
    expect(room.lastSend('hist-req').data).toEqual({ n: MAX_HISTORY_REQUEST })
  })

  it('a leave/rejoin starts a fresh connection and thus a fresh ask budget', async () => {
    const first = await join('lobby')
    first.room.peerJoin('peer-1')
    expect(manager.requestHistory(first.roomId)).toBe(true)
    expect(manager.requestHistory(first.roomId)).toBe(false)

    await manager.leaveRoom(first.roomId)
    const second = await join('lobby')
    second.room.peerJoin('peer-1')
    expect(manager.requestHistory(second.roomId)).toBe(true)
    expect(second.room.action('hist-req').sends).toHaveLength(1)
  })
})

describe('issue #102 phase 3 — recovered append (onRecovered → store)', () => {
  it('appends a batch in wire order as recovered rows, author ts preserved', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const old = Date.now() - 3_600_000
    const a = chatEnvelope({ id: 'id-a', ts: old, body: 'primero', nick: 'autor-a' })
    const b = chatEnvelope({ id: 'id-b', ts: old - 5_000, body: 'segundo', nick: 'autor-b' })

    room.receive('hist', { batch: [a, b] }, 'peer-1')
    await flushMicrotasks()

    const messages = storedRoom(roomId).messages
    // Batch (wire) order — the §7.3 2 s ts-window does NOT reorder a replay.
    expect(messages.map((message) => message.id)).toEqual(['id-a', 'id-b'])
    expect(messages[0]).toMatchObject({
      authorId: a.from,
      authorNick: 'autor-a',
      recovered: true,
      kind: 'user',
      encrypted: false,
      status: 'delivered',
    })
    expect(messages[0]?.text).toBe('primero')
    expect(messages[0]?.ts).toBe(old) // author ts preserved for display
    expect(storedRoom(roomId).recoveredCount).toBe(2)
  })

  it('keeps recoveredCount latched across FIFO trims (separator semantics)', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const batch = Array.from({ length: 20 }, (_, i) =>
      chatEnvelope({ id: `id-${i}`, ts: Date.now() - 3_600_000 }),
    )
    room.receive('hist', { batch }, 'peer-1')
    await flushMicrotasks()
    expect(storedRoom(roomId).recoveredCount).toBe(20)

    // Fill the feed to the cap and force trims with live rows: the counter
    // never decrements (expiredCount semantics).
    for (let i = 0; i < 490; i += 1) {
      manager.sendChat(roomId, `live-${i}`)
    }
    for (let i = 0; i < 15; i += 1) {
      manager.sendChat(roomId, `trim-${i}`)
    }
    const roomState = storedRoom(roomId)
    expect(roomState.messages).toHaveLength(500)
    expect(roomState.fifoTrimmed).toBe(true)
    expect(roomState.recoveredCount).toBe(20)
  })

  it('enforces the 50-per-join recipient cap: 55 arrive, 50 are appended, the rest drop silently', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const ids = Array.from({ length: 55 }, (_, i) => `id-${i}`)
    const envelopes = ids.map((id, i) => chatEnvelope({ id, ts: Date.now() - 3_600_000 + i }))

    for (let i = 0; i < 55; i += MAX_HISTORY_BATCH) {
      room.receive('hist', { batch: envelopes.slice(i, i + MAX_HISTORY_BATCH) }, 'peer-1')
    }
    await flushMicrotasks()

    const messages = storedRoom(roomId).messages
    expect(messages).toHaveLength(50)
    expect(messages.map((message) => message.id)).toEqual(ids.slice(0, 50))
    expect(storedRoom(roomId).recoveredCount).toBe(50)

    // Documented cost of the cap: the transport already marked the excess
    // ids seen, so even a LIVE resend of a dropped envelope dedups.
    room.receive('chat', envelopes[54]!, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(50)

    // Later batches in the same join session are dropped too.
    room.receive('hist', { batch: [chatEnvelope({ id: 'id-later', ts: Date.now() })] }, 'peer-1')
    await flushMicrotasks()
    expect(storedRoom(roomId).messages).toHaveLength(50)
  })

  it('resets the recipient cap per join session (leave + rejoin accepts again)', async () => {
    const first = await join('lobby')
    first.room.peerJoin('peer-1')
    const fullBatch = Array.from({ length: MAX_RECOVERED_PER_JOIN }, (_, i) =>
      chatEnvelope({ id: `first-${i}`, ts: Date.now() - 3_600_000 }),
    )
    first.room.receive('hist', { batch: fullBatch.slice(0, MAX_HISTORY_BATCH) }, 'peer-1')
    first.room.receive(
      'hist',
      { batch: fullBatch.slice(MAX_HISTORY_BATCH, 2 * MAX_HISTORY_BATCH) },
      'peer-1',
    )
    first.room.receive('hist', { batch: fullBatch.slice(2 * MAX_HISTORY_BATCH) }, 'peer-1')
    await flushMicrotasks()
    expect(storedRoom(first.roomId).messages).toHaveLength(MAX_RECOVERED_PER_JOIN)
    first.room.receive(
      'hist',
      { batch: [chatEnvelope({ id: 'overflow', ts: Date.now() })] },
      'peer-1',
    )
    await flushMicrotasks()
    expect(storedRoom(first.roomId).messages).toHaveLength(MAX_RECOVERED_PER_JOIN)

    await manager.leaveRoom(first.roomId)
    const second = await join('lobby')
    second.room.peerJoin('peer-1')
    second.room.receive(
      'hist',
      { batch: [chatEnvelope({ id: 'fresh-join', ts: Date.now() - 1000 })] },
      'peer-1',
    )
    await flushMicrotasks()
    expect(storedRoom(second.roomId).messages.map((message) => message.id)).toEqual(['fresh-join'])
  })

  it('drops a muted AUTHOR by its from-peerId and fails open for unknown authors', async () => {
    const { room, roomId } = await join('lobby')
    const author = await makeFakeRemotePeer('peer-autor')
    room.peerJoin(author.id)
    room.peerJoin('peer-1')
    room.receive('keys', author.rawPublicKey, author.id)
    await vi.waitFor(() => {
      expect(storedRoom(roomId).peers.find((peer) => peer.id === author.id)?.fingerprint).toBe(
        author.fingerprint,
      )
    })

    // The AUTHOR's identity fingerprint is muted — the sharer (peer-1) is
    // not. The recovered gate resolves `envelope.from` through the
    // delivering connection's peerKeyFps.
    expect(useSettingsStore.getState().muteFingerprint(author.fingerprint, 'molesto')).toBe(true)

    room.receive(
      'hist',
      {
        batch: [
          chatEnvelope({ id: 'id-muted', from: author.id, ts: Date.now() - 3_600_000 }),
          chatEnvelope({ id: 'id-ghost', from: 'peer-desconocido', ts: Date.now() - 3_600_000 }),
        ],
      },
      'peer-1',
    )
    await flushMicrotasks()

    const ids = storedRoom(roomId).messages.map((message) => message.id)
    expect(ids).toEqual(['id-ghost']) // unknown author → fail-open, like the live path
  })

  it('gives TTL rows a receiver-clock expiresAt the sweep honors', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const authored = Date.now() - 3_600_000 // ancient: recovery's whole point
    room.receive(
      'hist',
      { batch: [chatEnvelope({ id: 'id-ttl', ts: authored, ttl: 30 })] },
      'peer-1',
    )
    await flushMicrotasks()

    const row = storedRoom(roomId).messages[0]
    // Receiver clock at the append, never the author ts (issue #96 parity:
    // recovery cannot resurrect a zombie TTL message on the author's clock).
    expect(row?.expiresAt).toBe(Date.now() + 30_000)

    // The sweep removes it at the due instant, like any TTL row.
    manager.pruneExpiredMessages(Date.now() + 30_000)
    expect(storedRoom(roomId).messages).toHaveLength(0)
    expect(storedRoom(roomId).expiredCount).toBe(1)
    // The recovered separator stays latched: the rows WERE recovered.
    expect(storedRoom(roomId).recoveredCount).toBe(1)
  })

  it('never resurrects an id this session already expired', async () => {
    const { room, roomId } = await join('lobby')
    room.peerJoin('peer-1')
    const doomed = chatEnvelope({ id: 'id-doomed', ttl: 30 })
    room.receive('chat', doomed, 'peer-1')
    expect(storedRoom(roomId).messages).toHaveLength(1)
    manager.pruneExpiredMessages(Date.now() + 31_000)
    expect(storedRoom(roomId).messages).toHaveLength(0)

    // The same envelope gossiped back afterwards: dropped before any append.
    room.receive('hist', { batch: [doomed] }, 'peer-1')
    await flushMicrotasks()
    expect(storedRoom(roomId).messages).toHaveLength(0)
    expect(storedRoom(roomId).recoveredCount).toBe(0)
  })

  it('opens password-room recovered ciphertext with the room key, in batch order', async () => {
    const { room, roomId } = await join('privada', 'clave-secreta')
    room.peerJoin('peer-1')
    const key = await deriveRoomKey('clave-secreta', 'privada')
    const seal = async (text: string) => await encryptRoomMessage(key, text)
    const wire = async (id: string, text: string): Promise<Envelope> => {
      const sealed = await seal(text)
      return chatEnvelope({ id, enc: true, iv: sealed.iv, body: sealed.payload })
    }
    const first = await wire('id-1', 'secreto uno')
    const second = await wire('id-2', 'secreto dos')

    // Two batches: the per-connection chain must keep wire order even
    // though the decryptions settle asynchronously (real crypto — see the
    // helper).
    room.receive('hist', { batch: [first] }, 'peer-1')
    room.receive('hist', { batch: [second] }, 'peer-1')
    await untilRecoveredSettled(() => {
      expect(storedRoom(roomId).messages.map((message) => message.id)).toEqual(['id-1', 'id-2'])
    })

    const messages = storedRoom(roomId).messages
    expect(messages[0]?.text).toBe('secreto uno')
    expect(messages[0]?.encrypted).toBe(false) // stored plaintext, never ciphertext
    expect(messages[0]?.recovered).toBe(true)

    // An undecryptable recovered envelope becomes the placeholder (issue
    // #21/#61 convention), never raw ciphertext as text.
    const corrupt = chatEnvelope({ id: 'id-3', enc: true, iv: 'AAAA', body: 'no-es-base64!' })
    room.receive('hist', { batch: [corrupt] }, 'peer-1')
    await untilRecoveredSettled(() => {
      expect(storedRoom(roomId).messages.at(-1)?.id).toBe('id-3')
    })
    const last = storedRoom(roomId).messages.at(-1)
    expect(last?.encrypted).toBe(true)
    expect(last?.text).toBe('🔒 encrypted message')
  })
})
