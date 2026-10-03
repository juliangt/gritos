import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageItem } from './MessageItem'
import { NewMessagesButton } from './NewMessagesButton'
import { FIFO_SEPARATOR_TEXT, shouldAutoScroll } from '../../lib/feed'
import type { Room } from '../../stores/useAppStore'
import { useMentionCandidates } from '../../hooks/useMentionCandidates'

/**
 * Message feed (RF-03 / spec §10.4): flat bubbles with smart scrolling —
 * auto-scroll only while the user is ≤150 px from the bottom; otherwise a
 * floating '↓ N mensajes nuevos' button accumulates arrivals and jumps to
 * the bottom on click. The FIFO separator renders once the 500-message cap
 * has trimmed this room's history.
 */
export function MessageFeed({ room }: { room: Room }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const previousLengthRef = useRef(room.messages.length)
  const [newCount, setNewCount] = useState(0)
  const mentionCandidates = useMentionCandidates(room.peers)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  // Each message batch: auto-scroll when engaged, otherwise count up.
  useEffect(() => {
    const delta = room.messages.length - previousLengthRef.current
    previousLengthRef.current = room.messages.length
    if (delta <= 0) return
    if (atBottomRef.current) {
      scrollToBottom()
    } else {
      setNewCount((count) => count + delta)
    }
  }, [room.messages.length, scrollToBottom])

  const handleScroll = useCallback(() => {
    const element = scrollRef.current
    if (element === null) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const atBottom = shouldAutoScroll(distance)
    atBottomRef.current = atBottom
    if (atBottom) setNewCount(0)
  }, [])

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true
    setNewCount(0)
    scrollToBottom()
  }, [scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        aria-live="polite"
        aria-label={`Mensajes de #${room.name}`}
        className="flex h-full flex-col gap-1 overflow-y-auto px-4 py-3"
      >
        {room.fifoTrimmed && (
          <p className="my-1 text-center text-xs text-muted">{FIFO_SEPARATOR_TEXT}</p>
        )}
        {room.messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            peers={room.peers}
            mentionCandidates={mentionCandidates}
          />
        ))}
      </div>
      {newCount > 0 && <NewMessagesButton count={newCount} onClick={jumpToBottom} />}
    </div>
  )
}
