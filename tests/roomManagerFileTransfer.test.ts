import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import { base64ToBytes, bytesToBase64, clearDmKeyCache, deriveDmKeyV2 } from '../src/lib/crypto/dm'
import { computeFingerprint } from '../src/lib/crypto/identity'
import { openChunk, sealChunk } from '../src/lib/crypto/chunkCipher'
import { createEnvelope, type Envelope } from '../src/lib/p2p/protocol'
import {
  fakePeerJoins,
  installFakeTrystero,
  makeFakeRemotePeer,
  type FakeRemotePeer,
  type FakeTrysteroRoom,
} from './fakeTrystero'

/**
 * Issue #103 phase 2 (spec §12.4) — `resolveTransferKey`, the thin shim the
 * engine (Phase 3, `lib/p2p/fileTransfer.ts`) will call to obtain the
 * conversation key for a transfer. The manager under test plays peer B; the
 * tests play peer A over the fake Trystero mesh (same harness as the DM and
 * password suites) and verify the resolved key against INDEPENDENT
 * derivations and the live send/receive paths — no extra PBKDF2 is paid
 * beyond the joins themselves.
 */

const PASSWORD = 'piedra-papel'
const ROOM = 'secreta'

let fake: ReturnType<typeof installFakeTrystero>
let A: FakeRemotePeer

beforeEach(async () => {
  // Real timers: the room-key path is PBKDF2 (600k) and the DM path chains
  // ECDH → HKDF → AES-GCM; none of it pumps under fake timers (same
  // reasoning as the M4 suites).
  fake = installFakeTrystero()
  clearDmKeyCache()
  A = await makeFakeRemotePeer('peer-a')
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
})

/** Lets the async key/seal/store tails (and their crypto) settle. */
function flushCrypto(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

function lastRoom(): FakeTrysteroRoom {
  const room = fake.rooms[fake.rooms.length - 1]
  if (room === undefined) throw new Error('no fake room joined')
  return room
}

/** Joins the manager into `ROOM` with the shared password, peer A present. */
async function joinPasswordRoomWithA(): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(ROOM, PASSWORD)
  const room = lastRoom()
  await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
  await flushCrypto()
  return { roomId: connection.roomId, room }
}

/** Joins the manager into a public room, peer A present with an open DM channel. */
async function joinPublicRoomWithA(
  name = 'lobby',
): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name)
  const room = lastRoom()
  await fakePeerJoins(room, A, { nick: 'zorro-bravo' })
  await flushCrypto()
  // A peer joining does not open DM channels (open/send/receive do, RF-04).
  manager.openDmChannel(A.id)
  return { roomId: connection.roomId, room }
}

describe('resolveTransferKey — room context (§12.4: room key or DTLS-only)', () => {
  it('resolves null for a public room: no key, the engine sends enc=false', async () => {
    const { roomId } = await joinPublicRoomWithA()
    await expect(manager.resolveTransferKey({ kind: 'room', roomId })).resolves.toBeNull()
  })

  it('resolves null for an unknown room id (no connection, no key)', async () => {
    await expect(
      manager.resolveTransferKey({ kind: 'room', roomId: 'sala-desconocida' }),
    ).resolves.toBeNull()
  })

  it('resolves the password room key: the SAME key seals the sendChat wire body', async () => {
    const { roomId, room } = await joinPasswordRoomWithA()
    const key = await manager.resolveTransferKey({ kind: 'room', roomId })
    if (key === null) throw new Error('resolver returned null for a password room')

    // The wire body is base64(IV ‖ ct) — the BINARY opener must open it
    // straight after the base64 decode, proving the resolver returned the
    // very key sendChat seals with (one join's PBKDF2, nothing extra).
    manager.sendChat(roomId, 'hola chunks')
    await flushCrypto()
    const wire = room.lastSend('chat').data as Envelope
    expect(wire.enc).toBe(true)
    const opened = await openChunk(key, base64ToBytes(wire.body))
    expect(new TextDecoder().decode(opened)).toBe('hola chunks')
  })

  it('the resolved key seals chunks the EXISTING room receive path opens', async () => {
    const { roomId, room } = await joinPasswordRoomWithA()
    const key = await manager.resolveTransferKey({ kind: 'room', roomId })
    if (key === null) throw new Error('resolver returned null for a password room')

    // Seal a chunk with the resolver's key, ship it as a §9.3 envelope and
    // let the manager's normal receive path decrypt it: one key, both wire
    // shapes (the §12.4 no-drift property, exercised end to end).
    const sealed = await sealChunk(key, new TextEncoder().encode('chunk al chat'))
    room.receive(
      'chat',
      createEnvelope({
        from: 'peer-a',
        nick: 'zorro-bravo',
        kind: 'chat',
        enc: true,
        iv: bytesToBase64(sealed.slice(0, 12)),
        body: bytesToBase64(sealed),
      }),
      'peer-a',
    )
    await vi.waitFor(() =>
      expect(storedRoom(roomId).messages.some((message) => message.text === 'chunk al chat')).toBe(
        true,
      ),
    )
  })
})

