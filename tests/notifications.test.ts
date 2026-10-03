// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import {
  dmNotificationTitle,
  mentionNotificationTitle,
  notificationPermissionState,
  notificationBody,
  notifyIncomingDm,
  notifyMention,
  requestNotificationPermission,
  shouldNotify,
  shouldNotifyDm,
} from '../src/lib/notifications'
import { mentionsNickname } from '../src/lib/markdown/parse'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'
import { useSettingsStore } from '../src/stores/useSettingsStore'

/**
 * M5 full desktop-notification behavior (§10.5/RF-09): the gate is
 * permission granted AND settings.notifications on AND document.hidden;
 * the two triggers are room mentions and incoming DMs; click focuses the
 * window and navigates to the origin view. The Notification API is stubbed.
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
  notificationsSetting?: boolean
}): void {
  Object.defineProperty(document, 'hidden', {
    value: overrides.hidden ?? false,
    configurable: true,
  })
  if (overrides.api === false) {
    vi.unstubAllGlobals()
    // jsdom has no Notification by default; removing the stub means absent.
  } else {
    FakeNotification.permission = overrides.permission ?? 'granted'
    FakeNotification.instances = []
    vi.stubGlobal('Notification', FakeNotification)
  }
  useSettingsStore.getState().setSettings({
    notifications: overrides.notificationsSetting ?? true,
  })
}

beforeEach(() => {
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  vi.spyOn(window, 'focus').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

describe('gating logic (pure, RF-09)', () => {
  it('fires only with the toggle on, hidden tab and granted permission', () => {
    expect(shouldNotify({ hidden: true, permission: 'granted', enabled: true })).toBe(true)
    expect(shouldNotify({ hidden: false, permission: 'granted', enabled: true })).toBe(false)
    expect(shouldNotify({ hidden: true, permission: 'denied', enabled: true })).toBe(false)
    expect(shouldNotify({ hidden: true, permission: 'default', enabled: true })).toBe(false)
    expect(shouldNotify({ hidden: true, permission: 'granted', enabled: false })).toBe(false)
    expect(shouldNotify({ hidden: false, permission: 'denied', enabled: false })).toBe(false)
  })

  it('legacy transport gate (M3) stays hidden + granted', () => {
    expect(shouldNotifyDm({ hidden: true, permission: 'granted' })).toBe(true)
    expect(shouldNotifyDm({ hidden: false, permission: 'granted' })).toBe(false)
    expect(shouldNotifyDm({ hidden: true, permission: 'denied' })).toBe(false)
  })
})

describe('title and body formats (§10.5 exact)', () => {
  it('builds the mention, DM and body strings', () => {
    expect(mentionNotificationTitle('general')).toBe('gritos — mención en #general')
    expect(dmNotificationTitle('luna-cauta')).toBe('gritos — DM de luna-cauta')
    expect(notificationBody('zorro-bravo', 'hola @ti…')).toBe('zorro-bravo: hola @ti…')
  })
})

describe('mention matcher (M2 reuse, RF-09)', () => {
  it('matches case-insensitively at word boundaries', () => {
    expect(mentionsNickname('hola @Luna-Cauta!', 'luna-cauta')).toBe(true)
    expect(mentionsNickname('@luna-cauta', 'luna-cauta')).toBe(true)
    expect(mentionsNickname('ey @luna-cauta,', 'luna-cauta')).toBe(true)
    expect(mentionsNickname('hola @luna-cautax', 'luna-cauta')).toBe(false)
    expect(mentionsNickname('correo x@luna-cauta', 'luna-cauta')).toBe(false)
    expect(mentionsNickname('sin mención', 'luna-cauta')).toBe(false)
    expect(mentionsNickname('hola @luna-cauta', '')).toBe(false)
  })
})

describe('notifyIncomingDm (full M5 gate)', () => {
  const dm = { peerId: 'peer-1', nick: 'luna-cauta', text: '¿ahí?' }

  it('shows the notification when hidden AND granted AND toggled on', () => {
    stubEnvironment({ hidden: true, permission: 'granted', notificationsSetting: true })
    expect(notifyIncomingDm(dm)).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — DM de luna-cauta')
    expect(FakeNotification.instances[0]?.options?.body).toBe('luna-cauta: ¿ahí?')
  })

  it('does not fire for a visible tab', () => {
    stubEnvironment({ hidden: false, permission: 'granted' })
    expect(notifyIncomingDm(dm)).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('does not fire with the settings toggle off', () => {
    stubEnvironment({ hidden: true, permission: 'granted', notificationsSetting: false })
    expect(notifyIncomingDm(dm)).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('does not fire with denied or unrequested permission', () => {
    stubEnvironment({ hidden: true, permission: 'denied' })
    expect(notifyIncomingDm(dm)).toBe(false)
    stubEnvironment({ hidden: true, permission: 'default' })
    expect(notifyIncomingDm(dm)).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)
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
    expect(() => notifyIncomingDm(dm)).not.toThrow()
    expect(notifyIncomingDm(dm)).toBe(false)

    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        constructor() {
          throw new Error('boom')
        }
      },
    )
    expect(() => notifyIncomingDm(dm)).not.toThrow()
    expect(notifyIncomingDm(dm)).toBe(false)
  })
})

describe('notifyMention (RF-09 room trigger)', () => {
  const mention = {
    roomId: 'room-1',
    roomName: 'general',
    nick: 'zorro-bravo',
    text: 'hola @luna-cauta',
  }

  it('shows "gritos — mención en #general" with the author body when hidden', () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    expect(notifyMention(mention)).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0]?.title).toBe('gritos — mención en #general')
    expect(FakeNotification.instances[0]?.options?.body).toBe('zorro-bravo: hola @luna-cauta')
  })

  it('does not fire for a visible tab, toggle off or denied permission', () => {
    stubEnvironment({ hidden: false, permission: 'granted' })
    expect(notifyMention(mention)).toBe(false)
    stubEnvironment({ hidden: true, permission: 'granted', notificationsSetting: false })
    expect(notifyMention(mention)).toBe(false)
    stubEnvironment({ hidden: true, permission: 'denied' })
    expect(notifyMention(mention)).toBe(false)
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('navigates to the origin room and focuses the window on click', () => {
    stubEnvironment({ hidden: true, permission: 'granted' })
    notifyMention(mention)
    FakeNotification.instances[0]?.onclick?.()
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeView).toEqual({ kind: 'room', id: 'room-1' })
  })
})

describe('permission helpers (RF-07 Privacidad)', () => {
  it('reflects granted / denied / default states', () => {
    stubEnvironment({ permission: 'granted' })
    expect(notificationPermissionState()).toBe('granted')
    stubEnvironment({ permission: 'denied' })
    expect(notificationPermissionState()).toBe('denied')
    stubEnvironment({ permission: 'default' })
    expect(notificationPermissionState()).toBe('default')
    stubEnvironment({ api: false })
    expect(notificationPermissionState()).toBe('unsupported')
  })

  it('requestNotificationPermission resolves without the API and on rejection', async () => {
    stubEnvironment({ api: false })
    await expect(requestNotificationPermission()).resolves.toBeUndefined()

    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(new Error('boom')),
    })
    await expect(requestNotificationPermission()).resolves.toBeUndefined()
  })

  it('requestNotificationPermission resolves with the browser answer', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    })
    await expect(requestNotificationPermission()).resolves.toBe('granted')
  })
})
