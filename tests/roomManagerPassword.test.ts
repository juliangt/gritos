import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { deriveRoomId, sha256Hex } from '../src/lib/crypto/hashes'
import {
  base64ToBytes,
  bytesToBase64,
} from '../src/lib/crypto/dm'
import {
  decryptRoomMessage,
  deriveRoomKey,
  encryptRoomMessage,
} from '../src/lib/crypto/roomKey'
import { createEnvelope, type Envelope } from '../src/lib/p2p/protocol'
import { ENCRYPTED_MESSAGE_PLACEHOLDER } from '../src/lib/rooms'
import { formatFingerprint } from '../src/lib/crypto/identity'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * M4 — password-room flow over the fake Trystero mesh (RF-05, §9.3/§9.4,
 * §6.4 step 4). The manager under test plays peer B; the tests play peer A,
 * sealing real envelopes with the shared room key derived independently.
 */

const PASSWORD = 'piedra-papel'
const ROOM = 'secreta'

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  // Real timers: the seal/open paths chain Web Crypto (PBKDF2 600k + AES-GCM)
  // roundtrips that vitest fake timers do not pump; the debounced receipt
  // below waits real milliseconds.
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
})

/** Lets the async encrypt/decrypt/store tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

function waitForReceiptDebounce(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, manager.RECEIPT_DEBOUNCE_MS + 150))
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

/** Joins the manager (peer B) into `ROOM` with the shared password. */
async function joinB(): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(ROOM, PASSWORD)
  return { roomId: connection.roomId, room: fake.rooms[fake.rooms.length - 1] }
}

/** Seals a chat envelope as remote peer A would (same name+password). */
async function sealFromA(text: string): Promise<Envelope> {
  const key = await deriveRoomKey(PASSWORD, ROOM)
  const sealed = await encryptRoomMessage(key, text)
  return createEnvelope({
    from: 'peer-a',
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: true,
    iv: sealed.iv,
    body: sealed.payload,
  })
}

/**
 * Issue #21 — seals `text` with the shared room key via raw crypto.subtle,
 * BYPASSING encryptRoomMessage's send-side 4000-char cap (which only binds
 * honest clients): what a key-holding malicious peer can produce.
 */
async function sealFromARaw(text: string): Promise<Envelope> {
  const key = await deriveRoomKey(PASSWORD, ROOM)
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
    from: 'peer-a',
    nick: 'zorro-bravo',
    kind: 'chat',
    enc: true,
    iv: bytesToBase64(iv),
    body: bytesToBase64(combined),
  })
}

describe('joinRoom with password (RF-05, §9.4)', () => {
  it('derives the roomId from name+password and marks the room hasPassword', async () => {
    const { roomId } = await joinB()
    expect(roomId).toBe(await deriveRoomId(ROOM, PASSWORD))
    expect(manager.getRoomConnection(roomId)?.hasPassword).toBe(true)
    expect(storedRoom(roomId).hasPassword).toBe(true)
    expect(storedRoom(roomId).name).toBe(ROOM)
  })

  it('lands wrong-password and no-password joins in DIFFERENT roomIds (they never meet)', async () => {
    const withPassword = await manager.joinRoom(ROOM, PASSWORD)
    const withoutPassword = await manager.joinRoom(ROOM)
    const wrongPassword = await manager.joinRoom(ROOM, 'otra-clave')

    const ids = new Set([withPassword.roomId, withoutPassword.roomId, wrongPassword.roomId])
    expect(ids.size).toBe(3)
    expect(fake.joinRoomFn).toHaveBeenCalledTimes(3)
    // The tracker saw three unrelated hashes; the plaintext room id set
    // never overlaps.
    expect(fake.configs.map((entry) => entry.roomId)).toEqual([
      withPassword.roomId,
      withoutPassword.roomId,
      wrongPassword.roomId,
    ])
  })
})

