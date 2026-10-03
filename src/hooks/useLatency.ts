import { useEffect } from 'react'
import { useAppStore } from '../stores/useAppStore'
import { onPong, sendPing } from '../lib/p2p/roomManager'

/**
 * Latency indicator — spec RF-06. A per-room ping/pong loop: every 5 s each
 * peer of the active room receives a directed `ping {t}` (§7.1); the peer
 * echoes `pong {t}` and the RTT lands in `peer.latencyMs`. A ping that gets
 * no pong before the next tick counts as a miss; 3 consecutive misses mark
 * the peer `degraded` (⚪, latencyMs cleared) — never disconnected. The next
 * pong recovers it.
 *
 * The engine is a plain object (createLatencyEngine) so tests drive it with
 * fake timers and a mocked room connection; the React hook only wires it to
 * the store and the room manager.
 */

export const PING_INTERVAL_MS = 5_000

/** RF-06 — 3 consecutive pings without response → degraded. */
export const MISSES_BEFORE_DEGRADED = 3

/** What the engine needs from the room connection (mockable seam). */
export interface LatencyTransport {
  /** Current peer ids of the room (drives pruning of departed peers). */
  getPeerIds(): string[]
  /** Sends a directed `ping {t}` to the peer. */
  sendPing(peerId: string, t: number): void
}

/** What the engine reports back (backed by the app store in the hook). */
export interface LatencySink {
  recordRtt(peerId: string, rttMs: number): void
  markDegraded(peerId: string): void
}

export interface LatencyEngineDeps {
  now?: () => number
}

interface PeerLatencyState {
  /** Echoed back on pong; null before the first ping. */
  lastPingT: number | null
  pongPending: boolean
  misses: number
}

export interface LatencyEngine {
  /** One cadence step: count misses, then ping every current peer. */
  tick(): void
  /** Feeds an echoed pong timestamp back into the engine. */
  notePong(peerId: string, t: number): void
  /** Drops all per-peer state (used when leaving a room). */
  stop(): void
}

export function createLatencyEngine(
  transport: LatencyTransport,
  sink: LatencySink,
  deps: LatencyEngineDeps = {},
): LatencyEngine {
  const now = deps.now ?? Date.now
  const peers = new Map<string, PeerLatencyState>()

  return {
    tick() {
      const current = new Set(transport.getPeerIds())

      for (const [peerId, state] of [...peers]) {
        if (!current.has(peerId)) {
          peers.delete(peerId)
          continue
        }
        if (state.lastPingT !== null && state.pongPending) {
          state.misses += 1
          if (state.misses >= MISSES_BEFORE_DEGRADED) {
            sink.markDegraded(peerId)
          }
        }
        const t = now()
        state.lastPingT = t
        state.pongPending = true
        transport.sendPing(peerId, t)
      }

      for (const peerId of current) {
        if (peers.has(peerId)) continue
        const t = now()
        peers.set(peerId, { lastPingT: t, pongPending: true, misses: 0 })
        transport.sendPing(peerId, t)
      }
    },

    notePong(peerId, t) {
      const state = peers.get(peerId)
      if (state === undefined || state.lastPingT === null || !state.pongPending) {
        return
      }
      state.pongPending = false
      state.misses = 0
      sink.recordRtt(peerId, Math.max(0, now() - t))
    },

    stop() {
      peers.clear()
    },
  }
}

/**
 * Runs the latency loop against a room of the manager. Mounted once by the
 * debug panel for the active room; M2 mounts it for the app's active view.
 */
export function useLatency(roomId: string | null): void {
  useEffect(() => {
    if (roomId === null) return

    const transport: LatencyTransport = {
      getPeerIds: () =>
        (useAppStore.getState().rooms[roomId]?.peers ?? []).map((peer) => peer.id),
      sendPing: (peerId, t) => {
        sendPing(roomId, peerId, t)
      },
    }
    const sink: LatencySink = {
      recordRtt: (peerId, rttMs) => {
        useAppStore
          .getState()
          .updatePeer(roomId, peerId, { latencyMs: rttMs, degraded: false })
      },
      markDegraded: (peerId) => {
        useAppStore
          .getState()
          .updatePeer(roomId, peerId, { latencyMs: null, degraded: true })
      },
    }

    const engine = createLatencyEngine(transport, sink)
    const unsubscribe = onPong((pongRoomId, peerId, t) => {
      if (pongRoomId === roomId) engine.notePong(peerId, t)
    })
    const interval = setInterval(() => engine.tick(), PING_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      unsubscribe()
      engine.stop()
    }
  }, [roomId])
}
