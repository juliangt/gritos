import { newMessagesButtonText } from '../../lib/feed'

/**
 * Floating '↓ N mensajes nuevos' button (RF-03): shown while auto-scroll is
 * disengaged; clicking jumps to the bottom and clears the counter.
 */
export function NewMessagesButton(props: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text shadow-lg"
    >
      {newMessagesButtonText(props.count)}
    </button>
  )
}
