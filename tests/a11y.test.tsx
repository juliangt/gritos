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

let _fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  _fake = installFakeTrystero()
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
  })
  store.setRecentRooms([])
}

describe('Accessibility (RNF-05)', () => {
  it('message feed is a polite live log', () => {
    render(<MessageFeed messages={[]} peers={[]} fifoTrimmed={false} ariaLabel="Mensajes" />)
    const log = screen.getByRole('log', { name: 'Mensajes' })
    expect(log).toHaveAttribute('aria-live', 'polite')
  })

  it('sidebar sections render semantic lists', () => {
    seedSidebar()
    render(<Sidebar />)

    const activas = within(screen.getByRole('region', { name: 'Salas activas' }))
    expect(activas.getAllByRole('list')).toHaveLength(1)
    expect(activas.getAllByRole('listitem')).toHaveLength(1)

    const pares = within(screen.getByRole('region', { name: 'Pares' }))
    expect(pares.getAllByRole('listitem')).toHaveLength(1)

    const dms = within(screen.getByRole('region', { name: 'Mensajes directos' }))
    // Empty DM section: no list, just the empty-state line.
    expect(dms.queryByRole('list')).not.toBeInTheDocument()
  })

  it('the join popover closes with Esc', () => {
    seedSidebar()
    render(<Sidebar />)
    fireEvent.click(screen.getByRole('button', { name: '[+ Unirse]' }))
    expect(screen.getByRole('form', { name: 'Unirse por nombre' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Unirse por nombre' })).not.toBeInTheDocument()
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Mostrar u ocultar la barra lateral' })[0])
    const drawer = screen.getByRole('dialog', { name: 'Barra lateral' })
    expect(drawer).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Barra lateral' })).not.toBeInTheDocument()
    })
  })
})