describe('encrypted chat flow (§6.4 step 4, §9.3)', () => {
  it('seals outgoing chat on the wire and echoes plaintext locally', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')
    const envelope = manager.sendChat(roomId, 'hola en secreto')
    // The first seal waits for the PBKDF2 derivation (~150 ms wall).
    await vi.waitFor(() => expect(room.action('chat').sends).toHaveLength(1))

    const wire = room.lastSend('chat').data as Envelope
    expect(wire.enc).toBe(true)
    expect(wire.id).toBe(envelope?.id)
    expect(wire.body).not.toBe('hola en secreto')
    // Only the holder of the room key can open it back to the plaintext.
    const key = await deriveRoomKey(PASSWORD, ROOM)
    await expect(
      decryptRoomMessage(key, { iv: wire.iv ?? '', payload: wire.body }),
    ).resolves.toBe('hola en secreto')

    const own = storedRoom(roomId).messages.find((message) => message.id === envelope?.id)
    expect(own).toMatchObject({ text: 'hola en secreto', encrypted: false, authorId: 'self' })
  })

  it('two peers with the same password: receiver decrypts, stores plaintext, receipts', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')
    const envelope = await sealFromA('mensaje cifrado de a')
    room.receive('chat', envelope, 'peer-a')
    // The receive tail awaits the connection's key promise + AES-GCM; poll
    // instead of a fixed sleep so parallel PBKDF2 load cannot flake it.
    await vi.waitFor(() => expect(storedRoom(roomId).messages).toHaveLength(1))

    const messages = storedRoom(roomId).messages
    expect(messages[0]).toMatchObject({
      id: envelope.id,
      authorId: 'peer-a',
      authorNick: 'zorro-bravo',
      text: 'mensaje cifrado de a',
      encrypted: false,
      status: 'delivered',
      kind: 'user',
    })

    await waitForReceiptDebounce()
    const receipt = room.lastSend('receipt')
    expect(receipt.data).toEqual({ ids: [envelope.id] })
    expect(receipt.options).toEqual({ target: 'peer-a' })
  })

  it('queues sealed envelopes while searching and flushes them in order on peer join', async () => {
    const { roomId, room } = await joinB()
    // Still 'searching': both sends are queued already sealed.
    const first = manager.sendChat(roomId, 'primero')
    const second = manager.sendChat(roomId, 'segundo')
    expect(room.action('chat').sends).toHaveLength(0)

    room.peerJoin('peer-a')
    await vi.waitFor(() => expect(room.action('chat').sends).toHaveLength(2))

    const sends = room.action('chat').sends
    expect(sends).toHaveLength(2)
    expect((sends[0]?.data as Envelope).id).toBe(first?.id)
    expect((sends[1]?.data as Envelope).id).toBe(second?.id)
    const key = await deriveRoomKey(PASSWORD, ROOM)
    const opened = await Promise.all(
      sends.map((send) =>
        decryptRoomMessage(key, {
          iv: (send.data as Envelope).iv ?? '',
          payload: (send.data as Envelope).body,
        }),
      ),
    )
    expect(opened).toEqual(['primero', 'segundo'])
  })

  it('keeps typing, receipts and presence plaintext in password rooms', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')

    manager.sendTyping(roomId, true)
    expect(room.lastSend('typing').data).toEqual({ on: true })

    const rawKey = new Uint8Array(65).fill(3)
    room.receive('presence', { nick: 'zorro-bravo', fp: 'A31F 09BC 77D2 4E5A' }, 'peer-a')
    room.receive('keys', rawKey, 'peer-a')
    // The trusted fingerprint is the one derived from the `keys` payload
    // (§9.1 hardening), not the announced presence value.
    const expectedFp = formatFingerprint(await sha256Hex(rawKey))
    await vi.waitFor(() =>
      expect(storedRoom(roomId).peers[0]).toMatchObject({
        nickname: 'zorro-bravo',
        fingerprint: expectedFp,
      }),
    )
  })
})

