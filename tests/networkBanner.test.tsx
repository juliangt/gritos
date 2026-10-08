// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NetworkErrorBanner } from '../src/components/chat/NetworkErrorBanner'
import { useAppStore, type Room } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  useAppStore.setState(useAppStore.getInitialState())
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function room(id: string, name: string, overrides: Partial<Room> = {}): Room {
  return {
    id,
    name,
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

function seed(rooms: Room[]) {
  act(() => {
    useAppStore.setState({
      rooms: Object.fromEntries(rooms.map((room) => [room.id, room])),
    })
  })
}

describe('Network error banner (RNF-07)', () => {
  it('renders nothing while every room is connected or searching', () => {
    seed([room('r1', 'lobby'), room('r2', 'dev', { status: 'searching' })])
    const { container } = render(<NetworkErrorBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the exact §10.3 text with the settings shortcut when a room errors', () => {
    seed([room('r1', 'lobby', { status: 'error' })])
    render(<NetworkErrorBanner />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Sin acceso a trackers — revisa tu conexión o configura trackers alternativos',
    )
    expect(screen.getByRole('button', { name: 'Abrir ajustes' })).toBeInTheDocument()
  })

  it('"Abrir ajustes" opens Ajustes on the Red tab (RF-07)', () => {
    seed([room('r1', 'lobby', { status: 'error' })])
    render(<NetworkErrorBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir ajustes' }))
    const dialog = screen.getByRole('dialog', { name: 'Ajustes' })
    expect(within(dialog).getByRole('tab', { name: 'Red' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('dismiss hides the banner and it returns when ANOTHER room errors', () => {
    seed([room('r1', 'lobby', { status: 'error' })])
    render(<NetworkErrorBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Descartar el aviso' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // A different room entering the error state re-shows the banner.
    seed([room('r1', 'lobby', { status: 'error' }), room('r2', 'dev', { status: 'error' })])
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('a dismissed room re-triggers the banner after recovering and erroring again', () => {
    seed([room('r1', 'lobby', { status: 'error' })])
    render(<NetworkErrorBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Descartar el aviso' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // Recovery prunes the dismissal…
    seed([room('r1', 'lobby', { status: 'connected' })])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // …so a later error of the SAME room is announced again.
    seed([room('r1', 'lobby', { status: 'error' })])
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
