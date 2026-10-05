// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import * as manager from '../src/lib/p2p/roomManager'
import {
  MAX_PLAUSIBLE_RTT_MS,
  MISSES_BEFORE_DEGRADED,
  PING_INTERVAL_MS,
  createLatencyEngine,
  useLatency,
  type LatencySink,
  type LatencyTransport,
} from '../src/hooks/useLatency'
import { useAppStore } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

// ---------------------------------------------------------------------------
// Engine (pure, controlled clock)
// ---------------------------------------------------------------------------

function makeHarness() {
  const peers: string[] = []
  const sends: { peerId: string; t: number }[] = []
  const transport: LatencyTransport = {
    getPeerIds: () => [...peers],
    sendPing: (peerId, t) => {
      sends.push({ peerId, t })
    },
  }
  const rtts: { peerId: string; rttMs: number }[] = []
  const degraded: string[] = []
  const sink: LatencySink = {
    recordRtt: (peerId, rttMs) => {
      rtts.push({ peerId, rttMs })
    },
    markDegraded: (peerId) => {
      degraded.push(peerId)
    },
  }
  let clock = 0
  const engine = createLatencyEngine(transport, sink, { now: () => clock })
  return {
    peers,
    sends,
    rtts,
    degraded,
    engine,
    advanceMs: (ms: number) => {
      clock += ms
    },
  }
}

describe('latency engine (RF-06)', () => {
  it('pings every current peer on the first tick', () => {
    const harness = makeHarness()
    harness.peers.push('a', 'b')
    harness.engine.tick()
    expect(harness.sends).toEqual([
      { peerId: 'a', t: 0 },
      { peerId: 'b', t: 0 },
    ])
  })

  it('computes RTT from the echoed timestamp on pong', () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick() // ping t=0
    harness.advanceMs(120)
    harness.engine.notePong('a', 0)
    expect(harness.rtts).toEqual([{ peerId: 'a', rttMs: 120 }])
  })

  it('ignores unsolicited pongs for unknown peers', () => {
    const harness = makeHarness()
    harness.engine.notePong('ghost', 5)
    expect(harness.rtts).toHaveLength(0)
  })

  it('discards a forged "future" echo (negative RTT) without clearing the window (issue #36)', () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick() // ping t=0
    harness.advanceMs(120)
    harness.engine.notePong('a', 200) // attacker-controlled t from the future
    expect(harness.rtts).toHaveLength(0)
    // The pong never landed: the window stays pending and a later honest
    // echo within it still records.
    harness.engine.notePong('a', 0)
    expect(harness.rtts).toEqual([{ peerId: 'a', rttMs: 120 }])
  })

  it(`clamps RTTs above ${MAX_PLAUSIBLE_RTT_MS} to the ceiling (issue #36)`, () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick() // ping t=0
    harness.advanceMs(MAX_PLAUSIBLE_RTT_MS * 2)
    harness.engine.notePong('a', 0) // "honest" echo of an implausibly old ping
    expect(harness.rtts).toEqual([{ peerId: 'a', rttMs: MAX_PLAUSIBLE_RTT_MS }])
  })

  it(`marks degraded after exactly ${MISSES_BEFORE_DEGRADED} missed windows, not before`, () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick() // window 0: initial ping, no miss counted

    harness.advanceMs(PING_INTERVAL_MS)
    harness.engine.tick() // miss 1
    expect(harness.degraded).toHaveLength(0)

    harness.advanceMs(PING_INTERVAL_MS)
    harness.engine.tick() // miss 2
    expect(harness.degraded).toHaveLength(0)

    harness.advanceMs(PING_INTERVAL_MS)
    harness.engine.tick() // miss 3 → ⚪
    expect(harness.degraded).toEqual(['a'])
    expect(harness.sends).toHaveLength(4) // keeps pinging, never disconnects
  })

  it('stops counting misses once a pong arrived (recovery)', () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick()

    harness.advanceMs(PING_INTERVAL_MS)
    harness.engine.tick() // miss 1
    harness.engine.notePong('a', 0) // recovers

    // Three quiet ticks after recovery: window 0 counts no miss (the pong
    // cleared it), then misses 1 and 2 — still below the threshold.
    for (let i = 0; i < 3; i += 1) {
      harness.advanceMs(PING_INTERVAL_MS)
      harness.engine.tick()
    }
    expect(harness.degraded).toHaveLength(0)
    expect(harness.rtts).toEqual([{ peerId: 'a', rttMs: PING_INTERVAL_MS }])
  })

  it('drops state for departed peers (no phantom pings)', () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick()
    harness.peers.length = 0 // peer left the room
    harness.advanceMs(PING_INTERVAL_MS)
    harness.engine.tick()
    expect(harness.degraded).toHaveLength(0)
    expect(harness.sends).toHaveLength(1) // only the initial ping
  })

  it('clears all state on stop', () => {
    const harness = makeHarness()
    harness.peers.push('a')
    harness.engine.tick()
    harness.engine.stop()
    harness.engine.notePong('a', 0)
    expect(harness.rtts).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Hook against a mocked room connection (fake Trystero + real store)
// ---------------------------------------------------------------------------

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.useRealTimers()
})

