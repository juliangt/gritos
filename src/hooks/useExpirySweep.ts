import { useEffect } from 'react'
import { pruneExpiredMessages } from '../lib/p2p/roomManager'

/**
 * Issue #96 — TTL expiry sweep. A single session-wide 1 s tick removes every
 * message whose receiver-clock `expiresAt` is due from ALL room and DM feeds
 * (one guarded store pass per tick; the scan is bounded by the 500-message
 * FIFO cap per feed). The tick also feeds the manager's expired-id guard, so
 * a replayed envelope can never resurrect a message it already removed. The
 * cadence reuses the useLatency pattern: a plain engine object (injectable
 * clock) driven by one interval, so tests fake the clock; the React hook
 * only wires it to the manager and cleans up on unmount.
 */

/** Sweep cadence: 1 s — cheap under the FIFO cap, worst-case 1 s of lag. */
export const EXPIRY_SWEEP_INTERVAL_MS = 1_000

export interface ExpirySweepEngineDeps {
  now?: () => number
}

export interface ExpirySweepEngine {
  /** One cadence step: sweep every room and DM feed at the current time. */
  tick(): void
}

export function createExpirySweepEngine(deps: ExpirySweepEngineDeps = {}): ExpirySweepEngine {
  const now = deps.now ?? Date.now
  return {
    tick() {
      pruneExpiredMessages(now())
    },
  }
}

/**
 * Runs the sweep for the whole session. Mounted once by the ChatLayout —
 * unlike the per-room latency loop, expiry also applies to DM feeds that
 * outlive their rooms, so the timer is app-scoped, not per connection.
 */
export function useExpirySweep(): void {
  useEffect(() => {
    const engine = createExpirySweepEngine()
    const interval = setInterval(() => engine.tick(), EXPIRY_SWEEP_INTERVAL_MS)
    return () => {
      clearInterval(interval)
    }
  }, [])
}
