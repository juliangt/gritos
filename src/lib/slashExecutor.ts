/**
 * Slash-command executor (issue #99, Phase 2): dispatches a
 * `parseSlashCommand` result against a context of UI seams. Pure dispatch —
 * no React, no DOM — so every command is testable headlessly; the composer
 * (Phase 3) supplies the real context and owns the sending.
 *
 * SEND MODEL (deliberate): the executor NEVER sends. Message-send commands
 * come back as directives ({type: 'send-chat'}) that the composer executes
 * through its existing path, so the 4000-char cap, the typing signals, the
 * TTL selector and the manual-DM routing stay in exactly one place
 * (ChatInput.submit). Everything else performs its local side effects right
 * away through the context and resolves to {type: 'none'}. /me therefore
 * returns a directive too — with `isAction: true`, which the composer
 * forwards to sendChat so the LOCAL echo renders as the italic
 * "*nick action*" row (Message.isAction, memory-only; the wire envelope is
 * byte-identical, so peers see plain text — the documented asymmetry of the
 * no-protocol-change rendering convention).
 *
 * ERROR/FEEDBACK MODEL: every local line goes through
 * `ctx.appendSystemLine` (the issue-#95 mute-line pattern: a local system
 * row in the focused feed, never on the wire). Parse-level errors print the
 * owning libs' wording (`errors.nicknameInvalid`, `settings.invalidRoomName`)
 * plus the row's usage through the `slash.errorWithUsage` template; unknown
 * verbs print `slash.unknownCommand` and never send. All lines resolve
 * through `t()` at call time (issue #119: locale-live).
 *
 * /room AND PASSWORD ROOMS: a room's password-ness is undetectable from the
 * name alone (password rooms derive a different roomId — RF-05; a linked
 * password room is indistinguishable from a nonexistent one until the
 * heuristic exhausts). So /room joins directly through the focused-join
 * path, surfaces a rejection (the RF-02 cap message, issue #87 wording) as
 * a local line, and on success ARMS the password-recovery offer
 * (useUiStore.recoveryRoom): ChatLayout then shows the prefilled
 * JoinRoomPopover for that room if it ends up peerless ('error' state) —
 * the popover flow, triggered exactly when the password is actually needed.
 */

import { joinRoom, leaveRoom, openDmChannel, setNickname } from './p2p/roomManager'
import { t } from '../i18n/index'
import {
  activeRoomsLine,
  dmAmbiguousLine,
  dmPeerNotFoundLine,
  nicknameChangedLine,
} from './feed'
import { slashUsageText, type SlashCommand } from './slashCommands'
import { useAppStore, type Message } from '../stores/useAppStore'
import { useUiStore } from '../stores/useUiStore'

/** What the composer must do after the executor handled a parse result. */
export type SlashDirective =
  /**
   * Send `text` through the composer's own send path — "send-chat" names
   * the room path, but the directive is mode-agnostic on purpose: the
   * composer routes by view, so in a DM composer the same directive goes
   * out as sendDm/sendManualDm (a DM-mode /me is a DM action prose; the
   * DM seams have no isAction parameter, so the local italic echo is a
   * room-path-only convention).
   */
  | { type: 'send-chat'; text: string; /** /me marker: LOCAL italic echo only. */ isAction?: true }
  /** The command fully performed its local effects; nothing to send. */
  | { type: 'none' }

/**
 * The seams one command may need. Bound to the real stores/manager by
 * `createSlashExecutorContext`; tests supply fakes. Kept minimal and
 * effect-shaped so the executor stays a dispatcher.
 */
export interface SlashExecutorContext {
  /** Local system-style line in the focused feed (RF-06 local-line path). */
  appendSystemLine(text: string): void
  /**
   * RF-01 rename via the manager (`lib/p2p/roomManager.setNickname` — the
   * seam the issue asks for; already manager-owned): store + identity +
   * `gritos:identity` re-persist + presence re-announce. Throws
   * NicknameError on invalid input.
   */
  setNickname(nickname: string): void
  /**
   * Focused join (manager.joinRoom + setActiveView, the
   * useRoomManager.joinRoomFocused path). `error` carries the exact manager
   * wording — the RF-02 cap message among others (issue #87).
   */
  joinRoomFocused(name: string): Promise<{ roomId: string | null; error: string | null }>
  /** Arms the password-recovery form for a room joined by name (see above). */
  armPasswordRecovery(name: string): void
  /** Peers of the focused room — the mention-candidate source (RF-04). */
  activePeers(): ReadonlyArray<{ id: string; nickname: string }>
  /** Opens (and focuses) the DM channel with a connected peer; false if gone. */
  openDmChannel(peerId: string): boolean
  /** Active rooms with their unread badges, in join order. */
  activeRooms(): ReadonlyArray<{ id: string; name: string; unread: number }>
  /** The focused room, or null outside a room view. */
  activeRoom(): { id: string; name: string } | null
  /** Opens the /clear confirmation dialog; the dialog performs the wipe. */
  requestClearConfirmation(): void
  /** Leaves a room — the same manager path the sidebar menu action uses. */
  leaveRoom(roomId: string): void
  /** Opens the /help overlay. */
  openHelp(): void
}

