/**
 * Unread-messages pill (RF-02): shows the pending count next to each active
 * room in the sidebar.
 */
export function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} sin leer`}
      className="ml-auto min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-semibold leading-5 text-accent-text"
    >
      {count}
    </span>
  )
}