describe('resolveTransferKey — dm context (§12.4: DMs are always sealed)', () => {
  it('resolves the v2 DM key: an independent A-side derivation opens its chunks', async () => {
    const { room } = await joinPublicRoomWithA()
    expect(useAppStore.getState().dms[A.id]?.available).toBe(true)
    const key = await manager.resolveTransferKey({ kind: 'dm', peerId: A.id })
    if (key === null) throw new Error('resolver returned null for a v2-capable DM peer')

    // Independent, UNCACHED A-side derivation (deriveDmKeyV2, not the cache
    // the resolver uses): A's ephemeral private key over B's ANNOUNCED
    // ephemeral raw key, with both fingerprint pairs in the §9.2 v2 salt.
    const myRaw = room.action('keys').sends[0]?.data as Uint8Array
    const myEphRaw = room.action('ephkeys').sends[0]?.data as Uint8Array
    const aSideKey = await deriveDmKeyV2(
      A.ephKeypair.privateKey,
      myEphRaw,
      A.fingerprint,
      await computeFingerprint(myRaw),
      A.ephFingerprint,
      await computeFingerprint(myEphRaw),
    )

    // What B seals for A with the resolver's key, A opens with her own
    // derivation — the exact property a file transfer needs.
    const plaintext = Uint8Array.from([0x00, 0x01, 0xff, 0x7f, 0x80, 0x42])
    const sealed = await sealChunk(key, plaintext)
    await expect(openChunk(aSideKey, sealed)).resolves.toEqual(plaintext)

    // And the reverse: A seals, B's resolver key opens.
    const reply = await sealChunk(aSideKey, plaintext)
    await expect(openChunk(key, reply)).resolves.toEqual(plaintext)
  })

  it('resolves null for a legacy peer that never announced ephkeys', async () => {
    const legacy = await makeFakeRemotePeer('peer-legacy')
    await joinPublicRoomWithA()
    const room = lastRoom()
    await fakePeerJoins(room, legacy, { nick: 'par-viejo', announceEphemeral: false })
    await flushCrypto()
    // Open the channel so the resolver passes the availability guard and
    // hits the real legacy gate (no announced ephemeral key), not the
    // missing-channel one.
    manager.openDmChannel(legacy.id)
    expect(useAppStore.getState().dms[legacy.id]?.available).toBe(true)
    await expect(manager.resolveTransferKey({ kind: 'dm', peerId: legacy.id })).resolves.toBeNull()
  })

  it('resolves null for an unknown peer (no channel, no shared room)', async () => {
    await joinPublicRoomWithA()
    await expect(manager.resolveTransferKey({ kind: 'dm', peerId: 'nadie' })).resolves.toBeNull()
  })
})
