import { useState } from 'react'
import { useAppStore, type AppState } from '../../stores/useAppStore'
import { SettingsModal } from '../settings/SettingsModal'
import { StatusDot } from '../common/StatusDot'
import { NETWORK_ERROR_BANNER_TEXT } from '../../lib/rooms'

/**
 * Network error banner (RNF-07 — never an indistinguishable silence):
 * rendered at the top of the chat area while ANY active room sits in the
 * `error` state (tracker heuristic exhausted, §10.3). Non-blocking: it
 * offers the exact §10.3 text, an 'Abrir ajustes' shortcut to Ajustes → Red
 * (RF-07) and a dismiss control. A dismissal only hides the CURRENT set of
 * erroring rooms — a different room erroring (or the same room again after
 * recovering) brings the banner back.
 */

/** Fine selector: erroring room ids as a primitive (comma-joined). */
function selectErrorRoomIds(state: AppState): string {
  return Object.values(state.rooms)
    .filter((room) => room.status === 'error')
    .map((room) => room.id)
    .join(',')
}

interface BannerState {
  /** joinedErrorIds snapshot the dismissal set was pruned against. */
  lastJoined: string
  /** Room ids this session has dismissed the banner for. */
  dismissed: string[]
}

export function NetworkErrorBanner() {
  const joinedErrorIds = useAppStore(selectErrorRoomIds)
  const [state, setState] = useState<BannerState>({ lastJoined: joinedErrorIds, dismissed: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)

  const errorIds = joinedErrorIds === '' ? [] : joinedErrorIds.split(',')

  // A dismissal expires as soon as its room stops erroring, so the banner
  // reappears if the same room (or any other) errors again later. Derived
  // state is adjusted DURING render against the input snapshot (documented
  // React pattern) — no effect, no cascading render.
  if (joinedErrorIds !== state.lastJoined) {
    setState({
      lastJoined: joinedErrorIds,
      dismissed: state.dismissed.filter((id) => errorIds.includes(id)),
    })
  }

  const visibleIds = errorIds.filter((id) => !state.dismissed.includes(id))
  if (visibleIds.length === 0 && !settingsOpen) return null

  const dismiss = () => {
    setState({ lastJoined: joinedErrorIds, dismissed: [...visibleIds] })
  }

  return (
    <>
      {visibleIds.length > 0 && (
        <div
          role="status"
          aria-label="Estado de la red"
          className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs"
        >
          <StatusDot status="error" />
          <p className="min-w-0 flex-1 text-muted">{NETWORK_ERROR_BANNER_TEXT}</p>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:border-accent"
          >
            Abrir ajustes
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Descartar el aviso"
            title="Descartar el aviso"
            className="shrink-0 rounded px-1 text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      )}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialTab="network"
      />
    </>
  )
}
