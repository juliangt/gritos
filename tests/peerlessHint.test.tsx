// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import { PEERLESS_ROOM_HINT_TEXT } from '../src/lib/rooms'
import { useAppStore, type Room } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'

/**
 * Issue #125 — a genuinely empty room over healthy trackers stays
 * `searching`: ChatHeader must surface the latched `peerlessHint` as the
 * subordinate "may be empty" line (exact-text contract through
 * PEERLESS_ROOM_HINT_TEXT), never touching the pinned §10.3 status texts.
 */

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  useAppStore.setState(useAppStore.getInitialState())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-x',
    name: 'lobby',
    hasPassword: false,
    status: 'searching',
    peers: [],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
    ...overrides,
  }
}

describe('ChatHeader — peerless hint (issue #125)', () => {
  it('renders no hint line for a room without the peerlessHint flag', () => {
    render(<ChatHeader room={room()} onToggleSidebar={vi.fn()} />)

    expect(screen.queryByText(PEERLESS_ROOM_HINT_TEXT)).not.toBeInTheDocument()
    // The pinned §10.3 status text is the only status line.
    expect(screen.getByText('Searching for peers on the torrent network…')).toBeInTheDocument()
  })

  it('renders the exact hint text when the room latched peerlessHint', () => {
    render(<ChatHeader room={room({ peerlessHint: true })} onToggleSidebar={vi.fn()} />)

    expect(screen.getByText(PEERLESS_ROOM_HINT_TEXT)).toBeInTheDocument()
    expect(screen.getByText(PEERLESS_ROOM_HINT_TEXT)).toHaveClass('text-xs', 'text-muted')
    // The §10.3 searching text stays as-is next to the hint.
    expect(screen.getByText('Searching for peers on the torrent network…')).toBeInTheDocument()
  })
})
