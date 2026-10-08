// @vitest-environment jsdom
import './dom-setup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onUpdateReady, registerServiceWorker } from '../src/lib/pwa/registerSw'

/**
 * Issue #104 (phases 2+4) — the service worker registration is a
 * progressive enhancement and must fire only when it can actually work:
 * production builds on a secure context with a serviceWorker-capable
 * navigator. The dev server stays SW-free (mirroring the stripCspMetaInDev
 * philosophy of vite.config.ts), insecure origins already gate the P2P
 * stack (issue #43) and a rejected registration must never propagate.
 * Stubs follow the insecureContext.test.tsx pattern: EventTarget-based
 * registration/worker fakes as configurable own properties on
 * window/navigator, restored in afterEach to the dom-setup defaults.
 *
 * The phase-4 block drives the update flow end to end: a waiting worker —
 * already waiting at registration time, or an `updatefound` install
 * reaching `installed` while an older worker controls the page — must fire
 * the onUpdateReady callback exactly once, and a first install (no
 * controller) must never fire it.
 */

class FakeServiceWorker extends EventTarget {
  state: string
  constructor(state: string) {
    super()
    this.state = state
  }

  /** Moves the worker to the next lifecycle state, notifying listeners. */
  transition(state: string): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeServiceWorker | null = null
  waiting: FakeServiceWorker | null = null
}

type RegisterFn = ReturnType<typeof vi.fn>

interface FakeContainer {
  controller: FakeServiceWorker | null
  waiting: FakeServiceWorker | null
  register: RegisterFn
}

function installServiceWorker(
  register: RegisterFn,
  overrides: Partial<Pick<FakeContainer, 'controller' | 'waiting'>> = {},
): FakeContainer {
  const container: FakeContainer = { controller: null, waiting: null, register, ...overrides }
  Object.defineProperty(navigator, 'serviceWorker', {
    value: container,
    configurable: true,
  })
  return container
}

function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
}

afterEach(() => {
  // jsdom's Navigator has no own serviceWorker property: deleting the stub
  // restores the not-implemented default. dom-setup pins isSecureContext
  // to `true`, so restore that too.
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})

describe('registerServiceWorker (issue #104, phase 2)', () => {
  it('registers ./sw.js once in a production, secure context', () => {
    const register = vi.fn().mockResolvedValue(new FakeRegistration())
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker({ PROD: true })

    expect(register).toHaveBeenCalledTimes(1)
    // Relative on purpose: resolves against the page URL, so the worker's
    // scope covers subpath deployments (GitHub Pages project sites).
    expect(register).toHaveBeenCalledWith('./sw.js')
  })

  it('never registers in a dev build (PROD false)', () => {
    const register = vi.fn().mockResolvedValue(new FakeRegistration())
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker({ PROD: false })

    expect(register).not.toHaveBeenCalled()
  })

  it('never registers with the real import.meta.env default (vitest is a dev build)', () => {
    // The production wiring passes no env argument; under the test runner
    // that default must resolve to a dev build, keeping the dev server
    // SW-free even if a future call site forgets the guard.
    expect(import.meta.env.PROD).toBe(false)

    const register = vi.fn().mockResolvedValue(new FakeRegistration())
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker()

    expect(register).not.toHaveBeenCalled()
  })

  it('never registers on an insecure context', () => {
    const register = vi.fn().mockResolvedValue(new FakeRegistration())
    installServiceWorker(register)
    setSecureContext(false)

    expect(() => registerServiceWorker({ PROD: true })).not.toThrow()
    expect(register).not.toHaveBeenCalled()
  })

  it('never registers when the navigator has no serviceWorker', () => {
    // Not installed at all: jsdom's Navigator, old browsers, insecure
    // origins. The call must be a silent no-op.
    setSecureContext(true)

    expect(() => registerServiceWorker({ PROD: true })).not.toThrow()
  })

  it('swallows a rejected registration with a console.info at most', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const register = vi.fn().mockRejectedValue(new Error('quota exceeded'))
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker({ PROD: true })
    // Let the rejection reach the module's catch handler.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(register).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(1)
    info.mockRestore()
  })
})

