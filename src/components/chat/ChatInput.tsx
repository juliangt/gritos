import { useCallback, useEffect, useRef, useState, useLayoutEffect, type FormEvent } from 'react'
import {
  CHAR_COUNTER_FROM,
  DM_DISCONNECTED_TEXT,
  DM_LEGACY_PEER_TEXT,
  TYPING_IDLE_STOP_MS,
  TYPING_SIGNAL_THROTTLE_MS,
  UNKNOWN_COMMAND_HINT,
} from '../../lib/feed'
import { MAX_MESSAGE_TTL_S, MAX_PLAINTEXT_LENGTH, MIN_MESSAGE_TTL_S } from '../../lib/p2p/protocol'
import type { Room } from '../../stores/useAppStore'
import {
  SIN_EXPIRY_LABEL,
  SLASH_POPUP_LABEL,
  TTL_1H_LABEL,
  TTL_30S_LABEL,
  TTL_5M_LABEL,
  TTL_SELECT_LABEL,
} from '../settings/messages'
import { useRoomManager } from '../../hooks/useRoomManager'
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
 * protocol bounds; the middle choice is the only free one.
 */
const TTL_CHOICES = [
  { seconds: MIN_MESSAGE_TTL_S, label: TTL_30S_LABEL },
  { seconds: 300, label: TTL_5M_LABEL },
  { seconds: MAX_MESSAGE_TTL_S, label: TTL_1H_LABEL },
] as const

/** DOM id of the slash-candidate listbox (the textarea's aria-controls target). */
const SLASH_LISTBOX_ID = 'slash-command-listbox'

/** DOM id prefix of one slash-candidate option (the aria-activedescendant target). */
const SLASH_OPTION_ID_PREFIX = 'slash-command-option'

/**
 * Shape of a value while the verb token is being typed: a leading '/' and
 * no whitespace yet. This is what makes the popup a verb picker: it opens
 * on '/' (and '/n', '/ay'…), stays open while the verb completes and closes
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
}

/**
 * Message composer (RF-03 / §10.4, reused by rooms and DMs per RF-04):
 * auto-growing textarea capped at 6 visible lines, Enter sends /
 * Shift+Enter breaks the line, 4000-character limit with a counter visible
 * from 3800 (sending blocked above the limit). Typing signals are
 * throttled to 1/s while composing and stop on send, blur or 2 s of idle.
 * Rooms queue locally while `searching`/`error` ('En cola hasta
 * conectar…'); a disconnected DM is hard-blocked with the exact RF-04 text
 * and a legacy (v1-build) peer with the issue #93 hint. A memory-only TTL
 * selector (issue #96) rides every send in both modes: it defaults to
 * 'Sin caducidad' and stays on the picked value across consecutive sends
 * until changed — never persisted, so a reload resets it.
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
 * commands (/salir, /limpiar) naturally answer with the executor's
 * NO_ACTIVE_ROOM_TEXT line in the focused feed.
 */
export function ChatInput(props: { room?: Room; dm?: DmComposerContext }) {
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingActiveRef = useRef(false)
  const lastTypingSentAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const { sendChat, sendTyping, sendDm, sendDmTyping, sendManualDm, sendManualDmTyping } =
    useRoomManager()

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
  // command table (fuzzy-prefix match: '/n' → /nick, '/ay' → /ayuda, a
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
      else if (dm !== undefined) sendDmTyping(dm.peerId, false)
    }
  }, [dm, room, sendDmTyping, sendManualDmTyping, sendTyping])

  const signalTyping = useCallback(() => {
    const now = Date.now()
    const signal = (on: boolean) => {
      if (room !== undefined) sendTyping(room.id, on)
      else if (dm !== undefined && dm.manual === true) sendManualDmTyping(dm.peerId, on)
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
  }, [dm, room, sendDmTyping, sendManualDmTyping, sendTyping, stopTypingSignal])

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
      setHint(UNKNOWN_COMMAND_HINT)
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

  return (
    <form
      aria-label="Mensaje"
      onSubmit={handleSubmit}
      className="relative flex flex-col gap-1 border-t border-border bg-surface px-3 py-2"
    >
      {slashOpen && (
        <ul
          id={SLASH_LISTBOX_ID}
          role="listbox"
          aria-label={SLASH_POPUP_LABEL}
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
        aria-label="Escribe un mensaje"
        placeholder="Mensaje (Markdown)…"
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
        <span className="hidden sm:inline">**negrita** · *cursiva* · `código`</span>
        {/* Issue #96 — native select (keyboard-operable by construction);
            hard-blocked together with the composer on a disconnected or
            legacy DM peer, still usable while a room is queueing. */}
        <select
          aria-label={TTL_SELECT_LABEL}
          value={ttlDraft}
          disabled={blocked}
          onChange={(event) => setTtlDraft(event.target.value)}
          className="rounded-md border border-border bg-surface px-1 py-1 text-xs focus:border-accent disabled:opacity-50"
        >
          <option value="">{SIN_EXPIRY_LABEL}</option>
          {TTL_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
        </select>
        {disconnected && (
          <span className="text-accent" role="status">
            {DM_DISCONNECTED_TEXT}
          </span>
        )}
        {legacyPeer && (
          <span className="text-accent" role="status">
            {DM_LEGACY_PEER_TEXT}
          </span>
        )}
        {queued && (
          <span className="text-accent" role="status">
            En cola hasta conectar…
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
          Enviar
        </button>
      </div>
    </form>
  )
}