/**
 * Local-line wording for a parse-level rejection. missing-arg/extra-args
 * print the usage; charset failures lead with the owning lib's validation
 * text (what the settings modal / join popover show inline) and append the
 * usage — ONE `slash.errorWithUsage` template so a locale can reorder the
 * clauses. Wording reuses the parser's documented owners — never re-worded
 * here. Locale-live (resolves at call time).
 */
export function slashErrorLine(result: Extract<SlashCommand, { kind: 'error' }>): string {
  const usage = slashUsageText(result.verb)
  switch (result.error) {
    case 'invalid-nick':
      return t('slash.errorWithUsage', { error: t('errors.nicknameInvalid'), usage })
    case 'invalid-room':
      return t('slash.errorWithUsage', { error: t('settings.invalidRoomName'), usage })
    case 'missing-arg':
    case 'extra-args':
      return usage
  }
}

/**
 * Executes one parsed composer input. Await it (only /room is genuinely
 * async); the returned directive tells the composer what — if anything — to
 * send. Unknown verbs and rejected arguments NEVER produce a directive:
 * they only print a local line.
 */
export async function executeSlashCommand(
  result: SlashCommand,
  ctx: SlashExecutorContext,
): Promise<SlashDirective> {
  switch (result.kind) {
    case 'literal':
      // Escape hatch: the backslash is already stripped by the parser.
      return { type: 'send-chat', text: result.text }
    case 'unknown':
      ctx.appendSystemLine(t('slash.unknownCommand'))
      return { type: 'none' }
    case 'error':
      ctx.appendSystemLine(slashErrorLine(result))
      return { type: 'none' }
    case 'command':
      break
  }

  switch (result.verb) {
    case 'nick': {
      try {
        // Unchanged nicks no-op inside the manager (no re-announce); the
        // confirmation line is still accurate from the user's perspective.
        ctx.setNickname(result.nickname)
        ctx.appendSystemLine(nicknameChangedLine(result.nickname))
      } catch (error) {
        // Defense in depth: the parser already gates with the same RF-01
        // rules; a NicknameError here can only come from a drift between
        // the two gates — surface the manager's own message.
        ctx.appendSystemLine(error instanceof Error ? error.message : t('errors.nicknameInvalid'))
      }
      return { type: 'none' }
    }
    case 'room': {
      const { error } = await ctx.joinRoomFocused(result.room)
      if (error !== null) {
        // The manager owns the wording (e.g. the RF-02 cap message of the
        // issue #87 fix); print it verbatim as a local line.
        ctx.appendSystemLine(error)
        return { type: 'none' }
      }
      // Password flow: arm the recovery popover for this room (see module
      // docblock) — the prefilled form appears only if the name-only join
      // cannot find peers.
      ctx.armPasswordRecovery(result.room)
      return { type: 'none' }
    }
    case 'dm': {
      // Mention-candidate source, mention matching rules: the focused
      // room's peers, case-INSENSITIVE exact-nickname comparison (mentions
      // match case-insensitively at render/notification time — lib/markdown
      // parseInline). Self is never a candidate (peers exclude self; you
      // cannot DM yourself). Ambiguity errors instead of guessing.
      const target = result.nick.trim().toLowerCase()
      const matches = ctx.activePeers().filter((peer) => peer.nickname.toLowerCase() === target)
      const match = matches[0]
      if (match === undefined) {
        ctx.appendSystemLine(dmPeerNotFoundLine(result.nick))
      } else if (matches.length > 1) {
        ctx.appendSystemLine(dmAmbiguousLine(result.nick))
      } else if (!ctx.openDmChannel(match.id)) {
        // The peer vanished between the read and the open (or lost its
        // nickname): same not-found wording, nothing else to do.
        ctx.appendSystemLine(dmPeerNotFoundLine(result.nick))
      }
      return { type: 'none' }
    }
    case 'me':
      // Rendering convention, not a wire change: the composer sends the
      // action text as a normal chat envelope and forwards isAction so the
      // LOCAL echo renders italic (see module docblock).
      return { type: 'send-chat', text: result.action, isAction: true }
    case 'rooms':
      ctx.appendSystemLine(activeRoomsLine(ctx.activeRooms()))
      return { type: 'none' }
    case 'clear': {
      const room = ctx.activeRoom()
      if (room === null) {
        ctx.appendSystemLine(t('slash.noActiveRoom'))
        return { type: 'none' }
      }
      // Memory-only wipe, behind the ConfirmDialog (the mute-with-DM
      // precedent): the dialog's confirm calls clearRoomFeed(room.id).
      ctx.requestClearConfirmation()
      return { type: 'none' }
    }
    case 'leave': {
      const room = ctx.activeRoom()
      if (room === null) {
        ctx.appendSystemLine(t('slash.noActiveRoom'))
        return { type: 'none' }
      }
      // Exactly the sidebar's leave path (RoomList → useRoomManager.leaveRoom
      // → manager.leaveRoom); the view degrades like after a menu leave.
      ctx.leaveRoom(room.id)
      return { type: 'none' }
    }
    case 'help':
      ctx.openHelp()
      return { type: 'none' }
  }
}

