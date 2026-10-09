// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../src/App'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Responsive check for the ≤768 px layout (M6, RNF-05/plan §4): jsdom has no
 * viewport, so the mobile branch is exercised by forcing the media query to
 * match — the sidebar must work as an overlay drawer with backdrop, the
 * composer must stay usable and the compact header controls present.
 */

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  installFakeTrystero()
  const realMatchMedia = window.matchMedia.bind(window)
  vi.stubGlobal('matchMedia', (query: string) => ({
    ...realMatchMedia(query),
    matches: query === '(max-width: 768px)',
  }))
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

function renderMobileApp() {
  useAppStore.getState().setIdentity(IDENTITY)
  const view = render(<App />)
  return waitFor(() => {
    expect(useAppStore.getState().activeView).not.toBeNull()
  }).then(() => view)
}

function openDrawer() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Show or hide the sidebar' })[0])
  return screen.getByRole('dialog', { name: 'Sidebar' })
}

describe('Responsive ≤768 px (mobile drawer layout)', () => {
  it('renders no persistent sidebar and opens it as a drawer with backdrop', async () => {
    await renderMobileApp()

    // Drawer closed: no overlay dialog and no sidebar content.
    expect(screen.queryByRole('dialog', { name: 'Sidebar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Active rooms' })).not.toBeInTheDocument()

    const drawer = openDrawer()
    // The backdrop sits inside the overlay and is hidden from AT.
    const backdrop = drawer.firstElementChild as HTMLElement
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    // Sidebar content is reachable inside the drawer.
    expect(within(drawer).getByRole('region', { name: 'Active rooms' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: '[+ Join]' })).toBeInTheDocument()
  })

  it('opening a room from the drawer closes it', async () => {
    await renderMobileApp()

    const drawer = openDrawer()
    // #general is suggested (only #lobby is active).
    fireEvent.click(within(drawer).getByRole('button', { name: '#general' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Sidebar' })).not.toBeInTheDocument()
    })
  })

  it('keeps the composer usable: enabled textarea, send button and compact header', async () => {
    await renderMobileApp()

    const textarea = screen.getByLabelText('Write a message')
    expect(textarea).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    // Markdown help is hidden on small screens (hidden sm:inline).
    expect(screen.getByText('**bold** · *italic* · `code`')).toHaveClass('hidden')
    // Compact header: room name plus the settings entry stay available.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })
})