describe('update flow: waiting-worker detection (issue #104, phase 4)', () => {
  it('fires the callback for a worker that is already waiting at registration time', async () => {
    // A deploy landed while the user was away and never reloaded: the next
    // visit finds the waiting worker as soon as the registration resolves.
    const registration = new FakeRegistration()
    registration.waiting = new FakeServiceWorker('installed')
    installServiceWorker(vi.fn().mockResolvedValue(registration))
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onUpdate).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('never fires the callback when no worker is waiting', async () => {
    const registration = new FakeRegistration()
    installServiceWorker(vi.fn().mockResolvedValue(registration))
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onUpdate).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('fires the callback when an updatefound install reaches installed under an old controller', async () => {
    // The canonical update: this page loads under the deployed old worker
    // (controller != null), the registration finds a new version, installs
    // it and — with no skipWaiting — parks it as the waiting worker.
    const registration = new FakeRegistration()
    const installing = new FakeServiceWorker('installing')
    registration.installing = installing
    const container = installServiceWorker(vi.fn().mockResolvedValue(registration), {
      controller: new FakeServiceWorker('activated'),
    })
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The registration announces the new version, then the install worker
    // walks its lifecycle to `installed` (the waiting state).
    registration.dispatchEvent(new Event('updatefound'))
    installing.transition('installed')
    expect(onUpdate).toHaveBeenCalledTimes(1)

    // The waiting worker is now visible through the container too (the
    // browser mirrors it): a second detection is the same fact, and the
    // toast must not double-fire for it.
    container.waiting = installing
    expect(onUpdate).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('never fires for a first install (no controller) even though it passes through installed', async () => {
    // On the very first install there is nothing to update: the worker
    // transits `installed` straight into activation and the page has no
    // controller — the standard update guard must keep the toast silent.
    const registration = new FakeRegistration()
    const installing = new FakeServiceWorker('installing')
    registration.installing = installing
    installServiceWorker(vi.fn().mockResolvedValue(registration))
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    registration.dispatchEvent(new Event('updatefound'))
    installing.transition('installed')
    installing.transition('activating')
    installing.transition('activated')
    expect(onUpdate).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not fire while the updatefound install is still installing', async () => {
    const registration = new FakeRegistration()
    const installing = new FakeServiceWorker('installing')
    registration.installing = installing
    installServiceWorker(vi.fn().mockResolvedValue(registration), {
      controller: new FakeServiceWorker('activated'),
    })
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    registration.dispatchEvent(new Event('updatefound'))
    installing.transition('installing')
    expect(onUpdate).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('tolerates an updatefound without an installing worker', async () => {
    const registration = new FakeRegistration()
    installServiceWorker(vi.fn().mockResolvedValue(registration), {
      controller: new FakeServiceWorker('activated'),
    })
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(() => registration.dispatchEvent(new Event('updatefound'))).not.toThrow()
    expect(onUpdate).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('delivers a detection that happened before anyone subscribed on subscribe', async () => {
    // The registration in main.tsx races the first React effect: a waiting
    // worker found before the toast subscribes must be remembered, not lost.
    const registration = new FakeRegistration()
    registration.waiting = new FakeServiceWorker('installed')
    installServiceWorker(vi.fn().mockResolvedValue(registration))
    setSecureContext(true)

    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('stops delivering after the unsubscribe', async () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeServiceWorker('installed')
    installServiceWorker(vi.fn().mockResolvedValue(registration))
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    unsubscribe()

    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onUpdate).not.toHaveBeenCalled()
    // The notification was remembered for the NEXT subscriber (never lost —
    // the remember-me under the main.tsx race): consume it here so the
    // module state stays clean for the following tests.
    const next = vi.fn()
    const unsubscribeNext = onUpdateReady(next)
    expect(next).toHaveBeenCalledTimes(1)
    unsubscribeNext()
  })

  it('a rejected registration never touches the callback', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    installServiceWorker(vi.fn().mockRejectedValue(new Error('offline')))
    setSecureContext(true)

    const onUpdate = vi.fn()
    const unsubscribe = onUpdateReady(onUpdate)
    registerServiceWorker({ PROD: true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onUpdate).not.toHaveBeenCalled()
    unsubscribe()
    info.mockRestore()
  })
})
