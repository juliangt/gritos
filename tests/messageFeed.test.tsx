// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { getSelfPeerId } from '../src/lib/p2p/roomManager'
import { MESSAGE_CAP, type Message, type Peer } from '../src/stores/useAppStore'
import { useAppStore } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'

/**
 * RF-03 regression (validation audit): once the 500-message FIFO cap is
 * reached the feed length no longer grows, so the arrival detection must
 * key on the first/last ids. Otherwise auto-scroll and the
 * '↓ N new messages' counter die in exactly the long-room scenario the
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
    text: `new message ${tag}`,
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
      expiredCount: 0,
      recoveredCount: 0,
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
      expiredCount: 0,
      recoveredCount: 0,
      ariaLabel: 'feed',
    }
    const base = makeMessages(MESSAGE_CAP)
    const { rerender, container } = render(<MessageFeed {...props} messages={base} />)
    const log = container.querySelector('[role="log"]') as HTMLElement
    scrollTo(log, 100) // distance 500 → disengaged

    const one = cappedAppend(base, 1)
    rerender(<MessageFeed {...props} messages={one} />)
    expect(screen.getByRole('button', { name: '↓ 1 new message' })).toBeInTheDocument()

    // A second capped append accumulates.
    rerender(<MessageFeed {...props} messages={cappedAppend(one, 2)} />)
    expect(screen.getByRole('button', { name: '↓ 2 new messages' })).toBeInTheDocument()
  })
})

describe('MessageFeed TTL expiry separator (issue #96)', () => {
  afterEach(cleanup)

  it('renders the separator with the accumulated count, mirroring the FIFO line', () => {
    const { container } = render(
      <MessageFeed
        messages={makeMessages(2)}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={2}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    // Same rendering path as the FIFO separator: a muted centered line at
    // the top of the log, above the history.
    const line = screen.getByText('— 2 mensajes expirados —')
    expect(line).toBeInTheDocument()
    expect(line.className).toBe('my-1 text-center text-xs text-muted')
    expect(container.querySelector('[role="log"]')?.firstElementChild).toBe(line)
  })

  it('pluralizes the count exactly like the other feed counters', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={1}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.getByText('— 1 mensaje expirado —')).toBeInTheDocument()
  })

  it('renders nothing when no message has expired', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.queryByText(/expirado/)).not.toBeInTheDocument()
  })

  it('coexists with the FIFO separator above the history', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={[]}
        fifoTrimmed={true}
        expiredCount={5}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.getByText('— mensajes anteriores descartados —')).toBeInTheDocument()
    expect(screen.getByText('— 5 mensajes expirados —')).toBeInTheDocument()
  })
})

describe('MessageItem mute affordance (issue #95)', () => {
  const PEER_FP = 'A31F 09BC 77D2 4E5A 0F1E 2D3C 4B5A 6978'
  const CANONICAL_FP = 'A31F09BC77D24E5A0F1E2D3C4B5A6978'

  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().resetSettings()
  })

  afterEach(cleanup)

  function authorPeer(fingerprint: string | null): Peer[] {
    return [{ id: 'peer-1', nickname: 'luna-cauta', fingerprint, latencyMs: 42, degraded: false }]
  }

  it('offers Mute @nick and mutes by the author fingerprint', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={authorPeer(PEER_FP)}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    // The affordance is reachable by its accessible name (RNF-05).
    fireEvent.click(screen.getByRole('button', { name: 'Mute @luna-cauta' }))

    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([CANONICAL_FP])
    // No active room (the feed is rendered standalone): the local system
    // line is skipped silently, and nothing else leaks into any store room.
    expect(Object.keys(useAppStore.getState().rooms)).toHaveLength(0)
  })

  it('offers no mute affordance on own rows or fingerprint-less authors', () => {
    const ownMessage: Message = { ...makeMessages(1)[0]!, authorId: 'self' }
    const { rerender } = render(
      <MessageFeed
        messages={[ownMessage]}
        peers={authorPeer(PEER_FP)}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.queryByRole('button', { name: 'Mute @luna-cauta' })).not.toBeInTheDocument()

    // The author is visible but has not announced keys yet: nothing to key
    // the mute on, so no affordance.
    rerender(
      <MessageFeed
        messages={makeMessages(1)}
        peers={authorPeer(null)}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.queryByRole('button', { name: 'Mute @luna-cauta' })).not.toBeInTheDocument()
  })
})

describe('MessageItem reactions through the real manager toggle (issue #98)', () => {
  const FEED_PEERS: Peer[] = [
    { id: 'peer-1', nickname: 'luna-cauta', fingerprint: null, latencyMs: 42, degraded: false },
  ]
  const FEED_PROPS = {
    peers: FEED_PEERS,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    ariaLabel: 'feed',
  }

  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().resetSettings()
    useAppStore.setState({
      identity: { nickname: 'yo-propio', fingerprint: 'A31F 09BC', createdAt: 0 },
    })
  })

  afterEach(cleanup)

  /** Seeds the store room the manager's toggleReaction reads and writes. */
  function seedRoom(messages: Message[]): void {
    useAppStore.getState().upsertRoom({
      id: 'room-1',
      name: 'lobby',
      hasPassword: false,
      status: 'connected',
      peers: [],
      messages,
      typing: {},
      unread: 0,
      fifoTrimmed: false,
      expiredCount: 0,
      recoveredCount: 0,
      historyAskDismissed: false,
    })
  }

  function storedMessages(): Message[] {
    return useAppStore.getState().rooms['room-1']!.messages
  }

  it('clicking a chip toggles the own reaction on and off', () => {
    const selfId = getSelfPeerId()
    seedRoom([{ ...makeMessages(1)[0]!, reactions: { '👍': ['peer-1'] } }])
    const { rerender } = render(<MessageFeed {...FEED_PROPS} messages={storedMessages()} />)

    // The local optimistic toggle lands in the store with the session's own
    // peerId even with no connection (cosmetic class: the toggle stands).
    fireEvent.click(screen.getByRole('button', { name: '👍 1' }))
    expect(storedMessages()[0]!.reactions?.['👍']).toEqual(['peer-1', selfId])

    rerender(<MessageFeed {...FEED_PROPS} messages={storedMessages()} />)
    expect(screen.getByRole('button', { name: '👍 2' })).toHaveAttribute('aria-pressed', 'true')

    // Second click on the same chip unreacts (the manager reads the live
    // direction from state).
    fireEvent.click(screen.getByRole('button', { name: '👍 2' }))
    expect(storedMessages()[0]!.reactions?.['👍']).toEqual(['peer-1'])
  })

  it('the quick-pick adds the own reaction to the message', () => {
    const selfId = getSelfPeerId()
    seedRoom(makeMessages(1))
    const { rerender } = render(<MessageFeed {...FEED_PROPS} messages={storedMessages()} />)

    fireEvent.click(screen.getByRole('button', { name: 'React' }))
    fireEvent.click(screen.getByRole('button', { name: 'React with 🎉' }))

    expect(storedMessages()[0]!.reactions?.['🎉']).toEqual([selfId])
    rerender(<MessageFeed {...FEED_PROPS} messages={storedMessages()} />)
    expect(screen.getByRole('button', { name: '🎉 1' })).toHaveAttribute('aria-pressed', 'true')
  })
})

