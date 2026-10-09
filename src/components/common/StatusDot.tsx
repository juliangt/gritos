import type { RoomStatus } from '../../stores/useAppStore'
import { useT, type TranslationKey } from '../../i18n/index'

/**
 * Connection status dot (RF-06 / §10.1): amber pulsing while searching,
 * green once connected, red on the tracker-error heuristic. The per-peer
 * latency scale (🟢🟡🔴⚪) lives in `latencyDot` (stores/useAppStore).
 * The a11y labels are dictionary KEYS resolved through `t` at render time
 * (issue #119): a module-level string map would freeze the boot locale.
 */
const STATUS_STYLES: Record<RoomStatus, { className: string; labelKey: TranslationKey }> = {
  searching: { className: 'bg-amber-400 animate-pulse', labelKey: 'chat.statusSearching' },
  connected: { className: 'bg-emerald-500', labelKey: 'chat.statusConnected' },
  error: { className: 'bg-red-500', labelKey: 'chat.statusError' },
}

export function StatusDot({ status }: { status: RoomStatus }) {
  const t = useT()
  const style = STATUS_STYLES[status]
  const label = t(style.labelKey)
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${style.className}`}
    />
  )
}
