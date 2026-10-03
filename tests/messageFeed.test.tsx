// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { MESSAGE_CAP, type Message } from '../src/stores/useAppStore'

/**
 * RF-03 regression (validation audit): once the 500-message FIFO cap is
 * reached the feed length no longer grows, so the arrival detection must
 * key on the first/last ids. Otherwise auto-scroll and the
 * '↓ N mensajes nuevos' counter die in exactly the long-room scenario the
 * cap was designed for.
 */

function makeMessages(count: number, startIndex = 0): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m${startIndex + index}`,
    roomId: 'room-1',
    authorId: 'peer-1',
    authorNick: 'luna-cauta',
    text: `hola ${startIndex + index}`,
    ts: 1_760_000_000_000 + startIndex + index,
    encrypted: false,
    status: 'delivered',
    kind: 'user',
  }))
}

/** A capped append: same length, one message in at the tail, one out at the head. */
function cappedAppend(messages: Message[], tag: number): Message[] {
  const tail: Message = {
    ...messages[messages.length - 1]!,
    id: `new-${tag}`,
    text: `mensaje nuevo ${tag}`,
  }
  const next = [...messages, tail]
  return next.length > MESSAGE_CAP ? next.slice(next.length - MESSAGE_CAP) : next
}

function scrollTo(el: HTMLElement, scrollTop: number): void {
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  el.scrollTop = scrollTop
  fireEvent.scroll(el)
}

describe('MessageFeed smart scroll past the FIFO cap (RF-03)', () => {
  afterEach(cleanup)

  it('auto-scrolls on a capped append while the user is at the bottom', () => {
    const props = {
      peers: [],
      fifoTrimmed: true,
      ariaLabel: 'feed',
    }
    const base = makeMessages(MESSAGE_CAP)
    const { rerender, container } = render(<MessageFeed {...props} messages={base} />)
    const log = container.querySelector('[role="log"]') as HTMLElement
    scrollTo(log, 600) // distance 0 → engaged

    rerender(<MessageFeed {...props} messages={cappedAppend(base, 1)} />)
    expect(log.scrollTop).toBe(1000)
  })

  it('counts capped appends into the new-messages button while scrolled up', () => {
    const props = {
      peers: [],
      fifoTrimmed: true,
      ariaLabel: 'feed',
    }
    const base = makeMessages(MESSAGE_CAP)
    const { rerender, container } = render(<MessageFeed {...props} messages={base} />)
    const log = container.querySelector('[role="log"]') as HTMLElement
    scrollTo(log, 100) // distance 500 → disengaged

    const one = cappedAppend(base, 1)
    rerender(<MessageFeed {...props} messages={one} />)
    expect(screen.getByRole('button', { name: '↓ 1 mensaje nuevo' })).toBeInTheDocument()

    // A second capped append accumulates.
    rerender(<MessageFeed {...props} messages={cappedAppend(one, 2)} />)
    expect(screen.getByRole('button', { name: '↓ 2 mensajes nuevos' })).toBeInTheDocument()
  })
})
