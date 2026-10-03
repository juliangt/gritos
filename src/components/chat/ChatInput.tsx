import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { CHAR_COUNTER_FROM, TYPING_IDLE_STOP_MS, TYPING_SIGNAL_THROTTLE_MS } from '../../lib/feed'
import { MAX_PLAINTEXT_LENGTH } from '../../lib/p2p/protocol'
import type { Room } from '../../stores/useAppStore'
import { useRoomManager } from '../../hooks/useRoomManager'

/** Visible textarea height: about 6 text lines (RF-03). */
const MAX_TEXTAREA_HEIGHT_PX = 144

/**
 * Message composer (RF-03 / §10.4): auto-growing textarea capped at 6
 * visible lines, Enter sends / Shift+Enter breaks the line, 4000-character
 * limit with a counter visible from 3800 (sending blocked above the limit).
 * Typing signals are throttled to 1/s while composing and stop on send,
 * blur or 2 s of idle. While the room is `searching`/`error` the send is
 * locally queued and the UI shows 'En cola hasta conectar…'.
 */
export function ChatInput({ room }: { room: Room }) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingActiveRef = useRef(false)
  const lastTypingSentAtRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const { sendChat, sendTyping } = useRoomManager()

  const queued = room.status !== 'connected'
  const overLimit = value.length > MAX_PLAINTEXT_LENGTH
  const canSend = value.trim() !== '' && !overLimit
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
      sendTyping(room.id, false)
    }
  }, [room.id, sendTyping])

  const signalTyping = useCallback(() => {
    const now = Date.now()
    if (!typingActiveRef.current) {
      typingActiveRef.current = true
      lastTypingSentAtRef.current = now
      sendTyping(room.id, true)
    } else if (now - lastTypingSentAtRef.current >= TYPING_SIGNAL_THROTTLE_MS) {
      lastTypingSentAtRef.current = now
      sendTyping(room.id, true)
    }
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(stopTypingSignal, TYPING_IDLE_STOP_MS)
  }, [room.id, sendTyping, stopTypingSignal])

  // Clean up any pending idle timer when leaving the room/unmounting.
  useEffect(() => stopTypingSignal, [stopTypingSignal])

  const submit = () => {
    if (!canSend) return
    sendChat(room.id, value)
    setValue('')
    stopTypingSignal()
    requestAnimationFrame(resizeTextarea)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submit()
  }

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
        className="max-h-36 w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="hidden sm:inline">**negrita** · *cursiva* · `código`</span>
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
