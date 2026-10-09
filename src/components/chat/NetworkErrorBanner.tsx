import { useState } from 'react'
import { useAppStore, type AppState } from '../../stores/useAppStore'
import { SettingsModal } from '../settings/SettingsModal'
import { StatusDot } from '../common/StatusDot'
import { useT } from '../../i18n/index'

/**
 * Network error banner (RNF-07 — never an indistinguishable silence):
 * rendered at the top of the chat area while ANY active room sits in the
 * `error` state (tracker heuristic exhausted, §10.3). Non-blocking: it
 * offers the exact §10.3 text, an 'Open settings' shortcut to Settings →
 * Network (RF-07) and a dismiss control. A dismissal only hides the CURRENT set of
 * erroring rooms — a different room erroring (or the same room again after
 * recovering) brings the banner back.
 *
 * The same spot also surfaces the insecure-context notice (issue #43):
 * outside a secure context (plain HTTP on a LAN IP) Web Crypto and WebRTC
 * are unavailable, ChatLayout skips the #lobby auto-join up front instead
 * of letting it reject silently, and this banner explains why.
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

export function NetworkErrorBanner(props: { onOpenManualDm?: () => void }) {
  const t = useT()
  const joinedErrorIds = useAppStore(selectErrorRoomIds)
  const [state, setState] = useState<BannerState>({ lastJoined: joinedErrorIds, dismissed: [] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  // `isSecureContext` cannot flip without a reload, so a plain flag keeps
  // the insecure-context notice dismissed for the whole session.
  const [contextNoticeDismissed, setContextNoticeDismissed] = useState(false)
  const contextNoticeVisible = !window.isSecureContext && !contextNoticeDismissed

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
  if (visibleIds.length === 0 && !settingsOpen && !contextNoticeVisible) return null

  const dismiss = () => {
    setState({ lastJoined: joinedErrorIds, dismissed: [...visibleIds] })
  }

  return (
    <>
      {contextNoticeVisible && (
        <div
          role="status"
          aria-label="Network status"
          className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs"
        >
          <StatusDot status="error" />
          <p className="min-w-0 flex-1 text-muted">{t('chat.insecureContextBanner')}</p>
          <button
            type="button"
            onClick={() => setContextNoticeDismissed(true)}
            aria-label="Dismiss the notice"
            title="Dismiss the notice"
            className="shrink-0 rounded px-1 text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      )}
      {visibleIds.length > 0 && (
        <div
          role="status"
          aria-label="Network status"
          className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-xs"
        >
          <StatusDot status="error" />
          <p className="min-w-0 flex-1 text-muted">{t('chat.networkErrorBanner')}</p>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:border-accent"
          >
            Open settings
          </button>
          {props.onOpenManualDm !== undefined && (
            <button
              type="button"
              onClick={props.onOpenManualDm}
              title="Start a direct conversation without trackers"
              className="shrink-0 rounded border border-border px-2 py-1 font-medium hover:border-accent"
            >
              {t('wizard.bannerShortcut')}
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss the notice"
            title="Dismiss the notice"
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
