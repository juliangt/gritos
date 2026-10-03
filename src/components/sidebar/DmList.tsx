import { Badge } from '../common/Badge'
import { EMPTY_DM_LIST_TEXT } from '../../lib/feed'
import type { DmChannel } from '../../stores/useAppStore'

/**
 * *Mensajes directos* section (RF-04, §10.1): one row per open DM channel
 * with the unread badge; clicking focuses the conversation, which clears
 * its badge. Channels whose peer left every shared room stay listed (their
 * history lives in memory) with a disconnected marker. With no channels the
 * section stays visible with a discrete empty state (M6) so the entry point
 * to DMs is discoverable.
 */
export function DmList(props: {
  channels: DmChannel[]
  activePeerId: string | null
  onOpenDm: (peerId: string) => void
}) {
  return (
    <section aria-label="Mensajes directos" className="flex flex-col gap-1">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
        Mensajes directos
      </h2>
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
