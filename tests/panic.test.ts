// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGritosStorage, PANIC_STORAGE_KEYS, panicWipe } from '../src/lib/panic'
import * as manager from '../src/lib/p2p/roomManager'
import {
  createSessionIdentity,
  exportIdentityJwks,
  IDENTITY_STORAGE_KEY,
  persistIdentity,
} from '../src/lib/crypto/identity'
import { ROOMS_STORAGE_KEY } from '../src/lib/recentRooms'
import { pinTofuFingerprint, TOFU_STORAGE_KEY } from '../src/lib/tofu'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { UI_STORAGE_KEY, useUiStore } from '../src/stores/useUiStore'
import {
  INITIAL_APP_STATE,
  useAppStore,
  type Identity,
  type Room,
} from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * RF-08 — panic wipe: every WebRTC connection aborted, the FIVE documented
 * `gritos:*` keys (spec §8.2) removed (plus stray `gritos:*` defensively),
 * in-memory stores reset, and the app reloads. Keys outside the app
 * namespace are never touched.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function seedActiveSession(): Promise<void> {
  // A real post-onboarding session: the identity was persisted with its JWKs.
  const session = await createSessionIdentity('zorro-bravo')
  const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
  persistIdentity({
    nickname: 'zorro-bravo',
    fingerprint: session.identity.fingerprint,
    createdAt: session.identity.createdAt,
    pubJwk,
    privJwk,
  })

  // Two live rooms through the manager (recents written on join).
  await manager.joinRoom('lobby')
  await manager.joinRoom('dev')
  fake.rooms[0]?.peerJoin('peer-1')
  // Issue #22 — a fingerprint pinned in a previous encounter (TOFU).
  pinTofuFingerprint('peer-1', 'A31F 09BC 77D2 4E5A')

  // A changed setting and a collapsed sidebar.
  useSettingsStore.getState().setSettings({ theme: 'dark', maxActiveRooms: 6 })
  useUiStore.getState().setSidebarCollapsed(true)

  // Every documented key exists at this point.
  for (const key of PANIC_STORAGE_KEYS) {
    expect(localStorage.getItem(key)).not.toBeNull()
  }
  // Plus a stray key inside the namespace and one outside it.
  localStorage.setItem('gritos:legacy-future-key', '{"x":1}')
  localStorage.setItem('other-app:data', 'keep-me')
}

describe('panicWipe (RF-08)', () => {
  it('aborts connections, resets the stores and empties gritos:* storage', async () => {
    await seedActiveSession()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })

    panicWipe()

    // No live rooms left and the app state is pristine.
    expect(manager.getActiveRoomCount()).toBe(0)
    expect(fake.rooms[0]?.leave).toHaveBeenCalled()
    expect(fake.rooms[1]?.leave).toHaveBeenCalled()
    expect(useAppStore.getState()).toEqual(
      expect.objectContaining({
        identity: null,
        rooms: {},
        dms: {},
        recentRooms: [],
        activeView: null,
      }),
    )
    expect(useSettingsStore.getState().settings).toEqual(
      expect.objectContaining({ theme: 'system', maxActiveRooms: 4, notifications: false }),
    )
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)

    // localStorage: ONLY the foreign key survives.
    const remaining = Object.keys(localStorage)
    expect(remaining).toEqual(['other-app:data'])

    // The app reloads into the clean onboarding.
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('the reload lands the app in the first-visit state (no identity anywhere)', async () => {
    await seedActiveSession()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })

    panicWipe()

    expect(reload).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().identity).toBeNull()
    expect(manager.getSessionIdentity()).toBeNull()
    expect(localStorage.getItem(IDENTITY_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(ROOMS_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(UI_STORAGE_KEY)).toBeNull()
    // Issue #22 — the TOFU pins die with the rest of the session.
    expect(localStorage.getItem(TOFU_STORAGE_KEY)).toBeNull()
  })

  it('can skip the reload (tests drive the wipe without navigation)', async () => {
    await seedActiveSession()
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })

    panicWipe({ reload: false })

    expect(reload).not.toHaveBeenCalled()
    expect(Object.keys(localStorage)).toEqual(['other-app:data'])
  })

  it('never touches keys outside the gritos: namespace', () => {
    localStorage.setItem('other-app:data', 'keep-me')
    localStorage.setItem('gritos:identity', '{"nickname":"zorro-bravo"}')
    localStorage.setItem('gritos:settings', '{"theme":"dark"}')

    clearGritosStorage()

    expect(localStorage.getItem('other-app:data')).toBe('keep-me')
    expect(localStorage.getItem('gritos:identity')).toBeNull()
    expect(localStorage.getItem('gritos:settings')).toBeNull()
  })
})

describe('post-wipe bootstrap shape (spec §8.1 store fields)', () => {
  it('the reset store equals INITIAL_APP_STATE key for key', async () => {
    await seedActiveSession()
    vi.stubGlobal('location', { reload: vi.fn() })

    const room: Room = {
      id: 'r1',
      name: 'lobby',
      hasPassword: false,
      status: 'connected',
      peers: [],
      messages: [],
      typing: {},
      unread: 0,
      fifoTrimmed: false,
    }
    const identity: Identity = { nickname: 'x', fingerprint: 'fp', createdAt: 1 }
    useAppStore.setState({ rooms: { r1: room }, identity, activeView: { kind: 'room', id: 'r1' } })

    panicWipe()

    expect(useAppStore.getState()).toMatchObject(INITIAL_APP_STATE)
  })
})
