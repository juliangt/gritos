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
import { resetKeyVaultForTests, wipeKeyVault, wrapPrivateKey } from '../src/lib/crypto/keyVault'
import { installFakeIndexedDB } from './fakeIndexedDB'
import { ROOMS_STORAGE_KEY } from '../src/lib/recentRooms'
import { pinTofuFingerprint, TOFU_STORAGE_KEY } from '../src/lib/tofu'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { UI_STORAGE_KEY, useUiStore } from '../src/stores/useUiStore'
import { INITIAL_APP_STATE, useAppStore, type Identity, type Room } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * RF-08 — panic wipe: every WebRTC connection aborted, the FIVE documented
 * `gritos:*` keys (spec §8.2) removed (plus stray `gritos:*` defensively),
 * the IndexedDB key vault cleared (issue #24), in-memory stores reset, and
 * the app reloads. Keys outside the app namespace are never touched.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  resetKeyVaultForTests()
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  resetKeyVaultForTests()
  vi.unstubAllGlobals()
  localStorage.clear()
})

async function seedActiveSession(): Promise<void> {
  // A real post-onboarding session: the identity was persisted with its JWKs.
  const session = await createSessionIdentity('zorro-bravo')
  const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
  await persistIdentity({
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

  it('the wipe clears the persisted mute list riding in gritos:settings (issue #95)', async () => {
    await seedActiveSession()
    const store = useSettingsStore.getState()
    expect(store.muteFingerprint('A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678', 'molesto')).toBe(true)
    expect(store.muteFingerprint('BBBB CCCC DDDD EEEE FFFF 0000 1111 2222', 'troll')).toBe(true)
    // No sixth key: the mute list rides inside the settings record.
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string)).toMatchObject({
      mutedFingerprints: ['A31F09BC77D24E5A51C0FFEE12345678', 'BBBBCCCCDDDDEEEEFFFF000011112222'],
    })

    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    panicWipe({ reload: false })

    // Back to the documented defaults, in memory and on disk.
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull()
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

describe('IndexedDB key vault wipe (RF-08, issue #24)', () => {
  it('never throws where IndexedDB does not exist (plain jsdom)', async () => {
    // jsdom ships no indexedDB: the vault wipe is a silent no-op and the
    // panic flow (which calls it fire-and-forget) keeps working — the
    // panicWipe suites above run in exactly this environment.
    await expect(wipeKeyVault()).resolves.toBeUndefined()
  })

  it('panicWipe clears the wrapping key along with the localStorage keys', async () => {
    const fakeDb = installFakeIndexedDB()
    // Seed a wrapping key + envelope through the vault itself.
    await wrapPrivateKey('{"kty":"EC","d":"secret"}')
    expect(fakeDb.databases.get('gritos')?.get('keys')?.has('identity-wrap')).toBe(true)
    await seedActiveSession()
    vi.stubGlobal('location', { reload: vi.fn() })

    panicWipe()

    // The vault wipe is fire-and-forget: wait for the async tail to land.
    await vi.waitFor(() => {
      expect(fakeDb.databases.get('gritos')?.get('keys')?.size ?? 0).toBe(0)
    })
    expect(Object.keys(localStorage)).toEqual(['other-app:data'])
  })

  it('wipeKeyVault clears the vault without a full panic', async () => {
    const fakeDb = installFakeIndexedDB()
    await wrapPrivateKey('{"kty":"EC","d":"secret"}')
    expect(fakeDb.databases.get('gritos')?.get('keys')?.size).toBe(1)

    await wipeKeyVault()

    expect(fakeDb.databases.get('gritos')?.get('keys')?.size).toBe(0)
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