// ---------------------------------------------------------------------------
// Issue #102 phase 3 — the recovered separator, the dimmed recovered rows
// and the inline history-request card. The separator mirrors the #96
// latched lines; the card is one explicit tap ([Ask] asks, [No]
// declines) and disappears on either choice.
// ---------------------------------------------------------------------------

describe('MessageFeed recovered separator + dimming (issue #102)', () => {
  afterEach(cleanup)

  it('renders the recovered separator above the history while recoveredCount > 0', () => {
    const { container } = render(
      <MessageFeed
        messages={makeMessages(2)}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={3}
        ariaLabel="feed"
      />,
    )
    const line = screen.getByText('— mensajes recuperados de pares —')
    expect(line).toBeInTheDocument()
    // Same rendering path as the FIFO/expired separators: a muted centered
    // line at the top of the log.
    expect(line.className).toBe('my-1 text-center text-xs text-muted')
    expect(container.querySelector('[role="log"]')?.firstElementChild).toBe(line)
  })

  it('renders nothing when no rows were recovered', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
      />,
    )
    expect(screen.queryByText(/recuperados/)).not.toBeInTheDocument()
  })

  it('coexists with the FIFO and expiry separators above the history', () => {
    render(
      <MessageFeed
        messages={makeMessages(1)}
        peers={[]}
        fifoTrimmed={true}
        expiredCount={2}
        recoveredCount={5}
        ariaLabel="feed"
      />,
    )
    expect(screen.getByText('— mensajes anteriores descartados —')).toBeInTheDocument()
    expect(screen.getByText('— 2 mensajes expirados —')).toBeInTheDocument()
    expect(screen.getByText('— mensajes recuperados de pares —')).toBeInTheDocument()
  })

  it('renders recovered rows slightly dimmed and normal rows untouched', () => {
    const recovered = { ...makeMessages(1)[0]!, id: 'rec', recovered: true }
    render(
      <MessageFeed
        messages={[...makeMessages(1), recovered]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={1}
        ariaLabel="feed"
      />,
    )
    const log = screen.getByRole('log')
    const rows = [...log.children].filter((child) => child.tagName === 'DIV')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.className).not.toContain('opacity-70')
    expect(rows[1]?.className).toContain('opacity-70')
  })
})

describe('MessageFeed history-request card (issue #102 phase 3)', () => {
  afterEach(cleanup)

  it('renders the offer with both buttons only while the caller passes historyAsk', () => {
    const { rerender } = render(
      <MessageFeed
        messages={[]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
        emptyStateText="Share the room name so others can join."
      />,
    )
    expect(screen.queryByRole('button', { name: 'Ask' })).not.toBeInTheDocument()

    rerender(
      <MessageFeed
        messages={[]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
        emptyStateText="Share the room name so others can join."
        historyAsk={{ onAsk: () => {}, onDismiss: () => {} }}
      />,
    )
    // The card lives inside the log, next to the empty-state invitation.
    expect(screen.getByRole('region', { name: 'Request recent messages' })).toBeInTheDocument()
    expect(screen.getByText('Ask the room for the latest messages?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument()
  })

  it('routes [Ask] to onAsk and [No] to onDismiss', () => {
    const onAsk = vi.fn()
    const onDismiss = vi.fn()
    render(
      <MessageFeed
        messages={[]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="feed"
        historyAsk={{ onAsk, onDismiss }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onAsk).toHaveBeenCalledTimes(1) // the tap already happened
  })
})
