import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAR_COUNTER_FROM, DM_DISCONNECTED_TEXT, TYPING_IDLE_STOP_MS, TYPING_SIGNAL_THROTTLE_MS } from '../../lib/feed'
import { MAX_PLAINTEXT_LENGTH } from '../../lib/p2p/protocol'
import type { Room } from '../../stores/useAppStore'
import { useRoomManager } from '../../hooks/useRoomManager'

/** Visible textarea height: about 6 text lines (RF-03). */
const MAX_TEXTAREA_HEIGHT_PX = 144

/** M3 — composer context for a DM view (RF-04). */
export interface DmComposerContext {
  peerId: string
  /** False once the peer shares no active room: sending is blocked. */
  available: boolean
}

/**
 * Message composer (RF-03 / §10.4, reused by rooms and DMs per RF-04):
 * auto-growing textarea capped at 6 visible lines, Enter sends /
 * Shift+Enter breaks the line, 4000-character limit with a counter visible
 * from 3800 (sending blocked above the limit). Typing signals are
 * throttled to 1/s while composing and stop on send, blur or 2 s of idle.
 * Rooms queue locally while `searching`/`error` ('En cola hasta
 * conectar…'); a disconnected DM is hard-blocked with the exact RF-04 text.
 */
export function ChatInput(props: { room?: Room; dm?: DmComposerContext }) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingActiveRef = useRef(false)
  const lastTypingSentAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const { sendChat, sendTyping, sendDm, sendDmTyping } = useRoomManager()

  const room = props.room
  const dm = props.dm
  // Room: not ready → local queue (§10.3). DM: not available → blocked.
  const ready = room !== undefined ? room.status === 'connected' : (dm?.available ?? false)
  const queued = room !== undefined && !ready
  const blocked = dm !== undefined && !dm.available
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
    if (room !== undefined) sendChat(room.id, value)
    else if (dm !== undefined) void sendDm(dm.peerId, value)
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
        {blocked && (
          <span className="text-accent" role="status">
            {DM_DISCONNECTED_TEXT}
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
