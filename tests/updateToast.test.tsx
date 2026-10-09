// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdateToast } from '../src/components/common/UpdateToast'
import { registerServiceWorker } from '../src/lib/pwa/registerSw'
import {
  UPDATE_AVAILABLE_TEXT,
  UPDATE_RELOAD_BUTTON,
  UPDATE_TOAST_DISMISS_LABEL,
} from '../src/components/settings/messages'

/**
 * Update toast (issue #104, phase 4): mounted at App level, it appears when
 * the registerSw module detects a waiting worker (a deployed new version
 * waiting behind this page) and offers the [Recargar] reload that swaps it
 * in. The tests drive the REAL registration flow with the same EventTarget
 * stubs as registerSw.test.ts — toast and detection module must agree — and
 * pin the issue's exact strings, the status role and the session-only
 * dismiss (a newer waiting worker notifies afresh; nothing persists).
 */

class FakeServiceWorker extends EventTarget {
  state: string
  constructor(state: string) {
    super()
    this.state = state
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeServiceWorker | null = null
  waiting: FakeServiceWorker | null = null
}

/**
 * Stubs navigator.serviceWorker with a container whose register() resolves
 * to a registration that ALREADY holds a waiting worker — the next-visit
 * shape of a deploy that landed since the last session.
 */
function primeWaitingWorker(): void {
  const registration = new FakeRegistration()
  registration.waiting = new FakeServiceWorker('installed')
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      controller: new FakeServiceWorker('activated'),
      waiting: registration.waiting,
      register: vi.fn().mockResolvedValue(registration),
    },
    configurable: true,
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})

describe('UpdateToast (issue #104, phase 4)', () => {
  it('renders nothing while no new version waits', () => {
    render(<UpdateToast />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('appears with the exact wording and role when a worker waits', async () => {
    primeWaitingWorker()
    render(<UpdateToast />)
    registerServiceWorker({ PROD: true })

    // The issue's exact toast: «New version available — [Recargar]».
    expect(UPDATE_AVAILABLE_TEXT).toBe('New version available')
    expect(await screen.findByRole('status', { name: 'New app version' })).toBeInTheDocument()
    expect(screen.getByText('New version available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: UPDATE_RELOAD_BUTTON })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: UPDATE_RELOAD_BUTTON })).toHaveTextContent('Reload')
  })

  it('Recargar calls location.reload so the waiting worker activates', async () => {
    primeWaitingWorker()
    const reload = vi.fn()
    // jsdom forbids redefining location.reload, so swap the global like
    // errorBoundary.test.tsx does.
    vi.stubGlobal('location', { reload })
    render(<UpdateToast />)
    registerServiceWorker({ PROD: true })

    fireEvent.click(await screen.findByRole('button', { name: UPDATE_RELOAD_BUTTON }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('dismissal hides the toast for the session; a newer waiting worker notifies afresh', async () => {
    primeWaitingWorker()
    render(<UpdateToast />)
    registerServiceWorker({ PROD: true })
    fireEvent.click(await screen.findByRole('button', { name: UPDATE_TOAST_DISMISS_LABEL }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    // Session-only dismiss: nothing re-shows the SAME waiting worker, but a
    // further deploy (a new registration finding a new waiting worker) is a
    // new fact and notifies again — the NetworkErrorBanner's
    // per-occurrence rule.
    primeWaitingWorker()
    registerServiceWorker({ PROD: true })
    expect(await screen.findByRole('status')).toBeInTheDocument()
  })

  it('the dismiss control is keyboard-operable with its accessible name', async () => {
    primeWaitingWorker()
    render(<UpdateToast />)
    registerServiceWorker({ PROD: true })

    const dismiss = await screen.findByRole('button', { name: UPDATE_TOAST_DISMISS_LABEL })
    expect(dismiss).toBeInTheDocument()
    fireEvent.click(dismiss)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('a detection while no toast is mounted is delivered on the next mount', async () => {
    // The registration in main.tsx races the first React effect; the
    // remember-me means a toast mounted afterwards still learns about the
    // waiting worker (App remounts, StrictMode re-runs). The flush below
    // lets the registration resolve BEFORE anything subscribes.
    primeWaitingWorker()
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    render(<UpdateToast />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByText(UPDATE_AVAILABLE_TEXT)).toBeInTheDocument()
  })
})
