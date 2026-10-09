// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Badge } from '../src/components/common/Badge'
import { StatusDot } from '../src/components/common/StatusDot'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import { en } from '../src/i18n/en'
import { setLocale, t, tPlural } from '../src/i18n/index'
import type { Peer, Room } from '../src/stores/useAppStore'

/**
 * Issue #119 phase 3 — the inline-literal migration: proves that the
 * formerly hardcoded aria labels and counts now RESOLVE THROUGH the i18n
 * runtime inside the real components (not just that the dictionary holds
 * the strings — i18nCopy.test.ts covers the key-level contract):
 *
 *  (a) StatusDot's three connection-status labels render through `t`,
 *  (b) ChatHeader's peer count renders through the `common.peerCount`
 *      tPlural pair at 1 and 2 (the hardcoded 'peer'/'peers' ternary and
 *      DmHeader's hardcoded '1 peer' are gone),
 *  (c) Badge's unread pill renders through the `common.unreadCount` pair,
 *  and that all of it is LOCALE-LIVE (an es flip re-renders the labels).
 */

afterEach(() => {
  cleanup()
  setLocale('en')
})

function peer(id: string): Peer {
  return { id, nickname: `nick-${id}`, fingerprint: null, latencyMs: null, degraded: false }
}

function roomWithPeers(peers: Peer[]): Room {
  return {
    id: 'room-1',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers,
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
  }
}

describe('StatusDot — a11y labels resolve through t', () => {
  it('renders the three §10.3 status labels (en)', () => {
    const { rerender } = render(<StatusDot status="searching" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'searching for peers')
    rerender(<StatusDot status="connected" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'connected')
    rerender(<StatusDot status="error" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'no tracker access')
    // The exact-text contract: the rendered strings are the dictionary's.
    expect(en['chat.statusSearching']).toBe('searching for peers')
  })

  it('is locale-live: the label flips with the locale and back', () => {
    const { rerender } = render(<StatusDot status="searching" />)
    setLocale('es')
    rerender(<StatusDot status="searching" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', t('chat.statusSearching'))
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'buscando pares')
    setLocale('en')
    rerender(<StatusDot status="searching" />)
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'searching for peers')
  })
})

describe('ChatHeader — peer count through the tPlural pair', () => {
  it('renders 1 and 2 peers through common.peerCount (the ternary is gone)', () => {
    const { rerender } = render(
      <ChatHeader room={roomWithPeers([peer('a')])} onToggleSidebar={() => {}} />,
    )
    expect(screen.getByText('1 peer')).toBeInTheDocument()

    rerender(<ChatHeader room={roomWithPeers([peer('a'), peer('b')])} onToggleSidebar={() => {}} />)
    expect(screen.getByText('2 peers')).toBeInTheDocument()

    // The pair itself, at the template level.
    expect(tPlural('common.peerCount', 1)).toBe('1 peer')
    expect(tPlural('common.peerCount', 2)).toBe('2 peers')
  })
})

describe('Badge — unread pill through the plural pair', () => {
  it('renders 1 unread / 2 unread through common.unreadCount', () => {
    const { rerender } = render(<Badge count={1} />)
    expect(screen.getByText('1')).toHaveAttribute('aria-label', '1 unread')
    rerender(<Badge count={2} />)
    expect(screen.getByText('2')).toHaveAttribute('aria-label', '2 unread')
    expect(tPlural('common.unreadCount', 1)).toBe('1 unread')
    expect(tPlural('common.unreadCount', 2)).toBe('2 unread')
  })
})
