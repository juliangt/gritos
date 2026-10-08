import { useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from '../sidebar/Sidebar'
import { ChatHeader } from './ChatHeader'
import { MessageFeed } from './MessageFeed'
import { TypingBar } from './TypingBar'
import { ChatInput } from './ChatInput'
import { NetworkErrorBanner } from './NetworkErrorBanner'
import { JoinRoomPopover } from '../sidebar/JoinRoomPopover'
import { DmHeader } from '../dm/DmHeader'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useLatency } from '../../hooks/useLatency'
import { useNotifications } from '../../hooks/useNotifications'
import { dmFeedLabel, EMPTY_DM_FEED_TEXT, EMPTY_ROOM_FEED_TEXT } from '../../lib/feed'
import { clearRoomHash, parseRoomHash } from '../../lib/shareLinks'
import { joinRoom } from '../../lib/p2p/roomManager'

/** Spec §10.1 — at this width the sidebar becomes an overlay drawer. */
const MOBILE_QUERY = '(max-width: 768px)'

/** Invisible mount that runs the RF-06 ping/pong loop of ONE active room. */
function RoomLatencyLoop(props: { roomId: string }) {
  useLatency(props.roomId)
  return null
}

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
  // Issue #41 — name of the room this session entered through a '#sala'
  // deep link, kept only to offer the password join form when that room
  // cannot find peers (linked password rooms are indistinguishable from
  // nonexistent ones until then, RF-05).
  const [linkedRoomName, setLinkedRoomName] = useState<string | null>(null)

  useNotifications()

  // RF-01/RF-07 — auto-join #lobby on start when the setting is on. The
  // manager dedups concurrent/in-flight joins (StrictMode, onboarding race).
  // Outside a secure context (plain HTTP on a LAN IP) Web Crypto is
  // unavailable and every join would reject: skip the attempt entirely —
  // NetworkErrorBanner explains why (issue #43).
  useEffect(() => {
    if (!window.isSecureContext) return
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

  // Issue #41 — '#sala=<name>' deep links: the linked room is the
  // destination, so it joins on boot and takes the focus even when the
  // lobby auto-join above also runs. The hash is consumed up front (a
  // reload must never re-trigger the join) and never carries the password
  // (RF-05); a failed join (cap, invalid name) degrades to the current
  // behavior — the sidebar remains available.
  useEffect(() => {
    if (!window.isSecureContext) return
    const name = parseRoomHash(window.location.hash)
    clearRoomHash()
    if (name === null) return
    void joinRoom(name)
      .then((connection) => {
        setLinkedRoomName(name)
        useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
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

  // RNF-05/issue #48 — the mobile drawer closes with Esc, moves the focus
  // into itself when opened and traps Tab inside (issue #48: with
  // role="dialog" aria-modal="true" the focus must never reach the chat
  // behind it); on close the focus returns to the ☰ toggle.
  const drawerVisible = isMobile && drawerOpen
  const drawerPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])
  useFocusTrap({ open: drawerVisible, panelRef: drawerPanelRef })

  const activeRoom = activeView?.kind === 'room' ? (rooms[activeView.id] ?? null) : null
  const activeDm =
    activeView?.kind === 'dm' ? (dms[activeView.peerId] ?? null) : null

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

  return (
    <div className="flex h-screen overflow-hidden">
      {/* RF-06 — latency is measured per room, not only for the focused one:
          every active room runs its own ping/pong loop. */}
      {Object.keys(rooms).map((roomId) => (
        <RoomLatencyLoop key={roomId} roomId={roomId} />
      ))}

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
          <div
            ref={drawerPanelRef}
            tabIndex={-1}
            className="relative h-full shadow-xl focus:outline-none"
          >
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <NetworkErrorBanner />
        {/* Issue #41 — a room entered through a share link that exhausted
            the not-found heuristic may simply need its password (RF-05:
            indistinguishable from a nonexistent room): offer the regular
            join form, prefilled, so the password can be entered. The form
            never reaches the URL or storage. */}
        {activeRoom !== null &&
          linkedRoomName === activeRoom.name &&
          activeRoom.status === 'error' && (
            <section
              aria-label="Unirse con contraseña"
              className="flex flex-col items-center gap-2 border-b border-border bg-surface px-3 py-3"
            >
              <p className="text-xs text-muted">Si la sala tiene contraseña, únete con ella:</p>
              <div className="w-full max-w-xs">
                <JoinRoomPopover
                  initialName={activeRoom.name}
                  // Keeping the name on join lets the form come back when a
                  // wrong password exhausts the heuristic again; only an
                  // explicit dismiss retires the recovery offer.
                  onDismiss={() => setLinkedRoomName(null)}
                />
              </div>
            </section>
          )}
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
              emptyStateText={EMPTY_DM_FEED_TEXT}
            />
            <TypingBar typing={activeDm.typing} peers={dmPeers} />
            <ChatInput
              dm={{
                peerId: activeDm.peerId,
                available: activeDm.available,
                legacyPeer: activeDm.legacyPeer,
              }}
            />
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
              emptyStateText={EMPTY_ROOM_FEED_TEXT}
            />
            <TypingBar typing={activeRoom.typing} peers={activeRoom.peers} />
            <ChatInput room={activeRoom} />
          </>
        )}
      </div>
    </div>
  )
}
