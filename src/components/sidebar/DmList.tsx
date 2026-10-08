import { Badge } from '../common/Badge'
import { EMPTY_DM_LIST_TEXT } from '../../lib/feed'
import type { DmChannel } from '../../stores/useAppStore'
import {
  MANUAL_DM_INVITE_ENTRY,
  MANUAL_DM_INVITE_ENTRY_TITLE,
  MANUAL_DM_NO_SALA_MARKER,
  MANUAL_DM_NO_SALA_TITLE,
} from '../settings/messages'

/**
 * *Mensajes directos* section (RF-04, §10.1): one row per open DM channel
 * with the unread badge; clicking focuses the conversation, which clears
 * its badge. Channels whose peer left every shared room stay listed (their
 * history lives in memory) with a disconnected marker. With no channels the
 * section stays visible with a discrete empty state (M6) so the entry point
 * to DMs is discoverable. Issue #97 (§12.2): the header carries the
 * «+ invitación» entry to the manual-connection wizard, and trackerless
 * manual channels (room-backed rooms untouched) list with the «(sin sala)»
 * marker.
 */
export function DmList(props: {
  channels: DmChannel[]
  activePeerId: string | null
  onOpenDm: (peerId: string) => void
  onOpenInvite?: () => void
}) {
  return (
    <section aria-label="Mensajes directos" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Mensajes directos
        </h2>
        {props.onOpenInvite !== undefined && (
          <button
            type="button"
            onClick={props.onOpenInvite}
            aria-label={MANUAL_DM_INVITE_ENTRY}
            title={MANUAL_DM_INVITE_ENTRY_TITLE}
            className="shrink-0 rounded px-1 py-0.5 text-xs font-medium text-muted hover:border-accent hover:text-text"
          >
            {MANUAL_DM_INVITE_ENTRY}
          </button>
        )}
      </div>
      {props.channels.length === 0 ? (
        <p className="text-xs text-muted">{EMPTY_DM_LIST_TEXT}</p>
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
                    : 'El par se ha desconectado — el historial permanece'
                }
                className={`flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface ${
                  channel.peerId === props.activePeerId ? 'bg-surface font-semibold' : ''
                }`}
              >
                <span className="truncate">{channel.peerNick}</span>
                {channel.manual === true && (
                  <span className="shrink-0 text-[10px] text-muted" title={MANUAL_DM_NO_SALA_TITLE}>
                    {MANUAL_DM_NO_SALA_MARKER}
                  </span>
                )}
                {!channel.available && (
                  <span role="img" aria-label="par desconectado" title="El par se ha desconectado">
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