describe('undecryptable receives (RF-05 placeholder, §7.3)', () => {
  it('discards encrypted chats arriving in a PUBLIC room (no key exists)', async () => {
    const connection = await manager.joinRoom('publica')
    const room = fake.rooms[fake.rooms.length - 1]
    room.peerJoin('peer-a')
    const sealed = await encryptRoomMessage(
      await deriveRoomKey(PASSWORD, ROOM),
      'intento sin clave',
    )
    const envelope = createEnvelope({
      from: 'peer-a',
      nick: 'zorro-bravo',
      kind: 'chat',
      enc: true,
      iv: sealed.iv,
      body: sealed.payload,
    })
    room.receive('chat', envelope, 'peer-a')
    await flushCrypto()

    expect(storedRoom(connection.roomId).messages).toHaveLength(0)
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('a tampered payload stores the placeholder "🔒 mensaje cifrado", never the ciphertext', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')
    const sealed = await encryptRoomMessage(await deriveRoomKey(PASSWORD, ROOM), 'original-privado')
    const blob = base64ToBytes(sealed.payload)
    blob[blob.length - 1] ^= 0x01
    const envelope = createEnvelope({
      from: 'peer-a',
      nick: 'zorro-bravo',
      kind: 'chat',
      enc: true,
      iv: sealed.iv,
      body: bytesToBase64(blob),
    })
    room.receive('chat', envelope, 'peer-a')
    // Placeholder path is async too (failed open after the key resolved).
    await vi.waitFor(() => expect(storedRoom(roomId).messages).toHaveLength(1))

    const messages = storedRoom(roomId).messages
    expect(messages[0]).toMatchObject({
      id: envelope.id,
      authorId: 'peer-a',
      text: ENCRYPTED_MESSAGE_PLACEHOLDER,
      encrypted: true,
    })
    // The raw ciphertext never leaks into the store as text.
    expect(messages[0]?.text).not.toContain('original-privado')
    expect(JSON.stringify(messages)).not.toContain(sealed.payload)

    // Delivery (not readability) is what receipts answer.
    await waitForReceiptDebounce()
    expect(room.lastSend('receipt').data).toEqual({ ids: [envelope.id] })
  })
})

// ---------------------------------------------------------------------------
// Issue #21 — envelope size caps at the receive boundary: a ciphertext bomb
// is discarded by parseEnvelope before any decode, and a validly sealed
// plaintext beyond the §7.3 limit (forged by a key-holding peer) is
// discarded after decrypt instead of landing in the store.
// ---------------------------------------------------------------------------

describe('receive size caps (issue #21)', () => {
  it('discards a ciphertext bomb before any decode: no store entry, no receipt, no atob', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')

    // Transport-sized body (100 KB ≫ the 16 384-char cap): the same flood
    // shape a malicious peer would send.
    const bomb = await sealFromA('x')
    bomb.body = 'a'.repeat(100_000)

    const atobSpy = vi.spyOn(globalThis, 'atob')
    try {
      room.receive('chat', bomb, 'peer-a')
      // parseEnvelope rejects synchronously: nothing decoded, nothing stored.
      expect(atobSpy).not.toHaveBeenCalled()
    } finally {
      atobSpy.mockRestore()
    }
    expect(storedRoom(roomId).messages).toHaveLength(0)

    await waitForReceiptDebounce()
    expect(room.action('receipt').sends).toHaveLength(0)
  })

  it('discards a decrypted plaintext above the 4000-char limit (never stored)', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')

    // 4001 chars seals to ~5.4 KB of base64: inside the ciphertext cap, so
    // only the post-decrypt limit can reject it.
    const envelope = await sealFromARaw('a'.repeat(4001))
    room.receive('chat', envelope, 'peer-a')
    await vi.waitFor(() => expect(room.action('receipt').sends).toHaveLength(1))

    // Nothing reached the store — not the text, not the placeholder.
    expect(storedRoom(roomId).messages).toHaveLength(0)

    // Receipting is about transport, not readability (§7.1): the debounced
    // receipt above still answered the delivery.
    expect(room.lastSend('receipt').data).toEqual({ ids: [envelope.id] })
  })

  it('still stores a validly sealed plaintext at the 4000-char limit', async () => {
    const { roomId, room } = await joinB()
    room.peerJoin('peer-a')

    const envelope = await sealFromARaw('a'.repeat(4000))
    room.receive('chat', envelope, 'peer-a')
    await vi.waitFor(() => expect(storedRoom(roomId).messages).toHaveLength(1))
    expect(storedRoom(roomId).messages[0]).toMatchObject({
      id: envelope.id,
      text: 'a'.repeat(4000),
      encrypted: false,
    })
  })
})

