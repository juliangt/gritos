// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  dmNotificationBody,
  dmNotificationTitle,
  notifyIncomingDm,
  shouldNotifyDm,
} from '../src/lib/notifications'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'

/**
 * M3 basic incoming-DM notifications (§10.5/RF-09): hidden tab + already
 * granted permission are the only gate; click focuses the window and
 * navigates to the DM. The Notification API is stubbed — the real
 * permission flow and settings toggle are M5 scope.
 */

class FakeNotification {
  static permission = 'granted'
  static instances: FakeNotification[] = []
  onclick: (() => void) | null = null
  title: string
  options?: { body?: string }

  constructor(title: string, options?: { body?: string }) {
    this.title = title
    this.options = options
    FakeNotification.instances.push(this)
  }
}

function stubEnvironment(overrides: {
  hidden?: boolean
  permission?: string
  api?: boolean
}): void {
  Object.defineProperty(document, 'hidden', {
    value: overrides.hidden ?? false,
    configurable: true,
  })
  if (overrides.api === false) {
    vi.unstubAllGlobals()
    // jsdom has no Notification by default; removing the stub means absent.
    return
  }
  FakeNotification.permission = overrides.permission ?? 'granted'
  FakeNotification.instances = []
  vi.stubGlobal('Notification', FakeNotification)
}

beforeEach(() => {
  useAppStore.setState({ ...INITIAL_APP_STATE })
  vi.spyOn(window, 'focus').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

describe('gating logic (pure)', () => {
  it('fires only for hidden tabs with granted permission', () => {
    expect(shouldNotifyDm({ hidden: true, permission: 'granted' })).toBe(true)
    expect(shouldNotifyDm({ hidden: false, permission: 'granted' })).toBe(false)
    expect(shouldNotifyDm({ hidden: true, permission: 'denied' })).toBe(false)
    expect(shouldNotifyDm({ hidden: true, permission: 'default' })).toBe(false)
    expect(shouldNotifyDm({ hidden: false, permission: 'denied' })).toBe(false)
  })
})

describe('title and body format (§10.5 exact)', () => {
  it('builds "gritos — DM de <nick>" and "<nick>: <text>"', () => {
    expect(dmNotificationTitle('luna-cauta')).toBe('gritos — DM de luna-cauta')
    expect(dmNotificationBody('zorro-bravo', 'hola @ti')).toBe('zorro-bravo: hola @ti')
  })
})

describe('notifyIncomingDm (guarded against every environment)', () => {
  it('shows the notification only when hidden AND permission granted', () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    expect(
      notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: '¿ahí?' }),
    ).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — DM de luna-cauta')
    expect(FakeNotification.instances[0]?.options?.body).toBe('luna-cauta: ¿ahí?')

    // Visible tab: nothing.
    stubEnvironment({ hidden: false, permission: 'granted' })
    expect(notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' })).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)

    // Hidden but permission denied/never asked: nothing.
    stubEnvironment({ hidden: true, permission: 'denied' })
    expect(notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' })).toBe(false)
    stubEnvironment({ hidden: true, permission: 'default' })
    expect(notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' })).toBe(false)
  })

  it('navigates to the DM view and focuses the window on click', () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    notifyIncomingDm({ peerId: 'peer-9', nick: 'zorro-bravo', text: 'hola' })
    const notification = FakeNotification.instances[0]
    expect(notification?.onclick).not.toBeNull()

    notification?.onclick?.()
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'dm', peerId: 'peer-9' })
  })

  it('never throws without the Notification API or on constructor failure', () => {
    stubEnvironment({ hidden: true, api: false })
    expect(() =>
      notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' }),
    ).not.toThrow()
    expect(notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' })).toBe(false)

    // A constructor that throws is swallowed too.
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        constructor() {
          throw new Error('boom')
        }
      },
    )
    expect(() =>
      notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' }),
    ).not.toThrow()
    expect(notifyIncomingDm({ peerId: 'peer-1', nick: 'luna-cauta', text: 'x' })).toBe(false)
  })
})
