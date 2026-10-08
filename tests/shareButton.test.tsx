// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatHeader } from '../src/components/chat/ChatHeader'
import { buildRoomLink } from '../src/lib/shareLinks'
import type { Room } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #41 — the room-header share affordance: navigator.share when
 * available, clipboard fallback with brief 'Enlace copiado' feedback. The
 * produced URL always comes from buildRoomLink (only the room name rides
 * along; the password never does).
 */

beforeEach(() => {
  localStorage.clear()
  installFakeTrystero()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window.navigator, 'share')
  Reflect.deleteProperty(window.navigator, 'clipboard')
  vi.useRealTimers()
})

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: 'room-x',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
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

function stubNavigatorProperty(name: 'share' | 'clipboard', value: unknown): void {
  Object.defineProperty(window.navigator, name, { value, configurable: true })
}

describe('ChatHeader — Compartir sala (issue #41)', () => {
  it('uses navigator.share with the built room link when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    stubNavigatorProperty('share', share)
    render(<ChatHeader room={room({ name: 'lobby' })} onToggleSidebar={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compartir sala' }))

    await waitFor(() => {
      expect(share).toHaveBeenCalledTimes(1)
    })
    expect(share).toHaveBeenCalledWith({
      title: 'Sala #lobby en gritos',
      url: buildRoomLink('lobby'),
    })
    // The share sheet needs no clipboard feedback.
    expect(screen.queryByText('Enlace copiado')).not.toBeInTheDocument()
  })

  it('prefers navigator.share even when the clipboard exists', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigatorProperty('share', share)
    stubNavigatorProperty('clipboard', { writeText })
    render(<ChatHeader room={room({ name: 'dev' })} onToggleSidebar={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compartir sala' }))

    await waitFor(() => {
      expect(share).toHaveBeenCalledTimes(1)
    })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to the clipboard and shows the Enlace copiado feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigatorProperty('clipboard', { writeText })
    render(<ChatHeader room={room({ name: 'mi-sala' })} onToggleSidebar={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compartir sala' }))

    await screen.findByText('Enlace copiado')
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(buildRoomLink('mi-sala'))
  })

  it('never leaks a room password through the shared URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubNavigatorProperty('clipboard', { writeText })
    render(
      <ChatHeader room={room({ name: 'secreta', hasPassword: true })} onToggleSidebar={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Compartir sala' }))

    await screen.findByText('Enlace copiado')
    const url = writeText.mock.calls[0]?.[0] as string
    expect(url).toContain('#sala=secreta')
    expect(url).not.toContain('password')
  })

  it('offers no share affordance without an active room', () => {
    render(<ChatHeader room={null} onToggleSidebar={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Compartir sala' })).not.toBeInTheDocument()
  })

  it('a denied clipboard degrades silently (no crash, no feedback)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    stubNavigatorProperty('clipboard', { writeText })
    render(<ChatHeader room={room({ name: 'lobby' })} onToggleSidebar={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Compartir sala' }))

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Enlace copiado')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ajustes' })).toBeInTheDocument()
  })
})
