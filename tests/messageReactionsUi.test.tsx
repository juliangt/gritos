// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { toggleReaction } from '../src/lib/p2p/roomManager'
import {
  REACTION_ADD_LABEL,
  REACTION_BAR_LABEL,
  REACTIONS_ROW_LABEL,
} from '../src/components/settings/messages'
import { REACT_EMOJIS } from '../src/lib/p2p/protocol'
import { useAppStore, type Message, type Peer } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'

/**
 * Issue #98 phase 3 — the reaction UI on the message row: the 7-whitelist
 * quick-pick bar (hover + a click/focus opener so touch and keyboard users
 * reach it), the aggregated chips row under the bubble (counts, own
 * reaction highlighted, nickname tooltip) and the toggle routing — rooms
 * broadcast, DM rows ride the directed `to` payload, manual channels offer
 * nothing. The manager seam is mocked here so the assertions are about
 * WHAT the row asks the manager to do; tests/messageFeed.test.tsx covers
 * the real store round-trip through the unmocked `toggleReaction`.
 */

vi.mock('../src/lib/p2p/roomManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/p2p/roomManager')>()
  return {
    ...actual,
    toggleReaction: vi.fn(() => true),
    getSelfPeerId: vi.fn(() => 'self-peer-1'),
  }
})

const SELF_ID = 'self-peer-1'

function peer(id: string, nickname: string): Peer {
  return { id, nickname, fingerprint: null, latencyMs: 42, degraded: false }
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm0',
    roomId: 'room-1',
    authorId: 'peer-1',
    authorNick: 'luna-cauta',
    text: 'hola 0',
    ts: 1_760_000_000_000,
    encrypted: false,
    status: 'delivered',
    kind: 'user',
    ...overrides,
  }
}

const PEERS = [peer('peer-1', 'luna-cauta'), peer('peer-2', 'zorro-bravo')]

function renderFeed(messages: Message[], peers: Peer[] = PEERS) {
  return render(
    <MessageFeed
      messages={messages}
      peers={peers}
      fifoTrimmed={false}
      expiredCount={0}
      recoveredCount={0}
      ariaLabel="feed"
    />,
  )
}

function chipsRow(): HTMLElement {
  return screen.getByRole('group', { name: REACTIONS_ROW_LABEL })
}

function chipNames(): string[] {
  return within(chipsRow())
    .getAllByRole('button')
    .map((chip) => chip.textContent)
}

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  // The feed resolves the own nickname for chip tooltips from the identity.
  useAppStore.setState({
    identity: { nickname: 'yo-propio', fingerprint: 'A31F 09BC', createdAt: 0 },
  })
})

afterEach(() => {
  cleanup()
  vi.mocked(toggleReaction).mockClear()
})

describe('clean rows (no reactions, closed bar)', () => {
  it('renders no chips row and no quick-pick, only the opener affordance', () => {
    renderFeed([makeMessage()])

    // The opener is the always-reachable affordance (touch + keyboard).
    expect(screen.getByRole('button', { name: REACTION_ADD_LABEL })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: REACTIONS_ROW_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: REACTION_BAR_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reaccionar con/ })).not.toBeInTheDocument()
  })

  it('system lines carry no affordance at all', () => {
    renderFeed([makeMessage({ kind: 'system', authorId: 'system', text: '— hola —' })])

    expect(screen.queryByRole('button', { name: REACTION_ADD_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: REACTIONS_ROW_LABEL })).not.toBeInTheDocument()
  })
})

