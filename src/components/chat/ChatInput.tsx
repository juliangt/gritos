import { useCallback, useEffect, useRef, useState, useLayoutEffect, type FormEvent } from 'react'
import { CHAR_COUNTER_FROM, TYPING_IDLE_STOP_MS, TYPING_SIGNAL_THROTTLE_MS } from '../../lib/feed'
import { MAX_MESSAGE_TTL_S, MAX_PLAINTEXT_LENGTH, MIN_MESSAGE_TTL_S } from '../../lib/p2p/protocol'
import { useT } from '../../i18n/index'
import type { Room } from '../../stores/useAppStore'
import { useRoomManager } from '../../hooks/useRoomManager'
import { useFileTransfers } from '../../hooks/useFileTransfers'
import { FileSendDialog } from './FileSendDialog'
import {
  SLASH_COMMANDS,
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandDef,
} from '../../lib/slashCommands'
import {
  createSlashExecutorContext,
  executeSlashCommand,
  slashErrorLine,
} from '../../lib/slashExecutor'

/** Visible textarea height: about 6 text lines (RF-03). */
const MAX_TEXTAREA_HEIGHT_PX = 144

/**
 * Issue #96 — per-message expiry choices (seconds). The edges track the
 * protocol bounds; the middle choice is the only free one. Labels are NOT
 * stored here: they resolve through `t` at render time (issue #119 — a
 * module-level label would freeze the boot locale).
 */
const TTL_CHOICES = [MIN_MESSAGE_TTL_S, 300, MAX_MESSAGE_TTL_S] as const

/** DOM id of the slash-candidate listbox (the textarea's aria-controls target). */
const SLASH_LISTBOX_ID = 'slash-command-listbox'

/** DOM id prefix of one slash-candidate option (the aria-activedescendant target). */
const SLASH_OPTION_ID_PREFIX = 'slash-command-option'

/**
 * Shape of a value while the verb token is being typed: a leading '/' and
 * no whitespace yet. This is what makes the popup a verb picker: it opens
 * on '/' (and '/n', '/h'…), stays open while the verb completes and closes
 * as soon as arguments begin ('/nick l…'). The escape hatch '\/…' never
 * matches — the value starts with the backslash, not the slash.
 */
const SLASH_TOKEN_PATTERN = /^\/\S*$/

/**
 * M3 — composer context for a DM view (RF-04).
 */
export interface DmComposerContext {
  peerId: string
  /** False once the peer shares no active room: sending is blocked. */
  available: boolean
  /**
   * Issue #93 (spec §12.1): true while the connected peer runs a legacy
   * build without a session-ephemeral `ephkeys` announce — sending is
   * blocked with an explicit hint (it could never open a v2 dm).
   */
  legacyPeer?: boolean
  /**
   * Issue #97 (spec §12.2): true for trackerless manual channels (key
   * `manual:<fp>`) — sends route through the manualDmManager instead of the
   * room paths.
   */
  manual?: boolean
  /**
   * Issue #105 (spec §12.5): true for signal-swarm channels (`global: true`,
   * keyed by the canonical fingerprint) — sends and typing route through the
   * signal channel manager instead of the room paths.
   */
  global?: boolean
  /**
   * Issue #103 phase 4 — the peer's display nickname for the pre-send file
   * dialog's fixed recipient line (absent → the raw peerId shows).
   */
  peerNick?: string
}

