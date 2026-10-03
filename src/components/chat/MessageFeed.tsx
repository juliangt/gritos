import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageItem } from './MessageItem'
import { NewMessagesButton } from './NewMessagesButton'
import { FIFO_SEPARATOR_TEXT, shouldAutoScroll } from '../../lib/feed'
import type { Message, Peer } from '../../stores/useAppStore'
import { useAppStore } from '../../stores/useAppStore'
import { useMentionCandidates } from '../../hooks/useMentionCandidates'

/**
 * Message feed (RF-03 / §10.4, reused by rooms and DMs per RF-04): flat
 * bubbles with smart scrolling — auto-scroll only while the user is ≤150 px
 * from the bottom; otherwise a floating '↓ N mensajes nuevos' button
 * accumulates arrivals and jumps to the bottom on click. The FIFO separator
 * renders once the 500-message cap has trimmed the history. An empty feed
 * shows a discrete invitation (M6 empty states). `role="log"` + the polite
 * live region announce arrivals to assistive tech without stealing focus
 * (RNF-05).
 */
export function MessageFeed(props: {
  messages: readonly Message[]
  peers: readonly Peer[]
  fifoTrimmed: boolean
  ariaLabel: string
  /** Shown when the feed has no messages (M6 empty state). */
  emptyStateText?: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const previousLengthRef = useRef(props.messages.length)
  const [newCount, setNewCount] = useState(0)
  // Fine slice selectors (M6, RNF-03): the own-nickname subscription lives
  // here — once per feed, never per message row.
  const ownNickname = useAppStore((state) => state.identity?.nickname ?? '')
  const mentionCandidates = useMentionCandidates(props.peers)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  // Each message batch: auto-scroll when engaged, otherwise count up.
  useEffect(() => {
    const delta = props.messages.length - previousLengthRef.current
    previousLengthRef.current = props.messages.length
    if (delta <= 0) return
    if (atBottomRef.current) {
      scrollToBottom()
    } else {
      setNewCount((count) => count + delta)
    }
  }, [props.messages.length, scrollToBottom])

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
        role="log"
        aria-live="polite"
        aria-label={props.ariaLabel}
        className="flex h-full flex-col gap-1 overflow-y-auto px-4 py-3"
      >
        {props.fifoTrimmed && (
          <p className="my-1 text-center text-xs text-muted">{FIFO_SEPARATOR_TEXT}</p>
        )}
        {props.messages.length === 0 && props.emptyStateText !== undefined && (
          <p role="status" className="my-8 text-center text-sm text-muted">
            {props.emptyStateText}
          </p>
        )}
        {props.messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            peers={props.peers}
            mentionCandidates={mentionCandidates}
            ownNickname={ownNickname}
          />
        ))}
      </div>
      {newCount > 0 && <NewMessagesButton count={newCount} onClick={jumpToBottom} />}
    </div>
  )
}
