// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { panicWipe } from '../src/lib/panic'
import {
  TOFU_STORAGE_KEY,
  getTofuFingerprint,
  loadTofuPins,
  pinTofuFingerprint,
  saveTofuPins,
} from '../src/lib/tofu'
import { INITIAL_APP_STATE, useAppStore, type DmChannel } from '../src/stores/useAppStore'
import {
  computeFingerprint,
  exportRawPublicKey,
  generateSessionKeypair,
} from '../src/lib/crypto/identity'
import { installFakeTrystero, type FakeTrysteroRoom } from './fakeTrystero'

/**
 * Issue #22 — TOFU enforcement: the first fingerprint seen per peer is
 * pinned under `gritos:tofu` (null-safe, corruption-safe, wiped by panic);
 * a later, different `keys` message keeps the pinned fingerprint as the
 * displayed identity and flags the DM channel `keyChanged` instead of
 * silently rotating it.
 */

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ ...INITIAL_APP_STATE })
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Lets the keys handler's async computeFingerprint tail settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60))
}

function dmChannel(peerId: string): DmChannel {
  const channel = useAppStore.getState().dms[peerId]
  if (channel === undefined) throw new Error(`dm channel ${peerId} not in store`)
  return channel
}

interface RemotePeer {
  id: string
  rawPublicKey: Uint8Array
  fingerprint: string
}

/** A keypair + fingerprint under a fixed Trystero peerId. */
async function makePeer(id: string): Promise<RemotePeer> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  return { id, rawPublicKey, fingerprint: await computeFingerprint(rawPublicKey) }
}

describe('TOFU store (gritos:tofu)', () => {
  it('roundtrips pins through localStorage as {peerId: fingerprint}', () => {
    pinTofuFingerprint('peer-a', 'A31F 09BC 77D2 4E5A')
    pinTofuFingerprint('peer-b', 'B31F 09BC 77D2 4E5A')

    expect(getTofuFingerprint('peer-a')).toBe('A31F 09BC 77D2 4E5A')
    expect(getTofuFingerprint('peer-b')).toBe('B31F 09BC 77D2 4E5A')
    expect(getTofuFingerprint('peer-c')).toBeNull()
    expect(loadTofuPins()).toEqual({
      'peer-a': 'A31F 09BC 77D2 4E5A',
      'peer-b': 'B31F 09BC 77D2 4E5A',
    })
    // Raw JSON shape: a flat map, no wrapper object.
    expect(JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) as string)).toEqual({
      'peer-a': 'A31F 09BC 77D2 4E5A',
      'peer-b': 'B31F 09BC 77D2 4E5A',
    })
  })

  it('first write wins: an existing pin is never overwritten', () => {
    pinTofuFingerprint('peer-a', 'A31F 09BC 77D2 4E5A')
    pinTofuFingerprint('peer-a', 'DEAD BEEF DEAD BEEF')
    pinTofuFingerprint('peer-a', 'CAFE BABE CAFE BABE')

    expect(getTofuFingerprint('peer-a')).toBe('A31F 09BC 77D2 4E5A')
  })

  it('ignores empty peer ids and fingerprints', () => {
    pinTofuFingerprint('', 'A31F 09BC 77D2 4E5A')
    pinTofuFingerprint('peer-a', '')

    expect(loadTofuPins()).toEqual({})
    expect(localStorage.getItem(TOFU_STORAGE_KEY)).toBeNull()
  })

  it('survives corruption: invalid JSON, arrays and bad entries read as empty/filtered', () => {
    localStorage.setItem(TOFU_STORAGE_KEY, 'esto no es json')
    expect(loadTofuPins()).toEqual({})
    expect(() => getTofuFingerprint('peer-a')).not.toThrow()

    localStorage.setItem(TOFU_STORAGE_KEY, '["not", "an", "object"]')
    expect(loadTofuPins()).toEqual({})

    localStorage.setItem(TOFU_STORAGE_KEY, 'null')
    expect(loadTofuPins()).toEqual({})

    localStorage.setItem(
      TOFU_STORAGE_KEY,
      JSON.stringify({ 'peer-a': 'A31F 09BC 77D2 4E5A', 'peer-b': 42, '': 'x', 'peer-c': null }),
    )
    expect(loadTofuPins()).toEqual({ 'peer-a': 'A31F 09BC 77D2 4E5A' })
  })

  it('is null-safe when localStorage is unavailable (private mode)', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(() => saveTofuPins({ 'peer-a': 'A31F 09BC 77D2 4E5A' })).not.toThrow()
    expect(loadTofuPins()).toEqual({})
    expect(getTofuFingerprint('peer-a')).toBeNull()
    expect(() => pinTofuFingerprint('peer-a', 'A31F 09BC 77D2 4E5A')).not.toThrow()
  })

  it('the panic wipe clears the pin store (RF-08)', () => {
    pinTofuFingerprint('peer-a', 'A31F 09BC 77D2 4E5A')
    expect(localStorage.getItem(TOFU_STORAGE_KEY)).not.toBeNull()

    vi.stubGlobal('location', { reload: vi.fn() })
    panicWipe({ reload: false })

    expect(localStorage.getItem(TOFU_STORAGE_KEY)).toBeNull()
    expect(getTofuFingerprint('peer-a')).toBeNull()
  })
})