/**
 * Message composer (RF-03 / §10.4, reused by rooms and DMs per RF-04):
 * auto-growing textarea capped at 6 visible lines, Enter sends /
 * Shift+Enter breaks the line, 4000-character limit with a counter visible
 * from 3800 (sending blocked above the limit). Typing signals are
 * throttled to 1/s while composing and stop on send, blur or 2 s of idle.
 * Rooms queue locally while `searching`/`error` ('Queued until connected…');
 * a disconnected DM is hard-blocked with the exact RF-04 text and a legacy
 * (v1-build) peer with the issue #93 hint. A memory-only TTL selector (issue
 * #96) rides every send in both modes: it defaults to 'No expiry' and stays
 * on the picked value across consecutive sends until changed — never
 * persisted, so a reload resets it.
 *
 * Issue #99 (Phase 3) — slash commands: while the value is a lone '/token'
 * an inline candidate popup (ARIA combobox pattern) lists the verbs from
 * SLASH_COMMANDS filtered by the typed prefix; ↑ ↓ move, Enter/Tab pick,
 * Esc closes (a second Esc clears the inline hint), a mouse click picks
 * too — the options are never focusable, so focus stays on the textarea
 * throughout (mousedown's default focus shift is prevented). Picking a
 * zero-arg command runs it at once and clears the input; picking an
 * argument command fills '/verb ' with the caret at the end. On submit the
 * input goes through parseSlashCommand: non-slash text sends as always,
 * unknown verbs and rejected arguments show a transient inline hint
 * (role="status" region next to the controls, cleared on edit — the
 * static-region choice keeps the hint readable while the text to fix stays
 * in the input) and send nothing, and real commands run through the
 * executor whose send-chat directives (/me, the '\/' escape hatch) come
 * back through the SAME mode-aware send path as a normal message, so the
 * cap, the typing signals and the TTL pick still apply. In a DM view that
 * path is sendDm/sendManualDm: /me sends a DM there, while room-scoped
 * commands (/leave, /clear) naturally answer with the executor's
 * NO_ACTIVE_ROOM_TEXT line in the focused feed.
 */