describe('key lifecycle (RF-05: memory only)', () => {
  it('reconnectAll re-joins password rooms re-deriving the SAME key (RF-07 + RF-05)', async () => {
    const first = await joinB()
    first.room.peerJoin('peer-a')

    // Network settings change, then the RF-07 "Reconectar todo" path.
    const { useSettingsStore } = await import('../src/stores/useSettingsStore')
    useSettingsStore.getState().setSettings({ trackers: ['wss://nuevo.example'] })
    await manager.reconnectAll()

    // The room was left and re-joined through a fresh Trystero room with the
    // new config, and it is still the same (name+password)-derived room.
    expect(first.room.leave).toHaveBeenCalledTimes(1)
    const rejoined = fake.rooms[fake.rooms.length - 1]
    expect(fake.configs[fake.configs.length - 1]?.roomId).toBe(first.roomId)
    expect(fake.configs[fake.configs.length - 1]?.config).toEqual({
      appId: 'gritos-app-v1',
      relayConfig: { urls: ['wss://nuevo.example'] },
    })
    expect(manager.getRoomConnection(first.roomId)?.hasPassword).toBe(true)

    // The in-memory password survived the reconnect: outgoing chat is still
    // sealed with the key derived from the SAME password.
    rejoined.peerJoin('peer-a')
    manager.sendChat(first.roomId, 'tras reconectar')
    await vi.waitFor(() => expect(rejoined.action('chat').sends).toHaveLength(1))
    const wire = rejoined.lastSend('chat').data as Envelope
    expect(wire.enc).toBe(true)
    const key = await deriveRoomKey(PASSWORD, ROOM)
    await expect(
      decryptRoomMessage(key, { iv: wire.iv ?? '', payload: wire.body }),
    ).resolves.toBe('tras reconectar')
  })

  it('leaveRoom discards the key; rejoining re-derives it from the password', async () => {
    const first = await joinB()
    await manager.leaveRoom(first.roomId)
    expect(manager.getRoomConnection(first.roomId)).toBeUndefined()
    expect(useAppStore.getState().rooms[first.roomId]).toBeUndefined()

    const second = await manager.joinRoom(ROOM, PASSWORD)
    expect(second.roomId).toBe(first.roomId)
    const room = fake.rooms[fake.rooms.length - 1]
    room.peerJoin('peer-a')
    manager.sendChat(second.roomId, 'tras volver a entrar')
    await vi.waitFor(() => expect(room.action('chat').sends).toHaveLength(1))
    const wire = room.lastSend('chat').data as Envelope
    expect(wire.enc).toBe(true)
    const key = await deriveRoomKey(PASSWORD, ROOM)
    await expect(
      decryptRoomMessage(key, { iv: wire.iv ?? '', payload: wire.body }),
    ).resolves.toBe('tras volver a entrar')
  })

  it('never exposes the password or the key through the dumped store state', async () => {
    await joinB()
    const dumped = JSON.stringify(useAppStore.getState())
    expect(dumped).not.toContain(PASSWORD)
    expect(dumped).toContain('"hasPassword":true')
  })
})