describe('keys handler TOFU enforcement (issue #22)', () => {
  let fake: ReturnType<typeof installFakeTrystero>
  let A: RemotePeer
  let rotated: RemotePeer

  beforeEach(async () => {
    fake = installFakeTrystero()
    A = await makePeer('peer-a')
    // Same Trystero peerId, DIFFERENT keypair: a rotated/impersonated key.
    rotated = await makePeer('peer-a')
    expect(rotated.fingerprint).not.toBe(A.fingerprint)
  })

  /** Joins the manager into a room and delivers A's `keys` message. */
  async function joinAndReceiveKeys(peer: RemotePeer = A): Promise<string> {
    const connection = await manager.joinRoom('lobby')
    const room: FakeTrysteroRoom = fake.rooms[fake.rooms.length - 1] as FakeTrysteroRoom
    room.peerJoin(A.id)
    room.receive('keys', peer.rawPublicKey, A.id)
    await flushMicrotasks()
    return connection.roomId
  }

  it('first contact pins the fingerprint without flagging anything', async () => {
    await joinAndReceiveKeys()

    expect(getTofuFingerprint(A.id)).toBe(A.fingerprint)
    const { rooms } = useAppStore.getState()
    const peerEntry = Object.values(rooms)[0]?.peers[0]
    expect(peerEntry?.fingerprint).toBe(A.fingerprint)
  })

  it('a rotated key updates the live key but keeps the pinned fingerprint displayed and flags the channel', async () => {
    const roomId = await joinAndReceiveKeys()
    expect(manager.openDmChannel(A.id)).toBe(true)
    expect(dmChannel(A.id).keyChanged).toBe(false)
    expect(dmChannel(A.id).peerFingerprint).toBe(A.fingerprint)

    // The same peer announces a different key.
    ;(fake.rooms[0] as FakeTrysteroRoom).receive('keys', rotated.rawPublicKey, A.id)
    await flushMicrotasks()

    // The pin survives: the pinned value stays authoritative for display.
    expect(getTofuFingerprint(A.id)).toBe(A.fingerprint)
    expect(dmChannel(A.id).keyChanged).toBe(true)
    expect(dmChannel(A.id).peerFingerprint).toBe(A.fingerprint)

    // The room peer list also keeps showing the pinned fingerprint.
    const peerEntry = Object.values(useAppStore.getState().rooms)[0]?.peers[0]
    expect(peerEntry?.fingerprint).toBe(A.fingerprint)

    // ...while the live key DID rotate (DM crypto keeps working with it).
    expect(manager.getPeerRawKey(roomId, A.id)).toEqual(rotated.rawPublicKey)
  })

  it('flags a channel opened AFTER the rotation with the pinned fingerprint', async () => {
    await joinAndReceiveKeys()
    await joinAndReceiveKeys(rotated)
    // No DM channel existed during the rotation: opening one now must not
    // resurrect the rotated fingerprint as the verified identity.
    expect(manager.openDmChannel(A.id)).toBe(true)

    expect(dmChannel(A.id).keyChanged).toBe(true)
    expect(dmChannel(A.id).peerFingerprint).toBe(A.fingerprint)
  })

  it('receiving the same key twice keeps the channel clean', async () => {
    await joinAndReceiveKeys()
    expect(manager.openDmChannel(A.id)).toBe(true)

    const room = fake.rooms[0] as FakeTrysteroRoom
    room.receive('keys', A.rawPublicKey, A.id)
    await flushMicrotasks()

    expect(dmChannel(A.id).keyChanged).toBe(false)
    expect(dmChannel(A.id).peerFingerprint).toBe(A.fingerprint)
  })

  it('a second session re-pins consistently and never flags the original key', async () => {
    await joinAndReceiveKeys()
    // Simulate a reload: manager state is gone, the pin store persists.
    manager.resetManagerForTests()
    fake = installFakeTrystero()
    await joinAndReceiveKeys()

    expect(getTofuFingerprint(A.id)).toBe(A.fingerprint)
    const peerEntry = Object.values(useAppStore.getState().rooms)[0]?.peers[0]
    expect(peerEntry?.fingerprint).toBe(A.fingerprint)
  })
})
