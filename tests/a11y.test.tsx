// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { MessageFeed } from '../src/components/chat/MessageFeed'
import { Sidebar } from '../src/components/sidebar/Sidebar'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity, type Peer } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

function peer(id: string, nickname: string): Peer {
  return { id, nickname, fingerprint: null, latencyMs: 42, degraded: false }
}

function seedSidebar() {
  const store = useAppStore.getState()
  store.setActiveView({ kind: 'room', id: 'room-lobby' })
  store.upsertRoom({
    id: 'room-lobby',
    name: 'lobby',
    hasPassword: false,
    status: 'connected',
    peers: [peer('peer-aaaa3f1', 'luna-cauta')],
    messages: [],
    typing: {},
    unread: 0,
    fifoTrimmed: false,
    expiredCount: 0,
    recoveredCount: 0,
    historyAskDismissed: false,
  })
  store.setRecentRooms([])
}

describe('Accessibility (RNF-05)', () => {
  it('message feed is a polite live log', () => {
    render(
      <MessageFeed
        messages={[]}
        peers={[]}
        fifoTrimmed={false}
        expiredCount={0}
        recoveredCount={0}
        ariaLabel="Mensajes"
      />,
    )
    const log = screen.getByRole('log', { name: 'Mensajes' })
    expect(log).toHaveAttribute('aria-live', 'polite')
  })

  it('sidebar sections render semantic lists', () => {
    seedSidebar()
    render(<Sidebar />)

    const activas = within(screen.getByRole('region', { name: 'Active rooms' }))
    expect(activas.getAllByRole('list')).toHaveLength(1)
    expect(activas.getAllByRole('listitem')).toHaveLength(1)

    const pares = within(screen.getByRole('region', { name: 'Peers' }))
    expect(pares.getAllByRole('listitem')).toHaveLength(1)

    const dms = within(screen.getByRole('region', { name: 'Direct messages' }))
    // Empty DM section: no list, just the empty-state line.
    expect(dms.queryByRole('list')).not.toBeInTheDocument()
  })

  it('the join popover closes with Esc', () => {
    seedSidebar()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '[+ Join]' }))
    expect(screen.getByRole('form', { name: 'Join by name' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Join by name' })).not.toBeInTheDocument()
  })

  it('the mobile drawer closes with Esc (≤768 px)', async () => {
    // Force the mobile breakpoint for useMediaQuery.
    const realMatchMedia = window.matchMedia.bind(window)
    vi.stubGlobal('matchMedia', (query: string) => ({
      ...realMatchMedia(query),
      matches: query === '(max-width: 768px)',
    }))

    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)
    await waitFor(() => {
      expect(useAppStore.getState().activeView).not.toBeNull()
    })

    // No aside on the desktop layer; the drawer opens on the ☰ toggle.
    fireEvent.click(screen.getAllByRole('button', { name: 'Show or hide the sidebar' })[0])
    const drawer = screen.getByRole('dialog', { name: 'Sidebar' })
    expect(drawer).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Sidebar' })).not.toBeInTheDocument()
    })
  })
})