describe('aggregated chips row', () => {
  it('shows one chip per emoji with its count, ordered by count then whitelist order', () => {
    renderFeed([
      makeMessage({
        reactions: {
          '👍': ['peer-1'],
          '🎉': ['peer-1', 'peer-2', SELF_ID],
          '😂': ['peer-1', 'peer-2'],
        },
      }),
    ])

    // 🎉 (3) first, then 😂 (2), then 👍 (1): count descending; ties would
    // fall back to the fixed whitelist order.
    expect(chipNames()).toEqual(['🎉 3', '😂 2', '👍 1'])
  })

  it('highlights the own reaction (aria-pressed + visual class)', () => {
    renderFeed([makeMessage({ reactions: { '👍': ['peer-1', SELF_ID], '😂': ['peer-1'] } })])

    const mine = within(chipsRow()).getByRole('button', { name: '👍 2' })
    expect(mine).toHaveAttribute('aria-pressed', 'true')
    expect(mine.className).toContain('border-accent')

    const theirs = within(chipsRow()).getByRole('button', { name: '😂 1' })
    expect(theirs).toHaveAttribute('aria-pressed', 'false')
    expect(theirs.className).not.toContain('border-accent')
  })

  it('tooltips list the reactor nicknames, resolving the own peerId to the own nickname', () => {
    renderFeed([makeMessage({ reactions: { '👍': ['peer-1', SELF_ID] } })])

    expect(within(chipsRow()).getByRole('button', { name: '👍 2' })).toHaveAttribute(
      'title',
      'luna-cauta, yo-propio',
    )
  })

  it('falls back to the raw peerId for unknown reactors', () => {
    renderFeed([makeMessage({ reactions: { '👎': ['peer-desconocido-9'] } })])

    expect(within(chipsRow()).getByRole('button', { name: '👎 1' })).toHaveAttribute(
      'title',
      'peer-desconocido-9',
    )
  })

  it('clicking a chip toggles the own reaction for that emoji', () => {
    renderFeed([makeMessage({ reactions: { '👍': ['peer-1'] } })])

    fireEvent.click(within(chipsRow()).getByRole('button', { name: '👍 1' }))

    expect(toggleReaction).toHaveBeenCalledWith('room-1', 'm0', '👍')
  })
})

describe('quick-pick bar', () => {
  it('offers exactly the 7 whitelisted emojis in whitelist order on hover, and hides it on leave', () => {
    renderFeed([makeMessage()])
    const row = screen.getByText('hola 0')

    fireEvent.mouseOver(row)
    const bar = screen.getByRole('group', { name: REACTION_BAR_LABEL })
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([...REACT_EMOJIS])

    fireEvent.mouseOut(row)
    expect(screen.queryByRole('group', { name: REACTION_BAR_LABEL })).not.toBeInTheDocument()
  })

  it('opens on opener click and the pick routes through the manager (room row)', () => {
    renderFeed([makeMessage()])

    fireEvent.click(screen.getByRole('button', { name: REACTION_ADD_LABEL }))
    expect(screen.getByRole('group', { name: REACTION_BAR_LABEL })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar con 🎉' }))

    expect(toggleReaction).toHaveBeenCalledWith('room-1', 'm0', '🎉')
    // A pick dismisses the bar.
    expect(screen.queryByRole('group', { name: REACTION_BAR_LABEL })).not.toBeInTheDocument()
  })

  it('routes DM rows through the directed payload (the `to` peer)', () => {
    renderFeed([makeMessage({ roomId: 'dm:peer-9' })])

    fireEvent.click(screen.getByRole('button', { name: REACTION_ADD_LABEL }))
    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar con ❤️' }))

    expect(toggleReaction).toHaveBeenCalledWith('dm:peer-9', 'm0', '❤️', 'peer-9')
  })

  it('offers no reaction affordance on manual channels (no swarm to carry react)', () => {
    renderFeed([
      makeMessage({ roomId: 'dm:manual:ABCDEF0123456789', reactions: { '👍': [SELF_ID] } }),
    ])

    expect(screen.queryByRole('button', { name: REACTION_ADD_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: REACTIONS_ROW_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '👍 1' })).not.toBeInTheDocument()
  })
})

describe('keyboard reachability (RNF-05)', () => {
  it('opens the bar from opener focus and dismisses it with Escape', () => {
    renderFeed([makeMessage()])
    const opener = screen.getByRole('button', { name: REACTION_ADD_LABEL })

    // Native <button>: tab-reachable; focus alone opens the bar.
    fireEvent.focus(opener)
    expect(screen.getByRole('group', { name: REACTION_BAR_LABEL })).toBeInTheDocument()

    // The bar buttons are native buttons too: next Tab stop lands on 👍.
    const first = within(screen.getByRole('group', { name: REACTION_BAR_LABEL })).getAllByRole(
      'button',
    )[0]
    expect(first).toHaveTextContent('👍')

    fireEvent.keyDown(screen.getByText('hola 0'), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: REACTION_BAR_LABEL })).not.toBeInTheDocument()
  })

  it('picking with the keyboard toggles the reaction', () => {
    renderFeed([makeMessage({ reactions: { '👍': ['peer-1'] } })])
    const opener = screen.getByRole('button', { name: REACTION_ADD_LABEL })

    fireEvent.focus(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Reaccionar con 👍' }))

    expect(toggleReaction).toHaveBeenCalledWith('room-1', 'm0', '👍')
  })
})
