// @vitest-environment jsdom
import './dom-setup'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerServiceWorker } from '../src/lib/pwa/registerSw'

/**
 * Issue #104 (phase 2) — the service worker registration is a progressive
 * enhancement and must fire only when it can actually work: production
 * builds on a secure context with a serviceWorker-capable navigator. The
 * dev server stays SW-free (mirroring the stripCspMetaInDev philosophy of
 * vite.config.ts), insecure origins already gate the P2P stack (issue #43)
 * and a rejected registration must never propagate. Stubs follow the
 * insecureContext.test.tsx pattern: configurable own properties on
 * window/navigator, restored in afterEach to the dom-setup defaults.
 */

type RegisterFn = ReturnType<typeof vi.fn>

function installServiceWorker(register: RegisterFn): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register },
    configurable: true,
  })
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
    const register = vi.fn().mockResolvedValue(undefined)
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker({ PROD: true })

    expect(register).toHaveBeenCalledTimes(1)
    // Relative on purpose: resolves against the page URL, so the worker's
    // scope covers subpath deployments (GitHub Pages project sites).
    expect(register).toHaveBeenCalledWith('./sw.js')
  })

  it('never registers in a dev build (PROD false)', () => {
    const register = vi.fn().mockResolvedValue(undefined)
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

    const register = vi.fn().mockResolvedValue(undefined)
    installServiceWorker(register)
    setSecureContext(true)

    registerServiceWorker()

    expect(register).not.toHaveBeenCalled()
  })

  it('never registers on an insecure context', () => {
    const register = vi.fn().mockResolvedValue(undefined)
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
