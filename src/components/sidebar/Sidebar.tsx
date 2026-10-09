import { useState } from 'react'
import { RoomList } from './RoomList'
import { PeerList } from './PeerList'
import { DmList } from './DmList'
import { JoinRoomPopover } from './JoinRoomPopover'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * Collapsible sidebar (spec §10.1): *Activas*, *Sugeridas*, *Recientes*
 * (RF-02), [+ Unirse] popover, the *Pares* section of the active view
 * (RF-06) and the "Direct messages" channels with their unread badges
 * (RF-04). Visibility/collapse is owned by the layout (desktop persistence
 * under `gritos:ui`; mobile drawer), this component renders the content.
 */
export function Sidebar(props: {
  onRoomOpened?: () => void
  onOpenManualDm?: () => void
  onOpenContact?: () => void
}) {
  const rooms = useAppStore((state) => state.rooms)
  const dms = useAppStore((state) => state.dms)
  const manualDms = useAppStore((state) => state.manualDms)
  const recentRooms = useAppStore((state) => state.recentRooms)
  const activeView = useAppStore((state) => state.activeView)
  const rememberRooms = useSettingsStore((state) => state.settings.rememberRooms)
  // Issue #99 — /room on a room that may need a password (or any executor
  // path) opens this popover prefilled through the ui-store seam; the local
  // toggle keeps working as before. Either source opens the same form, and
  // either close path clears both.
  const joinPopoverName = useUiStore((state) => state.joinPopoverName)
  const closeJoinPopover = useUiStore((state) => state.closeJoinPopover)
  const { joinRoomFocused, leaveRoom } = useRoomManager()

  const [joinOpen, setJoinOpen] = useState(false)
  // Last joinByName rejection; rendered inside the open popover (issue #87),
  // so it is always set together with joinOpen and cleared on close/success.
  const [joinError, setJoinError] = useState<string | null>(null)
  const joinFormOpen = joinOpen || joinPopoverName !== null

  const roomList = Object.values(rooms)
  // Issue #97 — room-backed and manual channels render as one list; manual
  // channels are marked "(no room)" inside DmList.
  const dmList = [...Object.values(dms), ...Object.values(manualDms)]
  const activeRoomId =
    activeView?.kind === 'room' && rooms[activeView.id] !== undefined ? activeView.id : null
  const activeRoom = activeRoomId !== null ? rooms[activeRoomId] : null
  const activeDmPeerId = activeView?.kind === 'dm' ? activeView.peerId : null

  const openRoom = (roomId: string) => {
    useAppStore.getState().setActiveView({ kind: 'room', id: roomId })
    props.onRoomOpened?.()
  }

  const openDm = (peerId: string) => {
    // setActiveView clears the channel's unread badge (RF-04).
    useAppStore.getState().setActiveView({ kind: 'dm', peerId })
    props.onRoomOpened?.()
  }

  const joinByName = async (name: string) => {
    const { roomId, error } = await joinRoomFocused(name)
    if (error !== null) {
      setJoinError(error)
      setJoinOpen(true)
      return
    }
    setJoinError(null)
    setJoinOpen(false)
    if (roomId !== null) props.onRoomOpened?.()
  }

  return (
    <div className="flex h-full w-64 flex-col gap-4 overflow-y-auto border-r border-border bg-surface p-3 text-sm">
      <RoomList
        rooms={roomList}
        recentRooms={recentRooms}
        showRecents={rememberRooms}
        activeRoomId={activeRoomId}
        onOpenRoom={openRoom}
        onLeaveRoom={(roomId) => leaveRoom(roomId)}
        onJoinByName={(name) => void joinByName(name)}
      />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setJoinOpen((open) => !open)}
          aria-expanded={joinFormOpen}
          className="rounded-md border border-border px-2 py-1.5 text-left text-sm font-medium hover:border-accent"
        >
          [+ Join]
        </button>
        {joinFormOpen && (
          <JoinRoomPopover
            // Issue #87: a rejected joinByName (e.g. the RF-02 cap) surfaces
            // inside this popover; onJoined/onDismiss clear it with it.
            // Issue #99: an executor request prefills the name.
            initialName={joinPopoverName ?? undefined}
            managerError={joinError}
            onJoined={() => {
              setJoinOpen(false)
              setJoinError(null)
              closeJoinPopover()
              props.onRoomOpened?.()
            }}
            onDismiss={() => {
              setJoinOpen(false)
              setJoinError(null)
              closeJoinPopover()
            }}
          />
        )}
      </div>

      <PeerList room={activeRoom} />

      <DmList
        channels={dmList}
        activePeerId={activeDmPeerId}
        onOpenDm={openDm}
        onOpenInvite={props.onOpenManualDm}
        onOpenContact={props.onOpenContact}
      />
    </div>
  )
}
