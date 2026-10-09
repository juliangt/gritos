import { useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from '../sidebar/Sidebar'
import { ChatHeader } from './ChatHeader'
import { MessageFeed } from './MessageFeed'
import { TypingBar } from './TypingBar'
import { ChatInput } from './ChatInput'
import { FileTransferCards } from './FileTransferCards'
import { NetworkErrorBanner } from './NetworkErrorBanner'
import { JoinRoomPopover } from '../sidebar/JoinRoomPopover'
import { DmHeader } from '../dm/DmHeader'
import { ManualDmWizard } from '../dm/ManualDmWizard'
import { ContactFlow } from '../dm/ContactFlow'
import { KnockConsentCards } from '../dm/KnockConsentCards'
import { SlashHelpModal } from './SlashHelpModal'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { useAppStore } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useLatency } from '../../hooks/useLatency'
import { useExpirySweep } from '../../hooks/useExpirySweep'
import { useFileTransfers } from '../../hooks/useFileTransfers'
import { useNotifications } from '../../hooks/useNotifications'
import { dmFeedLabel, EMPTY_DM_FEED_TEXT, EMPTY_ROOM_FEED_TEXT } from '../../lib/feed'
import { clearRoomHash, parseContactHash, parseRoomHash } from '../../lib/shareLinks'
import { joinRoom, requestHistory } from '../../lib/p2p/roomManager'
import {
  CLEAR_FEED_DIALOG_BODY,
  CLEAR_FEED_DIALOG_CONFIRM,
  CLEAR_FEED_DIALOG_TITLE,
} from '../settings/messages'

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
  // Issue #103 phase 4 — the §12.4 transfer records drive the consent/
  // progress cards; the engine's module map stays the only owner (memory-
  // only, no store), this is purely the reactive view onto it.
  const fileTransfers = useFileTransfers()
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  // Issue #99 — slash-command seams: the /help overlay, the /clear
  // confirmation and the password-recovery offer armed by a /room join.
  // All session-only ui-store fields (never persisted).
  const helpOpen = useUiStore((state) => state.helpOpen)
  const closeHelp = useUiStore((state) => state.closeHelp)
  const clearFeedOpen = useUiStore((state) => state.clearFeedOpen)
  const cancelClearFeed = useUiStore((state) => state.cancelClearFeed)
  const slashRecoveryRoom = useUiStore((state) => state.recoveryRoom)
  const clearPasswordRecovery = useUiStore((state) => state.clearPasswordRecovery)
  const activeView = useAppStore((state) => state.activeView)
  const rooms = useAppStore((state) => state.rooms)
  const dms = useAppStore((state) => state.dms)
  const manualDms = useAppStore((state) => state.manualDms)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Issue #97 — the manual-DM wizard is layout-level state: both entry
  // points (sidebar «+ invitación», tracker-error banner shortcut) flip it
  // and the modal renders once, over everything.
  const [manualWizardOpen, setManualWizardOpen] = useState(false)
  // Issue #105 — the contact flow is layout-level state like the wizard:
  // the sidebar «+ contact» entry opens it, and a `#contact=<fp>` deep
  // link opens it prefilled with the linked fingerprint. The linked fp is
  // read ONCE in this lazy initializer (the OnboardingScreen linked-room
  // precedent) — an invalid fp routes nothing, ignored at log level. The
  // flow works with the channel off too: the knock attempt surfaces the
  // honest typed 'signal-off' line pointing at the Privacy toggle.
  const [contactFlow, setContactFlow] = useState<{ open: boolean; prefill: string | null }>(() => {
    const fp = parseContactHash(window.location.hash)
    return fp === null ? { open: false, prefill: null } : { open: true, prefill: fp }
  })
  // The linked hash is consumed up front (a reload must never re-trigger
  // the flow); this is an external-URL update, never React state.
  useEffect(() => {
    if (contactFlow.open) clearRoomHash()
  }, [contactFlow.open])
  // The opt-in drives the contact surface's visibility; the flow itself is
  // closed when the channel turns off mid-flow (its knock could never
  // resolve with the swarm gone).
  const globalDm = useSettingsStore((state) => state.settings.globalDm)
  // Issue #41 — name of the room this session entered through a '#room'
  // deep link, kept only to offer the password join form when that room
  // cannot find peers (linked password rooms are indistinguishable from
  // nonexistent ones until then, RF-05).
  const [linkedRoomName, setLinkedRoomName] = useState<string | null>(null)

  useNotifications()

  // Issue #96 — one session-wide 1 s tick expires TTL messages from every
  // room and DM feed (DM channels outlive rooms, so this is app-scoped).
  useExpirySweep()

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

  // Issue #41 — '#room=<name>' deep links: the linked room is the
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

  // Issue #105 — toggle off MID-FLOW: the «+ contacto» entry hides (the
  // DmList reads the setting), the consent cards clear (their component
  // remounts through the key below) and an open contact dialog closes —
  // with the swarm gone its knock could never resolve. Only a true→false
  // TRANSITION closes the dialog: a deep link may open the flow while the
  // setting is still off, and that must not be undone on mount.
  const prevGlobalDmRef = useRef(globalDm)
  useEffect(() => {
    const wasOn = prevGlobalDmRef.current
    prevGlobalDmRef.current = globalDm
    if (wasOn && !globalDm) setContactFlow({ open: false, prefill: null })
  }, [globalDm])

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
  // Issue #97 — a manual channel key (`manual:<fp>`) resolves from its own
  // slice; room-backed channels are looked up first (the maps are disjoint).
  const activeDm =
    activeView?.kind === 'dm'
      ? (dms[activeView.peerId] ?? manualDms[activeView.peerId] ?? null)
      : null

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

  const sidebar = (
    <Sidebar
      onRoomOpened={() => setDrawerOpen(false)}
      onOpenManualDm={() => setManualWizardOpen(true)}
      onOpenContact={() => setContactFlow({ open: true, prefill: null })}
    />
  )

  // Issue #102 phase 3 — the history-request card policy for the ACTIVE
  // room: offered only while the feed holds no chat rows yet (system join/
  // leave lines don't count) and not already dismissed this join. Either
  // button dismisses (memory-only, per join); [Pedir] routes through the
  // manager's requestHistory, whose per-room ask budget rate-limits repeat
  // joins — the card never asks automatically and disappears on tap.
  const offerHistoryAsk =
    activeRoom !== null &&
    !activeRoom.historyAskDismissed &&
    !activeRoom.messages.some((message) => message.kind !== 'system')
  const historyAsk = offerHistoryAsk
    ? {
        onAsk: () => {
          if (activeRoom === null) return
          requestHistory(activeRoom.id)
          useAppStore.getState().dismissHistoryAsk(activeRoom.id)
        },
        onDismiss: () => {
          if (activeRoom === null) return
          useAppStore.getState().dismissHistoryAsk(activeRoom.id)
        },
      }
    : undefined

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
          aria-label="Sidebar"
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
        <NetworkErrorBanner onOpenManualDm={() => setManualWizardOpen(true)} />
        {/* Issue #105 — inbound-knock consent cards: a non-blocking strip
            answerable wherever the user is; nothing renders while the
            global-DM opt-in is off (or no knocks are pending). The key
            remounts the strip on toggle flips: the manager drops every
            inbound knock on teardown, so stale cards must not resurface
            when the channel comes back. */}
        <KnockConsentCards key={globalDm ? 'global-dm-on' : 'global-dm-off'} />
        {/* Issue #41 — a room entered through a share link that exhausted
            the not-found heuristic may simply need its password (RF-05:
            indistinguishable from a nonexistent room): offer the regular
            join form, prefilled, so the password can be entered. The form
            never reaches the URL or storage. Issue #99 — /room arms the
            same recovery for its name-only join (password rooms are
            undetectable from the name): the first source with a matching
            name wins, and dismissing either clears both. */}
        {activeRoom !== null &&
          (linkedRoomName ?? slashRecoveryRoom) === activeRoom.name &&
          activeRoom.status === 'error' && (
            <section
              aria-label="Join with password"
              className="flex flex-col items-center gap-2 border-b border-border bg-surface px-3 py-3"
            >
              <p className="text-xs text-muted">If the room has a password, join with it:</p>
              <div className="w-full max-w-xs">
                <JoinRoomPopover
                  initialName={activeRoom.name}
                  // Keeping the name on join lets the form come back when a
                  // wrong password exhausts the heuristic again; only an
                  // explicit dismiss retires the recovery offer.
                  onDismiss={() => {
                    setLinkedRoomName(null)
                    clearPasswordRecovery()
                  }}
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
              expiredCount={activeDm.expiredCount}
              recoveredCount={0}
              ariaLabel={dmFeedLabel(activeDm.peerNick)}
              emptyStateText={EMPTY_DM_FEED_TEXT}
            />
            {/* Issue #103 phase 4 — the transfer strip of the DM view: every
                record with this peer (an incoming room-kind transfer from
                the same peer is that peer's transfer all the same). */}
            <FileTransferCards
              records={fileTransfers.visibleWithPeer(activeDm.peerId)}
              peerNick={(peerId) => (peerId === activeDm.peerId ? activeDm.peerNick : null)}
              onAccept={fileTransfers.accept}
              onDecline={fileTransfers.decline}
              onCancel={fileTransfers.cancel}
              onDismiss={fileTransfers.dismiss}
            />
            <TypingBar typing={activeDm.typing} peers={dmPeers} />
            <ChatInput
              dm={{
                peerId: activeDm.peerId,
                available: activeDm.available,
                legacyPeer: activeDm.legacyPeer,
                // Issue #97 — trackerless manual channels route the composer
                // through the manualDmManager, not the room DM paths.
                manual: activeDm.manual === true,
                // Issue #105 — signal-backed channels route the composer
                // through the signal channel manager, not the room paths.
                global: activeDm.global === true,
                // Issue #103 phase 4 — the file dialog's fixed recipient line.
                peerNick: activeDm.peerNick,
              }}
            />
          </>
        ) : activeRoom === null ? (
          <main className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-muted">
              No active room. Join one from the sidebar (press Ctrl/Cmd+B to show it).
            </p>
          </main>
        ) : (
          <>
            <MessageFeed
              key={activeRoom.id}
              messages={activeRoom.messages}
              peers={activeRoom.peers}
              fifoTrimmed={activeRoom.fifoTrimmed}
              expiredCount={activeRoom.expiredCount}
              recoveredCount={activeRoom.recoveredCount}
              ariaLabel={`Messages in #${activeRoom.name}`}
              emptyStateText={EMPTY_ROOM_FEED_TEXT}
              historyAsk={historyAsk}
            />
            {/* Issue #103 phase 4 — the transfer strip of the room view: the
                room's swarm minus the DM-kind sends (those stay scoped to
                their DM view). Card position is §12.4's UI call: a strip of
                its own below the feed, never a feed row. */}
            <FileTransferCards
              records={fileTransfers.visibleInRoom(activeRoom.id)}
              peerNick={(peerId) =>
                activeRoom.peers.find((peer) => peer.id === peerId)?.nickname ?? null
              }
              onAccept={fileTransfers.accept}
              onDecline={fileTransfers.decline}
              onCancel={fileTransfers.cancel}
              onDismiss={fileTransfers.dismiss}
            />
            <TypingBar typing={activeRoom.typing} peers={activeRoom.peers} />
            <ChatInput room={activeRoom} />
          </>
        )}
      </div>

      {/* Issue #97 — one wizard instance for both entry points; Esc and the
          backdrop cancel the pending flow (engine dispose, no traces). */}
      <ManualDmWizard open={manualWizardOpen} onClose={() => setManualWizardOpen(false)} />

      {/* Issue #105 — one contact-flow instance for both entry points
          (sidebar «+ contact», `#contact=` deep link prefill); the
          toggle-off effect above closes it with the channel. */}
      <ContactFlow
        open={contactFlow.open}
        initialFp={contactFlow.prefill}
        onClose={() => setContactFlow({ open: false, prefill: null })}
      />

      {/* Issue #99 — /help overlay: the command table renders straight from
          SLASH_COMMANDS; Esc/backdrop close through the Modal base. */}
      <SlashHelpModal open={helpOpen} onClose={closeHelp} />

      {/* Issue #99 — /clear confirmation (the mute-with-DM ConfirmDialog
          pattern): only an explicit confirm wipes the ACTIVE room's local
          feed; cancel and Esc leave it untouched. */}
      <ConfirmDialog
        open={clearFeedOpen}
        title={CLEAR_FEED_DIALOG_TITLE}
        body={CLEAR_FEED_DIALOG_BODY}
        confirmLabel={CLEAR_FEED_DIALOG_CONFIRM}
        onConfirm={() => {
          cancelClearFeed()
          if (activeView?.kind === 'room') useAppStore.getState().clearRoomFeed(activeView.id)
        }}
        onCancel={cancelClearFeed}
      />
    </div>
  )
}
