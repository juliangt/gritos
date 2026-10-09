import { vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import {
  computeFingerprint,
  exportRawPublicKey,
  generateSessionKeypair,
} from '../src/lib/crypto/identity'

/**
 * Fake Trystero layer for tests: captures the joinRoom config/roomId,
 * exposes the room instance with its registered actions, and lets tests
 * drive peer join/leave and inbound action messages. Injected through the
 * roomManager's `setJoinRoomFactory` seam — the real @trystero-p2p/torrent
 * module is never contacted.
 */

export interface SendRecord {
  data: unknown
  options?: { target?: string | string[] | null }
}

export interface FakeAction {
  name: string
  sends: SendRecord[]
  send: (data: unknown, options?: SendRecord['options']) => Promise<void>
  onMessage: ((data: unknown, context: { peerId: string }) => void) | null
}

export class FakeTrysteroRoom {
  readonly actions = new Map<string, FakeAction>()
  onPeerJoin: ((peerId: string) => void) | null = null
  onPeerLeave: ((peerId: string) => void) | null = null
  readonly leave = vi.fn(async () => {})
  /**
   * Test-only hook (issue #45): when true, every send still records its
   * attempt but rejects, simulating a data channel that closed mid-flight.
   */
  failSends = false

  makeAction(name: string): FakeAction {
    if (this.actions.has(name)) throw new Error(`action re-registered: ${name}`)
    const action: FakeAction = {
      name,
      sends: [],
      send: async (data, options) => {
        action.sends.push({ data, options })
        if (this.failSends) throw new Error(`fake channel closed: ${name}`)
      },
      onMessage: null,
    }
    this.actions.set(name, action)
    return action
  }

  action(name: string): FakeAction {
    const action = this.actions.get(name)
    if (action === undefined) throw new Error(`action not registered: ${name}`)
    return action
  }

  peerJoin(peerId: string): void {
    this.onPeerJoin?.(peerId)
  }

  peerLeave(peerId: string): void {
    this.onPeerLeave?.(peerId)
  }

  receive(name: string, data: unknown, peerId: string): void {
    const handler = this.action(name).onMessage
    if (handler === null) throw new Error(`no onMessage registered for ${name}`)
    handler(data, { peerId })
  }

  lastSend(name: string): SendRecord {
    const sends = this.action(name).sends
    if (sends.length === 0) throw new Error(`no sends recorded for ${name}`)
    return sends[sends.length - 1]
  }
}

export function createFakeTrystero() {
  const rooms: FakeTrysteroRoom[] = []
  const configs: { config: unknown; roomId: string }[] = []
  const joinRoomFn = vi.fn((config: unknown, roomId: string) => {
    const room = new FakeTrysteroRoom()
    configs.push({ config, roomId })
    rooms.push(room)
    return room
  })
  return { joinRoomFn, rooms, configs }
}

/** Creates the fake and installs it as the manager's joinRoom factory. */
export function installFakeTrystero(): ReturnType<typeof createFakeTrystero> {
  const fake = createFakeTrystero()
  manager.setJoinRoomFactory(fake.joinRoomFn as unknown as manager.TrysteroJoinRoom)
  return fake
}

// ---------------------------------------------------------------------------
// Issue #93 (spec §12.1) — v2-capable fake remote peers
// ---------------------------------------------------------------------------

/**
 * A fake remote peer's cryptographic material: the long-lived identity
 * keypair (announced via `keys`) plus a session-ephemeral one (announced
 * via `ephkeys`), each with its raw public key and fingerprint — exactly
 * what a v2-capable build announces when joining.
 */
export interface FakeRemotePeer {
  id: string
  keypair: CryptoKeyPair
  rawPublicKey: Uint8Array
  fingerprint: string
  ephKeypair: CryptoKeyPair
  ephRawKey: Uint8Array
  ephFingerprint: string
}

/** Generates a full v2-capable remote peer under a fixed Trystero peerId. */
export async function makeFakeRemotePeer(id: string): Promise<FakeRemotePeer> {
  const keypair = await generateSessionKeypair()
  const rawPublicKey = await exportRawPublicKey(keypair.publicKey)
  const ephKeypair = await generateSessionKeypair()
  const ephRawKey = await exportRawPublicKey(ephKeypair.publicKey)
  return {
    id,
    keypair,
    rawPublicKey,
    fingerprint: await computeFingerprint(rawPublicKey),
    ephKeypair,
    ephRawKey,
    ephFingerprint: await computeFingerprint(ephRawKey),
  }
}

/**
 * Introduces `peer` into `room` the way a v2-capable build does (issue #93,
 * spec §12.1): peer join + presence + identity `keys` + session-ephemeral
 * `ephkeys` (65 bytes) announces. With `announceEphemeral: false` the peer
 * models a legacy (v1) build that never announces `ephkeys` — the explicit
 * mixed-version state the manager must surface instead of hiding.
 */
export async function fakePeerJoins(
  room: FakeTrysteroRoom,
  peer: FakeRemotePeer,
  options: { nick?: string; announceEphemeral?: boolean } = {},
): Promise<void> {
  room.peerJoin(peer.id)
  room.receive('presence', { nick: options.nick ?? 'peer', fp: peer.fingerprint }, peer.id)
  room.receive('keys', peer.rawPublicKey, peer.id)
  if (options.announceEphemeral !== false) {
    room.receive('ephkeys', peer.ephRawKey, peer.id)
  }
}
