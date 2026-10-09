import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageItem } from './MessageItem'
import { NewMessagesButton } from './NewMessagesButton'
import {
  FIFO_SEPARATOR_TEXT,
  RECOVERED_SEPARATOR_TEXT,
  expiredSeparatorText,
  shouldAutoScroll,
} from '../../lib/feed'
import {
  HISTORY_ASK_CONFIRM,
  HISTORY_ASK_DISMISS,
  HISTORY_ASK_LABEL,
  HISTORY_ASK_TEXT,
} from '../settings/messages'
import type { Message, Peer } from '../../stores/useAppStore'
import { useAppStore } from '../../stores/useAppStore'
import { useMentionCandidates } from '../../hooks/useMentionCandidates'

/**
 * Message feed (RF-03 / §10.4, reused by rooms and DMs per RF-04): flat
 * bubbles with smart scrolling — auto-scroll only while the user is ≤150 px
 * from the bottom; otherwise a floating 'N new messages' button
 * accumulates arrivals and jumps to the bottom on click. The FIFO separator
 * renders once the 500-message cap has trimmed the history, the TTL
 * separator once the expiry sweep has removed messages (issue #96) and the
 * recovered separator once opt-in history gossip has appended rows (issue
 * #102). An empty feed shows a discrete invitation (M6 empty states) and —
 * rooms only, via the optional `historyAsk` prop — the one-tap card that
 * offers to ask the room for its recent messages (issue #102 phase 3:
 * nothing automatic, dismissed by either button). `role="log"` + the
 * polite live region announce arrivals to assistive tech without stealing
 * focus (RNF-05).
 */
export function MessageFeed(props: {
  messages: readonly Message[]
  peers: readonly Peer[]
  fifoTrimmed: boolean
  /** TTL messages removed by the expiry sweep (issue #96); 0 hides the line. */
  expiredCount: number
  /** Chat rows accepted through history gossip (issue #102); 0 hides the line. */
  recoveredCount: number
  ariaLabel: string
  /** Shown when the feed has no messages (M6 empty state). */
  emptyStateText?: string
  /**
   * Issue #102 phase 3 — when defined, the inline history-request card
   * renders (rooms only; DM feeds never pass it). Visibility itself is the
   * caller's policy (empty feed + not yet dismissed this join); both
   * buttons hand the decision back and the caller dismisses the card.
   */
  historyAsk?: { onAsk: () => void; onDismiss: () => void }
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const previousTailRef = useRef<{ length: number; firstId: string | null; lastId: string | null }>(
    {
      length: props.messages.length,
      firstId: props.messages[0]?.id ?? null,
      lastId: props.messages[props.messages.length - 1]?.id ?? null,
    },
  )
  const [newCount, setNewCount] = useState(0)
  // Fine slice selectors (M6, RNF-03): the own-nickname subscription lives
  // here — once per feed, never per message row.
  const ownNickname = useAppStore((state) => state.identity?.nickname ?? '')
  const mentionCandidates = useMentionCandidates(props.peers)

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [])

  // Each message batch: auto-scroll when engaged, otherwise count up. Past
  // the 500-message FIFO cap the length no longer grows (one in, one out),
  // so arrivals are also detected through the first/last id changing.
  useEffect(() => {
    const length = props.messages.length
    const firstId = props.messages[0]?.id ?? null
    const lastId = props.messages[length - 1]?.id ?? null
    const previous = previousTailRef.current
    previousTailRef.current = { length, firstId, lastId }

    let arrivals: number
    if (length === previous.length) {
      if (firstId === previous.firstId && lastId === previous.lastId) return
      arrivals = 1
    } else {
      arrivals = length - previous.length
      if (arrivals <= 0) return
    }
    if (atBottomRef.current) {
      scrollToBottom()
    } else {
      setNewCount((count) => count + arrivals)
    }
  }, [props.messages, scrollToBottom])

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
        {props.expiredCount > 0 && (
          <p className="my-1 text-center text-xs text-muted">
            {expiredSeparatorText(props.expiredCount)}
          </p>
        )}
        {props.recoveredCount > 0 && (
          <p className="my-1 text-center text-xs text-muted">{RECOVERED_SEPARATOR_TEXT}</p>
        )}
        {props.messages.length === 0 && props.emptyStateText !== undefined && (
          <p role="status" className="my-8 text-center text-sm text-muted">
            {props.emptyStateText}
          </p>
        )}
        {props.historyAsk !== undefined && (
          <section
            aria-label={HISTORY_ASK_LABEL}
            className="mx-auto my-2 w-full max-w-sm rounded-md border border-border bg-surface px-3 py-2 text-center"
          >
            <p className="text-sm">{HISTORY_ASK_TEXT}</p>
            <div className="mt-2 flex justify-center gap-2">
              <button
                type="button"
                onClick={props.historyAsk.onAsk}
                className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text hover:opacity-90"
              >
                {HISTORY_ASK_CONFIRM}
              </button>
              <button
                type="button"
                onClick={props.historyAsk.onDismiss}
                className="rounded border border-border px-3 py-1.5 text-xs hover:border-accent"
              >
                {HISTORY_ASK_DISMISS}
              </button>
            </div>
          </section>
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