async function joinWithPeer() {
  const connection = await manager.joinRoom('lobby')
  const room = fake.rooms[fake.rooms.length - 1]
  room.peerJoin('peer-1')
  return { connection, room, roomId: connection.roomId }
}

function storedPeer(roomId: string) {
  const room = useAppStore.getState().rooms[roomId]
  if (room === undefined) throw new Error('room missing from store')
  const peer = room.peers[0]
  if (peer === undefined) throw new Error('peer missing from store')
  return peer
}

describe('useLatency hook (RF-06)', () => {
  it(`sends a directed ping every ${PING_INTERVAL_MS} ms and records the RTT on pong`, async () => {
    const { room, roomId } = await joinWithPeer()
    renderHook(() => useLatency(roomId))

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    const ping = room.lastSend('ping')
    expect(ping.data).toEqual({ t: expect.any(Number) })
    expect(ping.options).toEqual({ target: 'peer-1' })

    await vi.advanceTimersByTimeAsync(120)
    room.receive('pong', { t: (ping.data as { t: number }).t }, 'peer-1')

    const peer = storedPeer(roomId)
    expect(peer.latencyMs).toBe(120)
    expect(peer.degraded).toBe(false)
  })

  it('discards a forged future-t pong and clamps an ancient one through the real pong path (issue #36)', async () => {
    const { room, roomId } = await joinWithPeer()
    renderHook(() => useLatency(roomId))

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    const pingT = (room.lastSend('ping').data as { t: number }).t

    // A forged echo timestamped in the future (negative RTT) is dropped.
    room.receive('pong', { t: pingT + 10_000 }, 'peer-1')
    expect(storedPeer(roomId).latencyMs).toBeNull()

    // An implausibly old echo is clamped to MAX_PLAUSIBLE_RTT_MS instead of
    // showing an absurd number.
    room.receive('pong', { t: pingT - MAX_PLAUSIBLE_RTT_MS * 2 }, 'peer-1')
    const peer = storedPeer(roomId)
    expect(peer.latencyMs).toBe(MAX_PLAUSIBLE_RTT_MS)
    expect(peer.degraded).toBe(false)
  })

  it('marks the peer degraded (⚪) after 3 unanswered windows and recovers on pong', async () => {
    const { room, roomId } = await joinWithPeer()
    renderHook(() => useLatency(roomId))

    // Window 1: initial ping. Windows 2–3: misses 1–2 (still 🟡/🔴 territory).
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(storedPeer(roomId).degraded).toBe(false)

    // Window 4: third consecutive miss → degraded, latency cleared.
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    let peer = storedPeer(roomId)
    expect(peer.degraded).toBe(true)
    expect(peer.latencyMs).toBeNull()

    // Next pong recovers the peer without ever disconnecting it.
    const lastPingT = (room.lastSend('ping').data as { t: number }).t
    await vi.advanceTimersByTimeAsync(80)
    room.receive('pong', { t: lastPingT }, 'peer-1')
    peer = storedPeer(roomId)
    expect(peer.degraded).toBe(false)
    expect(peer.latencyMs).toBe(80)
  })

  it('clears latencyMs on degradation (⚪ = sin datos)', async () => {
    const { room, roomId } = await joinWithPeer()
    renderHook(() => useLatency(roomId))

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    const ping = room.lastSend('ping')
    await vi.advanceTimersByTimeAsync(30)
    room.receive('pong', { t: (ping.data as { t: number }).t }, 'peer-1')
    expect(storedPeer(roomId).latencyMs).toBe(30)

    // Three silent windows wipe the previous RTT (RF-06 ⚪).
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 4)
    expect(storedPeer(roomId).latencyMs).toBeNull()
    expect(storedPeer(roomId).degraded).toBe(true)
  })

  it('stops pinging after unmount', async () => {
    const { room, roomId } = await joinWithPeer()
    const { unmount } = renderHook(() => useLatency(roomId))
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(room.action('ping').sends).toHaveLength(1)
    unmount()
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(room.action('ping').sends).toHaveLength(1)
  })

  it('does nothing for a null room', async () => {
    renderHook(() => useLatency(null))
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2)
    expect(fake.rooms).toHaveLength(0)
  })
})