export function ChatInput(props: { room?: Room; dm?: DmComposerContext }) {
  // Issue #119 — locale subscription: rendered strings (TTL labels, the
  // slash popup chrome, hints) resolve through `t` (live snapshot).
  const t = useT()
  const [value, setValue] = useState('')
  // Issue #96 — the TTL pick is component state on purpose: it persists
  // across consecutive sends (one decision covers a burst of expiring
  // messages) and dies with the tab; it never reaches the settings store.
  const [ttlDraft, setTtlDraft] = useState('')
  // Issue #99 — caret to place after the next commit (the '/verb ' fill of
  // a popup pick): applied in a layout effect once the DOM holds the value.
  // A ref on purpose — no re-render is needed just to remember the caret.
  const pendingCaretRef = useRef<number | null>(null)
  // Issue #99 — Esc closes the popup; typing re-opens it. Separated from
  // the value-shape so closing is explicit user intent, not a side effect.
  const [slashDismissed, setSlashDismissed] = useState(false)
  // Issue #99 — transient inline hint for a rejected submit (unknown verb,
  // parse-level error). Static role="status" region: appears on submit,
  // cleared on the next edit, a successful send or an Esc with the popup
  // already closed.
  const [hint, setHint] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Issue #103 phase 4 — the pre-send file dialog behind the attachment
  // button (room and DM modes; manual DM channels never offer it: the file
  // engine rides Trystero rooms only). Memory-only component state, like
  // every other composer affordance.
  const [fileDialogOpen, setFileDialogOpen] = useState(false)
  const fileTransfers = useFileTransfers()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingActiveRef = useRef(false)
  const lastTypingSentAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const {
    sendChat,
    sendTyping,
    sendDm,
    sendDmTyping,
    sendManualDm,
    sendManualDmTyping,
    sendGlobalDm,
    sendGlobalDmTyping,
  } = useRoomManager()

  const room = props.room
  const dm = props.dm
  // Room: not ready → local queue (§10.3). DM: not available or a legacy
  // peer (issue #93) → blocked.
  const ready = room !== undefined ? room.status === 'connected' : (dm?.available ?? false)
  const queued = room !== undefined && !ready
  const disconnected = dm !== undefined && !dm.available
  const legacyPeer = dm?.legacyPeer ?? false
  const blocked = disconnected || legacyPeer
  const overLimit = value.length > MAX_PLAINTEXT_LENGTH
  const canSend = !blocked && value.trim() !== '' && !overLimit
  const showCounter = value.length >= CHAR_COUNTER_FROM

  // Issue #99 — slash-candidate list: the typed verb prefix filters the
  // command table (fuzzy-prefix match: '/n' → /nick, '/h' → /help, a
  // bare '/' offers everything). No candidates (e.g. '/x') → no popup.
  const slashCandidates = SLASH_TOKEN_PATTERN.test(value)
    ? SLASH_COMMANDS.filter((def) => def.verb.startsWith(value.slice(1)))
    : []
  const slashOpen = !slashDismissed && slashCandidates.length > 0
  const activeCandidate = slashOpen ? slashCandidates[activeIndex] : undefined

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [])

  // Issue #99 — apply the caret promised by a popup pick ('/nick ' → end)
  // right after React commits the new value; then clear the promise. The
  // effect rides the value commits (the only ones that can follow a fill).
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    const element = textareaRef.current
    if (element !== null) element.setSelectionRange(caret, caret)
    pendingCaretRef.current = null
  }, [value])

  const stopTypingSignal = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false
      if (room !== undefined) sendTyping(room.id, false)
      else if (dm !== undefined && dm.manual === true) sendManualDmTyping(dm.peerId, false)
      else if (dm !== undefined && dm.global === true) sendGlobalDmTyping(dm.peerId, false)
      else if (dm !== undefined) sendDmTyping(dm.peerId, false)
    }
  }, [dm, room, sendDmTyping, sendGlobalDmTyping, sendManualDmTyping, sendTyping])

  const signalTyping = useCallback(() => {
    const now = Date.now()
    const signal = (on: boolean) => {
      if (room !== undefined) sendTyping(room.id, on)
      else if (dm !== undefined && dm.manual === true) sendManualDmTyping(dm.peerId, on)
      else if (dm !== undefined && dm.global === true) sendGlobalDmTyping(dm.peerId, on)
      else if (dm !== undefined) sendDmTyping(dm.peerId, on)
    }
    if (!typingActiveRef.current) {
      typingActiveRef.current = true
      lastTypingSentAtRef.current = now
      signal(true)
    } else if (now - lastTypingSentAtRef.current >= TYPING_SIGNAL_THROTTLE_MS) {
      lastTypingSentAtRef.current = now
      signal(true)
    }
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(stopTypingSignal, TYPING_IDLE_STOP_MS)
  }, [dm, room, sendDmTyping, sendGlobalDmTyping, sendManualDmTyping, sendTyping, stopTypingSignal])

  // Clean up any pending idle timer when leaving the room/unmounting.
  useEffect(() => stopTypingSignal, [stopTypingSignal])

  /**
   * Issue #99 — the ONE send path of the composer, used by the plain-text
   * submit and by the executor's send-chat directives alike (/me and the
   * '\/' escape hatch): the 4000-cap is enforced by the caller (submit's
   * canSend gate — a directive's text is never longer than the typed
   * value), the TTL pick rides along, and the mode decides the manager
   * seam. Room sends forward `isAction` so a /me echoes italic locally
   * (Message.isAction, wire-clean); the DM seams have no opts parameter,
   * so a DM-mode /me sends the action prose as a normal (plain) DM.
   */
  const sendText = (text: string, isAction?: true) => {
    const ttl = ttlDraft === '' ? undefined : Number(ttlDraft)
    if (room !== undefined) {
      if (ttl === undefined && isAction === undefined) sendChat(room.id, text)
      else if (ttl === undefined) sendChat(room.id, text, undefined, { isAction: true })
      else if (isAction === undefined) sendChat(room.id, text, ttl)
      else sendChat(room.id, text, ttl, { isAction: true })
    } else if (dm !== undefined && dm.manual === true) {
      // Issue #97 — manual channels route through the manual manager.
      if (ttl === undefined) void sendManualDm(dm.peerId, text)
      else void sendManualDm(dm.peerId, text, ttl)
    } else if (dm !== undefined && dm.global === true) {
      // Issue #105 — signal-backed channels route through the signal manager.
      if (ttl === undefined) void sendGlobalDm(dm.peerId, text)
      else void sendGlobalDm(dm.peerId, text, ttl)
    } else if (dm !== undefined) {
      if (ttl === undefined) void sendDm(dm.peerId, text)
      else void sendDm(dm.peerId, text, ttl)
    }
  }

  /** Empties the composer after its content left (sent or executed). */
  const clearComposer = () => {
    setValue('')
    setHint(null)
    stopTypingSignal()
    requestAnimationFrame(resizeTextarea)
  }

  /** Runs the executor with the real seams; sends what comes back. */
  const runSlash = async (parsed: SlashCommand) => {
    const directive = await executeSlashCommand(parsed, createSlashExecutorContext())
    if (directive.type === 'send-chat') sendText(directive.text, directive.isAction)
  }

  const submit = () => {
    if (!canSend) return
    const parsed = parseSlashCommand(value)
    if (parsed === null) {
      // Plain chat: the pre-#99 path, byte-identical sends.
      sendText(value)
      clearComposer()
      return
    }
    if (parsed.kind === 'unknown') {
      // NEVER sent; the hint sits next to the input, the text stays for
      // fixing (the executor's own unknown branch is the headless path).
      setHint(t('slash.unknownCommand'))
      return
    }
    if (parsed.kind === 'error') {
      // Known verb, rejected arguments: the executor's wording, inline.
      setHint(slashErrorLine(parsed))
      return
    }
    // A real command or the escape hatch: the content leaves the composer
    // either way, so clear first (a second Enter cannot double-run an
    // async command) and execute through the executor's seams.
    clearComposer()
    void runSlash(parsed)
  }

  /**
   * Issue #99 — a popup pick. Zero-arg commands execute immediately (the
   * input clears); argument commands fill '/verb ' with the caret at the
   * end and let the user type the argument (the space closes the popup).
   */
  const selectCandidate = (def: SlashCommandDef) => {
    if (def.arity === 'none') {
      clearComposer()
      // The parser turns the bare verb into the canonical zero-arg command
      // (it cannot fail for a table row with no argument to reject).
      const parsed = parseSlashCommand(`/${def.verb}`)
      if (parsed?.kind === 'command') void runSlash(parsed)
      return
    }
    const filled = `/${def.verb} `
    setValue(filled)
    setHint(null)
    pendingCaretRef.current = filled.length
    requestAnimationFrame(resizeTextarea)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submit()
  }

  if (room === undefined && dm === undefined) return null

  // Issue #103 phase 4 — the file dialog mounts for the active mode: room
  // mode offers the connected-peer selector and the room/public encryption
  // notice, DM mode fixes the recipient and always announces the DM key.
  const fileDialog =
    room !== undefined ? (
      <FileSendDialog
        open={fileDialogOpen}
        onClose={() => setFileDialogOpen(false)}
        roomId={room.id}
        peers={room.peers}
        encryptedRoom={room.hasPassword}
        onSend={(peerId, file) => fileTransfers.sendRoomFile(room.id, peerId, file)}
      />
    ) : dm !== undefined ? (
      <FileSendDialog
        open={fileDialogOpen}
        onClose={() => setFileDialogOpen(false)}
        dmPeer={{ peerId: dm.peerId, nickname: dm.peerNick ?? dm.peerId }}
        onSend={(peerId, file) => fileTransfers.sendDmFile(peerId, file)}
      />
    ) : null

  return (
    <>
      <form
        aria-label={t('chat.composerLabel')}
        onSubmit={handleSubmit}
        className="relative flex flex-col gap-1 border-t border-border bg-surface px-3 py-2"
      >
        {slashOpen && (
          <ul
            id={SLASH_LISTBOX_ID}
            role="listbox"
            aria-label={t('slash.popupLabel')}
            className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-full max-w-md overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
          >
            {slashCandidates.map((def, index) => (
              <li
                key={def.verb}
                id={`${SLASH_OPTION_ID_PREFIX}-${def.verb}`}
                role="option"
                aria-selected={index === activeIndex}
                // Hover only syncs the highlight; picking happens on click.
                onMouseEnter={() => setActiveIndex(index)}
                // The popup must never steal the focus from the textarea.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectCandidate(def)}
                className={`flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 ${
                  index === activeIndex ? 'bg-bg' : ''
                }`}
              >
                <code className="font-mono text-sm text-text">{def.usage}</code>
                <span className="text-xs text-muted">{def.help}</span>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
          aria-label={t('chat.messageAria')}
          placeholder={t('chat.messagePlaceholder')}
          value={value}
          disabled={blocked}
          // Issue #99 — ARIA combobox pattern for the slash popup: the
          // textarea keeps the focus and announces the active candidate
          // through aria-activedescendant (the options are never focusable).
          role="combobox"
          aria-expanded={slashOpen}
          aria-controls={slashOpen ? SLASH_LISTBOX_ID : undefined}
          aria-activedescendant={
            activeCandidate === undefined
              ? undefined
              : `${SLASH_OPTION_ID_PREFIX}-${activeCandidate.verb}`
          }
          aria-autocomplete="list"
          onChange={(event) => {
            setValue(event.target.value)
            setSlashDismissed(false)
            setActiveIndex(0)
            setHint(null)
            resizeTextarea()
            if (event.target.value !== '') signalTyping()
          }}
          onBlur={stopTypingSignal}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              // Popup open: Enter picks the active candidate, never sends.
              if (activeCandidate !== undefined) selectCandidate(activeCandidate)
              else submit()
              return
            }
            if (activeCandidate !== undefined) {
              switch (event.key) {
                case 'ArrowDown':
                  event.preventDefault()
                  setActiveIndex((index) => (index + 1) % slashCandidates.length)
                  return
                case 'ArrowUp':
                  event.preventDefault()
                  setActiveIndex(
                    (index) => (index - 1 + slashCandidates.length) % slashCandidates.length,
                  )
                  return
                case 'Tab':
                  // Shift+Tab keeps its normal focus-move meaning.
                  if (!event.shiftKey) {
                    event.preventDefault()
                    selectCandidate(activeCandidate)
                  }
                  return
                case 'Escape':
                  event.preventDefault()
                  setSlashDismissed(true)
                  return
              }
            } else if (event.key === 'Escape') {
              // Popup already closed: a second Esc clears a stale hint.
              setHint(null)
            }
          }}
          className="max-h-36 w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm focus:border-accent disabled:opacity-50"
        />
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="hidden sm:inline">{t('chat.markdownHint')}</span>
          {/* Issue #96 — native select (keyboard-operable by construction);
            hard-blocked together with the composer on a disconnected or
            legacy DM peer, still usable while a room is queueing. */}
          <select
            aria-label={t('common.ttlSelectLabel')}
            value={ttlDraft}
            disabled={blocked}
            onChange={(event) => setTtlDraft(event.target.value)}
            className="rounded-md border border-border bg-surface px-1 py-1 text-xs focus:border-accent disabled:opacity-50"
          >
            <option value="">{t('common.noExpiryLabel')}</option>
            {TTL_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>
                {seconds === MIN_MESSAGE_TTL_S
                  ? t('common.ttl30Seconds')
                  : seconds === MAX_MESSAGE_TTL_S
                    ? t('common.ttl1Hour')
                    : t('common.ttl5Minutes')}
              </option>
            ))}
          </select>
          {/* Issue #103 phase 4 — the attachment entry: opens the pre-send
            dialog with the file picker, the encryption notice and the
            recipient scope. Blocked with the composer on a disconnected or
            legacy DM peer (a refused transfer teaches nothing new) and
            hidden on manual channels, whose engine has no file host. */}
          {(room !== undefined || dm?.manual !== true) && (
            <button
              type="button"
              aria-label={t('files.attachLabel')}
              disabled={blocked}
              onClick={() => setFileDialogOpen(true)}
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
            >
              {t('files.attachButton')}
            </button>
          )}
          {disconnected && (
            <span className="text-accent" role="status">
              {t('dm.peerDisconnected')}
            </span>
          )}
          {legacyPeer && (
            <span className="text-accent" role="status">
              {t('dm.legacyPeer')}
            </span>
          )}
          {queued && (
            <span className="text-accent" role="status">
              {t('chat.queuedHint')}
            </span>
          )}
          {/* Issue #99 — the rejected-submit hint (unknown verb, parse-level
            error): same static role="status" region pattern as the DM
            states above; transient by content, cleared on edit/send/Esc. */}
          {hint !== null && (
            <span className="text-accent" role="status">
              {hint}
            </span>
          )}
          {showCounter && (
            <span
              className={`ml-auto tabular-nums ${overLimit ? 'font-semibold text-accent' : ''}`}
              aria-live="polite"
            >
              {value.length}/{MAX_PLAINTEXT_LENGTH}
            </span>
          )}
          <button
            type="submit"
            disabled={!canSend}
            className="ml-auto rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-text disabled:opacity-40"
          >
            {t('common.send')}
          </button>
        </div>
      </form>
      {fileDialog}
    </>
  )
}
