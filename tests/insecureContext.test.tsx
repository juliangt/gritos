// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../src/App'
import { resetManagerForTests } from '../src/lib/p2p/roomManager'
import { useAppStore, type Identity } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'
import { INSECURE_CONTEXT_BANNER_TEXT } from '../src/lib/rooms'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Issue #43 — returning visitors on a non-secure context (plain HTTP over a
 * LAN IP): `crypto.subtle` is unavailable, so the #lobby auto-join would
 * always reject. ChatLayout must skip the attempt entirely (issue
 * acceptance: no silent join failure) and NetworkErrorBanner must explain
 * why, with a dismissal. jsdom does not implement `isSecureContext`;
 * dom-setup shims it to `true`, so each case pins the flag with a
 * configurable own property and the afterEach hook restores the shim value.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  useAppStore.setState(useAppStore.getInitialState())
  fake = installFakeTrystero()
})

afterEach(() => {
  cleanup()
  resetManagerForTests()
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})

function setSecureContext(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true })
}

const IDENTITY: Identity = {
  nickname: 'zorro-bravo',
  fingerprint: 'A31F 09BC 77D2 4E5A',
  createdAt: 1_700_000_000_000,
}

describe('insecure context on the returning-visitor path (issue #43)', () => {
  it('shows the secure-context notice and skips the #lobby auto-join', async () => {
    setSecureContext(false)
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    expect(screen.getByText(INSECURE_CONTEXT_BANNER_TEXT)).toBeInTheDocument()
    // Give any (wrong) async join a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fake.joinRoomFn).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeView).toBeNull()
  })

  it('auto-joins #lobby with no notice on a secure context (jsdom default)', async () => {
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    expect(screen.queryByText(INSECURE_CONTEXT_BANNER_TEXT)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(fake.joinRoomFn).toHaveBeenCalledTimes(1)
    })
  })

  it('the insecure-context notice can be dismissed', () => {
    setSecureContext(false)
    useAppStore.getState().setIdentity(IDENTITY)
    render(<App />)

    expect(screen.getByText(INSECURE_CONTEXT_BANNER_TEXT)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the notice' }))
    expect(screen.queryByText(INSECURE_CONTEXT_BANNER_TEXT)).not.toBeInTheDocument()
  })
})
