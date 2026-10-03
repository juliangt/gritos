/**
 * Latency indicator support — spec RF-06. The actual ping/pong loop (5 s
 * interval, 3 misses → degraded ⚪) is owned by the RoomManager in M1;
 * this hook will expose per-peer latency to the UI components.
 */
export function useLatency(): void {
  // M1: expose { peerId → latencyMs | degraded } from the app store.
}
