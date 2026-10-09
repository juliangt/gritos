import { tPlural, useT } from '../../i18n/index'

/**
 * Unread-messages pill (RF-02): shows the pending count next to each active
 * room in the sidebar. The accessible name resolves through the
 * `common.unreadCount` plural pair at render time (issue #119).
 */
export function Badge({ count }: { count: number }) {
  // Locale subscription: tPlural reads the live snapshot, but without this
  // subscription the pill would not re-render on a language switch (#119).
  useT()
  if (count <= 0) return null
  return (
    <span
      aria-label={tPlural('common.unreadCount', count)}
      className="ml-auto min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-semibold leading-5 text-accent-text"
    >
      {count}
    </span>
  )
}
