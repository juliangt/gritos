// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #48 (RNF-05): the mobile drawer is `role="dialog" aria-modal="true"`,
 * so while it is open keyboard focus must stay trapped inside it (Tab and
 * Shift+Tab cycle through its focusables) and return to the ☰ toggle on
 * close — the same contract `tests/modal.test.tsx` covers for Modal.
 */

const TOGGLE_NAME = 'Show or hide the sidebar'
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

beforeEach(() => {
  localStorage.clear()
  window.history.pushState({}, '', '/')
  useSettingsStore.getState().resetSettings()
  installFakeTrystero()
  // Force the mobile breakpoint for useMediaQuery.
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

async function renderMobileApp() {
  useAppStore.getState().setIdentity(IDENTITY)
  render(<App />)
  await waitFor(() => {
    expect(useAppStore.getState().activeView).not.toBeNull()
  })
}

/** Opens the drawer from the toggle, focusing it first like a keyboard user. */
function openDrawerFromToggle() {
  const toggle = screen.getAllByRole('button', { name: TOGGLE_NAME })[0]
  toggle.focus()
  fireEvent.click(toggle)
  return { toggle, drawer: screen.getByRole('dialog', { name: 'Sidebar' }) }
}

function drawerFocusables(drawer: HTMLElement) {
  return Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}

async function expectDrawerClosed() {
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Sidebar' })).not.toBeInTheDocument()
  })
}

describe('Mobile drawer focus trap (issue #48, RNF-05)', () => {
  it('moves the focus into the drawer when it opens', async () => {
    await renderMobileApp()
    const { drawer } = openDrawerFromToggle()

    expect(document.activeElement).not.toBe(document.body)
    expect(drawer.contains(document.activeElement)).toBe(true)
  })

  it('wraps Tab at both ends of the drawer focusables', async () => {
    await renderMobileApp()
    const { drawer } = openDrawerFromToggle()
    const focusables = drawerFocusables(drawer)
    expect(focusables.length).toBeGreaterThan(0)

    // Tab on the last focusable wraps to the first.
    focusables[focusables.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])

    // Shift+Tab on the first focusable wraps to the last.
    focusables[0].focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(focusables[focusables.length - 1])
  })

  it('never lets Tab reach the chat content behind the open drawer', async () => {
    await renderMobileApp()
    const { drawer } = openDrawerFromToggle()
    const focusables = drawerFocusables(drawer)
    expect(focusables.length).toBeGreaterThan(0)

    // The composer sits behind the drawer, outside the trap surface.
    const composer = screen.getByLabelText('Write a message')
    expect(drawer.contains(composer)).toBe(false)

    // Tab from every focusable position: the focus must stay in the drawer.
    for (const element of focusables) {
      element.focus()
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(drawer.contains(document.activeElement)).toBe(true)
      expect(document.activeElement).not.toBe(composer)
    }

    // Even with the focus escaped to <body>, Tab pulls it back inside.
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(drawer.contains(document.activeElement)).toBe(true)
  })

  it('returns the focus to the toggle when the drawer closes with Esc', async () => {
    await renderMobileApp()
    const { toggle } = openDrawerFromToggle()

    fireEvent.keyDown(window, { key: 'Escape' })
    await expectDrawerClosed()
    expect(document.activeElement).toBe(toggle)
  })

  it('returns the focus to the toggle when the drawer closes from the backdrop', async () => {
    await renderMobileApp()
    const { toggle, drawer } = openDrawerFromToggle()

    // The backdrop is the first child of the overlay (issue: aria-hidden).
    fireEvent.click(drawer.firstElementChild as HTMLElement)
    await expectDrawerClosed()
    expect(document.activeElement).toBe(toggle)
  })

  it('returns the focus to the toggle when the drawer is toggled closed', async () => {
    await renderMobileApp()
    const { toggle } = openDrawerFromToggle()

    // The header ☰ is the same button that opened the drawer.
    fireEvent.click(toggle)
    await expectDrawerClosed()
    expect(document.activeElement).toBe(toggle)
  })
})
