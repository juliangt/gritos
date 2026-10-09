import type { RoomStatus } from '../../stores/useAppStore'

/**
 * Connection status dot (RF-06 / §10.1): amber pulsing while searching,
 * green once connected, red on the tracker-error heuristic. The per-peer
 * latency scale (🟢🟡🔴⚪) lives in `latencyDot` (stores/useAppStore).
 */
const STATUS_STYLES: Record<RoomStatus, { className: string; label: string }> = {
  searching: { className: 'bg-amber-400 animate-pulse', label: 'searching for peers' },
  connected: { className: 'bg-emerald-500', label: 'connected' },
  error: { className: 'bg-red-500', label: 'no tracker access' },
}

export function StatusDot({ status }: { status: RoomStatus }) {
  const style = STATUS_STYLES[status]
  return (
    <span
      role="img"
      aria-label={style.label}
      title={style.label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${style.className}`}
    />
  )
}
