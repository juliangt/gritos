import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  CHAR_COUNTER_FROM,
  DM_DISCONNECTED_TEXT,
  DM_LEGACY_PEER_TEXT,
  TYPING_IDLE_STOP_MS,
  TYPING_SIGNAL_THROTTLE_MS,
} from '../../lib/feed'
import { MAX_MESSAGE_TTL_S, MAX_PLAINTEXT_LENGTH, MIN_MESSAGE_TTL_S } from '../../lib/p2p/protocol'
import type { Room } from '../../stores/useAppStore'
import {
  SIN_EXPIRY_LABEL,
  TTL_1H_LABEL,
  TTL_30S_LABEL,
  TTL_5M_LABEL,
  TTL_SELECT_LABEL,
} from '../settings/messages'
import { useRoomManager } from '../../hooks/useRoomManager'

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

/** M3 — composer context for a DM view (RF-04). */
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
 */
export function ChatInput(props: { room?: Room; dm?: DmComposerContext }) {
  const [value, setValue] = useState('')
  // Issue #96 — the TTL pick is component state on purpose: it persists
  // across consecutive sends (one decision covers a burst of expiring
  // messages) and dies with the tab; it never reaches the settings store.
  const [ttlDraft, setTtlDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingActiveRef = useRef(false)
  const lastTypingSentAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const { sendChat, sendTyping, sendDm, sendDmTyping } = useRoomManager()

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

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`
  }, [])

  const stopTypingSignal = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false
      if (room !== undefined) sendTyping(room.id, false)
      else if (dm !== undefined) sendDmTyping(dm.peerId, false)
    }
  }, [dm, room, sendDmTyping, sendTyping])

  const signalTyping = useCallback(() => {
    const now = Date.now()
    const signal = (on: boolean) => {
      if (room !== undefined) sendTyping(room.id, on)
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
  }, [dm, room, sendDmTyping, sendTyping, stopTypingSignal])

  // Clean up any pending idle timer when leaving the room/unmounting.
  useEffect(() => stopTypingSignal, [stopTypingSignal])

  const submit = () => {
    if (!canSend) return
    // Issue #96 — '' is the no-expiry pick: the argument is omitted so the
    // call (and the envelope the manager builds) stays byte-identical to the
    // pre-#96 shape; any pick maps to whole seconds on the wire.
    const ttl = ttlDraft === '' ? undefined : Number(ttlDraft)
    if (room !== undefined) {
      if (ttl === undefined) sendChat(room.id, value)
      else sendChat(room.id, value, ttl)
    } else if (dm !== undefined) {
      if (ttl === undefined) void sendDm(dm.peerId, value)
      else void sendDm(dm.peerId, value, ttl)
    }
    setValue('')
    stopTypingSignal()
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
      className="flex flex-col gap-1 border-t border-border bg-surface px-3 py-2"
    >
      <textarea
        ref={textareaRef}
        rows={1}
        aria-label="Escribe un mensaje"
        placeholder="Mensaje (Markdown)…"
        value={value}
        disabled={blocked}
        onChange={(event) => {
          setValue(event.target.value)
          resizeTextarea()
          if (event.target.value !== '') signalTyping()
        }}
        onBlur={stopTypingSignal}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            submit()
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
