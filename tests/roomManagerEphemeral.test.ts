// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { useAppStore } from '../src/stores/useAppStore'
import {
  computeFingerprint,
  exportRawPublicKey,
  generateSessionKeypair,
} from '../src/lib/crypto/identity'
import { getEphemeralSession } from '../src/lib/crypto/sessionEphemeral'
import { TOFU_STORAGE_KEY } from '../src/lib/tofu'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * Issue #93 (spec §12.1, phase 3) — the `ephkeys` wire action: every room
 * announces its session-ephemeral ECDH P-256 public key on peer join and
 * re-announces a fresh one after an identity regeneration; received keys
 * land in the connection internals for the phase-4 v2 DM derivation. The
 * ephemeral fingerprint is crypto-trust only: NEVER pinned under
 * `gritos:tofu` (the identity key stays the TOFU anchor) and never
 * displayed.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  // Real timers: keypair generation + fingerprint chain several Web Crypto
  // threadpool roundtrips that fake timers do not pump. localStorage is
  // shared per file: `gritos:tofu` pins from earlier tests (e.g. a `keys`
  // receive) must not leak into the no-pin assertions below.
  localStorage.clear()
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  localStorage.clear()
})

/** Lets the async ephemeral-generation / fingerprint tails settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

function storedRoom(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error(`room ${roomId} not in store`)
  return room
}

async function joinedRoom(name = 'lobby'): Promise<{ roomId: string; room: FakeTrysteroRoom }> {
  const connection = await manager.joinRoom(name)
  return { roomId: connection.roomId, room: fake.rooms[fake.rooms.length - 1] }
}

async function remoteRawKey(): Promise<Uint8Array> {
  const keypair = await generateSessionKeypair()
  return exportRawPublicKey(keypair.publicKey)
}

describe('ephkeys announce on peer join (issue #93, spec §12.1)', () => {
  it('sends the session-ephemeral raw key (65 bytes), directed at the joiner', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    await flushMicrotasks()

    const announce = room.lastSend('ephkeys')
    expect(announce.data).toBeInstanceOf(Uint8Array)
    expect((announce.data as Uint8Array).byteLength).toBe(manager.RAW_PUBLIC_KEY_LENGTH)
    expect(announce.options).toEqual({ target: 'peer-1' })
    // What goes on the wire IS the module's session-ephemeral public key.
    expect(announce.data).toEqual(getEphemeralSession()?.rawPublicKey)
  })

  it('regenerateSessionIdentity resets the session and re-announces a fresh key', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    // Make the peer known so the re-announce loop targets it (same set as
    // the `keys` re-announce).
    room.receive('keys', new Uint8Array(65).fill(7), 'peer-1')
    await flushMicrotasks()

    const before = getEphemeralSession()
    await manager.regenerateSessionIdentity()
    await flushMicrotasks()

    const after = getEphemeralSession()
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
    const reannounce = room.lastSend('ephkeys')
    expect(reannounce.data).toEqual(after?.rawPublicKey)
    expect(reannounce.options).toEqual({ target: 'peer-1' })
  })
})

describe('ephkeys receive (issue #93, spec §12.1)', () => {
  it('stores the ephemeral key and its fingerprint for the phase-4 accessor', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    const rawKey = await remoteRawKey()
    const expected = await computeFingerprint(rawKey)

    room.receive('ephkeys', rawKey, 'peer-1')
    await flushMicrotasks()

    expect(manager.peerEphemeralKeyOf('peer-1')).toEqual({ rawKey, fingerprint: expected })
  })

  it('accepts ArrayBuffer deliveries and discards wrong-length or oversized payloads', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    const rawKey = await remoteRawKey()

    // Trystero delivers binary as ArrayBuffer — normalized like `keys`.
    const buffer = rawKey.slice().buffer
    room.receive('ephkeys', buffer, 'peer-1')
    await flushMicrotasks()
    expect(manager.peerEphemeralKeyOf('peer-1')?.rawKey).toEqual(rawKey)

    // Not an exact uncompressed P-256 key → §7.3 silence, nothing stored.
    room.receive('ephkeys', new Uint8Array(64), 'peer-2')
    room.receive('ephkeys', new Uint8Array(64 * 1024 + 1), 'peer-3')
    await flushMicrotasks()
    expect(manager.peerEphemeralKeyOf('peer-2')).toBeNull()
    expect(manager.peerEphemeralKeyOf('peer-3')).toBeNull()
  })

  it('never writes a TOFU pin nor a displayed fingerprint (spec §12.1)', async () => {
    const { roomId, room } = await joinedRoom()
    room.peerJoin('peer-1')
    const rawKey = await remoteRawKey()

    expect(localStorage.getItem(TOFU_STORAGE_KEY)).toBeNull()
    room.receive('ephkeys', rawKey, 'peer-1')
    await flushMicrotasks()

    // The ephemeral fingerprint is never pinned: `gritos:tofu` stays empty.
    expect(localStorage.getItem(TOFU_STORAGE_KEY)).toBeNull()
    // …and never displayed: the peer entry keeps its null fingerprint.
    expect(storedRoom(roomId).peers[0]?.fingerprint).toBeNull()
    // Even though the key itself did land in the internals.
    expect(manager.peerEphemeralKeyOf('peer-1')).not.toBeNull()
  })

  it('peer leave clears the ephemeral key and fingerprint maps', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    room.receive('ephkeys', await remoteRawKey(), 'peer-1')
    await flushMicrotasks()
    expect(manager.peerEphemeralKeyOf('peer-1')).not.toBeNull()

    room.peerLeave('peer-1')
    expect(manager.peerEphemeralKeyOf('peer-1')).toBeNull()
  })
})

describe('panic wipe (RF-08 + issue #93)', () => {
  it('resetSessionIdentity also drops the session-ephemeral material', async () => {
    const { room } = await joinedRoom()
    room.peerJoin('peer-1')
    await flushMicrotasks()
    expect(getEphemeralSession()).not.toBeNull()

    manager.resetSessionIdentity()
    expect(getEphemeralSession()).toBeNull()
  })
})
