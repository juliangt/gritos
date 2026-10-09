import { Badge } from '../common/Badge'
import { useT } from '../../i18n/index'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type { DmChannel } from '../../stores/useAppStore'

/**
 * "Direct messages" section (RF-04, §10.1): one row per open DM channel
 * with the unread badge; clicking focuses the conversation, which clears
 * its badge. Channels whose peer left every shared room stay listed (their
 * history lives in memory) with a disconnected marker. With no channels the
 * section stays visible with a discrete empty state (M6) so the entry point
 * to DMs is discoverable. Issue #97 (§12.2): the header carries the
 * "+ invite" entry to the manual-connection wizard, and trackerless
 * manual channels (room-backed rooms untouched) list with the "(no room)"
 * marker. Issue #105 (§12.5): signal-swarm channels list with the sibling
 * «(global)» marker, and the header carries the "+ contact" entry to the
 * contact flow — visible ONLY while the global-DM opt-in (`Settings.globalDm`)
 * is on, with the enabling toggle reachable from the entry's hint in
 * Settings → Privacy.
 */
export function DmList(props: {
  channels: DmChannel[]
  activePeerId: string | null
  onOpenDm: (peerId: string) => void
  onOpenInvite?: () => void
  onOpenContact?: () => void
}) {
  // Issue #119 — locale subscription: the rendered strings resolve through
  // `t` (live snapshot), so a language switch re-renders the list.
  const t = useT()
  // The contact entry follows the opt-in directly from the settings store:
  // toggling the switch hides/reveals it with no further wiring.
  const globalDm = useSettingsStore((state) => state.settings.globalDm)
  return (
    <section aria-label={t('sidebar.dmSectionLabel')} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t('sidebar.dmSectionLabel')}
        </h2>
        <span className="flex shrink-0 items-center gap-1">
          {globalDm && props.onOpenContact !== undefined && (
            <button
              type="button"
              onClick={props.onOpenContact}
              aria-label={t('contact.entry')}
              title={t('contact.entryTitle')}
              className="rounded px-1 py-0.5 text-xs font-medium text-muted hover:border-accent hover:text-text"
            >
              {t('contact.entry')}
            </button>
          )}
          {props.onOpenInvite !== undefined && (
            <button
              type="button"
              onClick={props.onOpenInvite}
              aria-label={t('wizard.inviteEntry')}
              title={t('wizard.inviteEntryTitle')}
              className="rounded px-1 py-0.5 text-xs font-medium text-muted hover:border-accent hover:text-text"
            >
              {t('wizard.inviteEntry')}
            </button>
          )}
        </span>
      </div>
      {props.channels.length === 0 ? (
        <p className="text-xs text-muted">{t('feed.emptyDmList')}</p>
      ) : (
        <ul className="flex flex-col">
          {props.channels.map((channel) => (
            <li key={channel.peerId}>
              <button
                type="button"
                onClick={() => props.onOpenDm(channel.peerId)}
                aria-current={channel.peerId === props.activePeerId ? 'true' : undefined}
                title={
                  channel.available
                    ? undefined
                    : t('dm.peerDisconnectedHistory')
                }
                className={`flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface ${
                  channel.peerId === props.activePeerId ? 'bg-surface font-semibold' : ''
                }`}
              >
                <span className="truncate">{channel.peerNick}</span>
                {channel.manual === true && (
                  <span
                    className="shrink-0 text-[10px] text-muted"
                    title={t('wizard.noRoomTitle')}
                  >
                    {t('wizard.noRoomMarker')}
                  </span>
                )}
                {channel.global === true && (
                  <span
                    className="shrink-0 text-[10px] text-muted"
                    title={t('contact.globalMarkerTitle')}
                  >
                    {t('contact.globalMarker')}
                  </span>
                )}
                {!channel.available && (
                  <span
                    role="img"
                    aria-label={t('sidebar.peerDisconnectedAria')}
                    title={t('dm.peerDisconnected')}
                  >
                    ⚪
                  </span>
                )}
                <Badge count={channel.unread} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