// ---------------------------------------------------------------------------
// Real context — binds the seams to the stores and the manager. Lives here
// (not in a hook) so non-React callers (debug panel, tests, the Phase-3
// composer before mount) can use the same wiring; the UI store makes every
// flip observable headlessly.
// ---------------------------------------------------------------------------

/** The system-row shape of the RF-06 local lines (mirrors the manager's). */
function systemMessage(roomId: string, text: string): Message {
  return {
    id: crypto.randomUUID(),
    roomId,
    authorId: 'system',
    authorNick: '',
    text,
    ts: Date.now(),
    encrypted: false,
    status: 'delivered',
    kind: 'system',
  }
}

/**
 * One local system line in the FOCUSED feed: the active room's feed when a
 * room is focused; otherwise the focused DM channel (room-backed or manual —
 * the composer exists there too). Dropped silently without any focused view:
 * there is no feed to print into, like appendMuteLineToActiveRoom.
 */
function appendLineToFocusedFeed(text: string): void {
  const state = useAppStore.getState()
  const view = state.activeView
  if (view === null) return
  if (view.kind === 'room') {
    if (state.rooms[view.id] === undefined) return
    state.appendMessage(view.id, systemMessage(view.id, text))
    return
  }
  if (state.dms[view.peerId] !== undefined) {
    state.appendDmMessage(view.peerId, systemMessage(`dm:${view.peerId}`, text))
  } else if (state.manualDms[view.peerId] !== undefined) {
    // Issue #97 convention: manual channels carry roomId `dm:manual:<fp>`.
    state.appendManualDmMessage(view.peerId, systemMessage(`dm:${view.peerId}`, text))
  }
}

/**
 * Focused join, headless twin of useRoomManager.joinRoomFocused: the manager
 * dedups concurrent joins; the focus clears the room's unread (RF-02).
 */
async function joinFocused(name: string): Promise<{ roomId: string | null; error: string | null }> {
  try {
    const connection = await joinRoom(name)
    useAppStore.getState().setActiveView({ kind: 'room', id: connection.roomId })
    return { roomId: connection.roomId, error: null }
  } catch (error) {
    return {
      roomId: null,
      // The manager owns the wording (the errors.* templates); a non-Error
      // rejection falls back to the shared `errors.unknown` line (#119).
      error: error instanceof Error ? error.message : t('errors.unknown'),
    }
  }
}

/** The production context: stores + manager, no React. */
export function createSlashExecutorContext(): SlashExecutorContext {
  return {
    appendSystemLine: appendLineToFocusedFeed,
    setNickname: setNickname,
    joinRoomFocused: joinFocused,
    armPasswordRecovery: (name) => useUiStore.getState().armPasswordRecovery(name),
    activePeers: () => {
      const state = useAppStore.getState()
      const view = state.activeView
      if (view?.kind !== 'room') return []
      return state.rooms[view.id]?.peers ?? []
    },
    openDmChannel: openDmChannel,
    activeRooms: () =>
      Object.values(useAppStore.getState().rooms).map((room) => ({
        id: room.id,
        name: room.name,
        unread: room.unread,
      })),
    activeRoom: () => {
      const state = useAppStore.getState()
      const view = state.activeView
      if (view?.kind !== 'room') return null
      const room = state.rooms[view.id]
      return room === undefined ? null : { id: room.id, name: room.name }
    },
    requestClearConfirmation: () => useUiStore.getState().requestClearFeed(),
    leaveRoom: (roomId) => {
      void leaveRoom(roomId)
    },
    openHelp: () => useUiStore.getState().openHelp(),
  }
}
