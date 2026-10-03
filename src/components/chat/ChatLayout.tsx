import { useEffect, useMemo, useState } from 'react'
import { Sidebar } from '../sidebar/Sidebar'
import { ChatHeader } from './ChatHeader'
import { MessageFeed } from './MessageFeed'
import { TypingBar } from './TypingBar'
import { ChatInput } from './ChatInput'
import { DmHeader } from '../dm/DmHeader'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useLatency } from '../../hooks/useLatency'
import { useNotifications } from '../../hooks/useNotifications'
import { dmFeedLabel } from '../../lib/feed'
import { joinRoom } from '../../lib/p2p/roomManager'

/** Spec §10.1 — at this width the sidebar becomes an overlay drawer. */
const MOBILE_QUERY = '(max-width: 768px)'

/**
 * Chat shell (spec §10.1): collapsible sidebar (persisted collapse state
 * under `gritos:ui`, Ctrl/Cmd+B shortcut, overlay drawer ≤768 px) around
 * the main area — header, feed, typing bar and composer. The active view is
 * either a room or a 1:1 DM (RF-04): the DM view reuses the same feed,
 * typing bar and composer with the fingerprint header. Switching views
 * never touches the room connections (RF-02).
 */
export function ChatLayout() {
  const isMobile = useMediaQuery(MOBILE_QUERY)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const activeView = useAppStore((state) => state.activeView)
  const rooms = useAppStore((state) => state.rooms)
  const dms = useAppStore((state) => state.dms)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useNotifications()

  // RF-01/RF-07 — auto-join #lobby on start when the setting is on. The
  // manager dedups concurrent/in-flight joins (StrictMode, onboarding race).
  useEffect(() => {
    if (!useSettingsStore.getState().settings.autoJoinLobby) return
    void joinRoom('lobby')
      .then((connection) => {
        if (useAppStore.getState().activeView === null) {
          useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
        }
      })
      .catch(() => {
        // Cap reached or invalid name: nothing to auto-join; the sidebar
        // remains available.
      })
  }, [])

  // Ctrl/Cmd+B toggles the sidebar (§10.1): collapse on desktop, drawer on
  // mobile.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'b'
      ) {
        event.preventDefault()
        if (isMobile) setDrawerOpen((open) => !open)
        else toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMobile, toggleSidebar])

  const activeRoom = activeView?.kind === 'room' ? (rooms[activeView.id] ?? null) : null
  const activeDm =
    activeView?.kind === 'dm' ? (dms[activeView.peerId] ?? null) : null
  useLatency(activeRoom?.id ?? null)

  // The DM feed reuses the room components: the remote peer rides in as a
  // one-entry peer list (mention candidates, typing bar, author colors).
  const dmPeers = useMemo(
    () =>
      activeDm === null
        ? []
        : [
            {
              id: activeDm.peerId,
              nickname: activeDm.peerNick,
              fingerprint: activeDm.peerFingerprint,
              latencyMs: null,
              degraded: false,
            },
          ],
    [activeDm],
  )

  const sidebar = <Sidebar onRoomOpened={() => setDrawerOpen(false)} />

  const desktopAsideVisible = !isMobile && !sidebarCollapsed
  const drawerVisible = isMobile && drawerOpen

  return (
    <div className="flex h-screen overflow-hidden">
      {desktopAsideVisible && <aside className="shrink-0">{sidebar}</aside>}

      {drawerVisible && (
        <div
          className="fixed inset-0 z-30 flex"
          role="dialog"
          aria-modal="true"
          aria-label="Barra lateral"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="relative h-full shadow-xl">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {activeDm !== null ? (
          <DmHeader
            channel={activeDm}
            onToggleSidebar={() => {
              if (isMobile) setDrawerOpen((open) => !open)
              else toggleSidebar()
            }}
          />
        ) : (
          <ChatHeader
            room={activeRoom}
            onToggleSidebar={() => {
              if (isMobile) setDrawerOpen((open) => !open)
              else toggleSidebar()
            }}
          />
        )}
        {activeDm !== null ? (
          <>
            <MessageFeed
              key={`dm:${activeDm.peerId}`}
              messages={activeDm.messages}
              peers={dmPeers}
              fifoTrimmed={false}
              ariaLabel={dmFeedLabel(activeDm.peerNick)}
            />
            <TypingBar typing={activeDm.typing} peers={dmPeers} />
            <ChatInput dm={{ peerId: activeDm.peerId, available: activeDm.available }} />
          </>
        ) : activeRoom === null ? (
          <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-muted">
              No hay ninguna sala activa. Únete a una desde la barra lateral (tecla Ctrl/Cmd+B para
              mostrarla).
            </p>
          </main>
        ) : (
          <>
            <MessageFeed
              key={activeRoom.id}
              messages={activeRoom.messages}
              peers={activeRoom.peers}
              fifoTrimmed={activeRoom.fifoTrimmed}
              ariaLabel={`Mensajes de #${activeRoom.name}`}
            />
            <TypingBar typing={activeRoom.typing} peers={activeRoom.peers} />
            <ChatInput room={activeRoom} />
          </>
        )}
      </div>
    </div>
  )
}
