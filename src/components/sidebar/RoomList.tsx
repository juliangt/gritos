import { Badge } from '../common/Badge'
import { StatusDot } from '../common/StatusDot'
import { useT } from '../../i18n/index'
import type { Room } from '../../stores/useAppStore'
import { SUGGESTED_ROOMS } from '../../lib/rooms'

/**
 * Room sections of the sidebar (RF-02, §10.1): *Activas* (unread badge,
 * status dot, 🔒 placeholder, leave button), *Sugeridas* (hidden when
 * already active) and *Recientes* (only when rememberRooms, hidden when
 * active; shows an empty state while nothing has been remembered yet).
 * Rendering is driven entirely by props so tests can mount it
 * with a prepared store.
 */
export function RoomList(props: {
  rooms: Room[]
  recentRooms: readonly string[]
  showRecents: boolean
  activeRoomId: string | null
  onOpenRoom: (roomId: string) => void
  onLeaveRoom: (roomId: string) => void
  onJoinByName: (name: string) => void
}) {
  const t = useT()
  const activeNames = new Set(props.rooms.map((room) => room.name))
  const suggested = SUGGESTED_ROOMS.filter((name) => !activeNames.has(name))
  const recents = props.showRecents
    ? props.recentRooms.filter((name) => !activeNames.has(name))
    : []

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Active rooms" className="flex flex-col gap-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Active</h2>
        {props.rooms.length === 0 && <p className="text-xs text-muted">No active rooms yet.</p>}
        <ul className="flex flex-col">
          {props.rooms.map((room) => (
            <li key={room.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => props.onOpenRoom(room.id)}
                aria-current={room.id === props.activeRoomId ? 'true' : undefined}
                className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface ${
                  room.id === props.activeRoomId ? 'bg-surface font-semibold' : ''
                }`}
              >
                <StatusDot status={room.status} />
                <span className="truncate">#{room.name}</span>
                {room.hasPassword && (
                  <span role="img" aria-label="encrypted room" title="Password-protected room">
                    🔒
                  </span>
                )}
                <Badge count={room.unread} />
              </button>
              <button
                type="button"
                onClick={() => props.onLeaveRoom(room.id)}
                aria-label={`Leave ${room.name}`}
                title={`Leave ${room.name}`}
                className="rounded px-1 text-muted opacity-0 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </section>

      {suggested.length > 0 && (
        <section aria-label="Suggested rooms" className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Suggested</h2>
          <ul className="flex flex-col">
            {suggested.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => props.onJoinByName(name)}
                  className="w-full truncate rounded px-1.5 py-1 text-left text-muted hover:bg-surface hover:text-text"
                >
                  #{name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.showRecents && props.recentRooms.length === 0 && (
        <section aria-label="Recent rooms" className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Recent</h2>
          <p className="text-xs text-muted">{t('feed.emptyRecents')}</p>
        </section>
      )}

      {recents.length > 0 && (
        <section aria-label="Recent rooms" className="flex flex-col gap-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Recent</h2>
          <ul className="flex flex-col">
            {recents.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => props.onJoinByName(name)}
                  className="w-full truncate rounded px-1.5 py-1 text-left text-muted hover:bg-surface hover:text-text"
                >
                  #{name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
