// @vitest-environment jsdom
import './dom-setup'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as manager from '../src/lib/p2p/roomManager'
import { panicWipe } from '../src/lib/panic'
import {
  createSessionIdentity,
  exportIdentityJwks,
  exportRawPublicKey,
  generateSessionKeypair,
  IDENTITY_STORAGE_KEY,
  persistIdentity,
} from '../src/lib/crypto/identity'
import { ROOMS_STORAGE_KEY } from '../src/lib/recentRooms'
import { TOFU_STORAGE_KEY } from '../src/lib/tofu'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'
import { UI_STORAGE_KEY, useUiStore } from '../src/stores/useUiStore'
import { useAppStore, INITIAL_APP_STATE } from '../src/stores/useAppStore'
import { installFakeTrystero } from './fakeTrystero'

/**
 * Spec §8.2 invariant: `localStorage` is the ONLY persistence of v1 and it
 * holds EXACTLY the documented `gritos:*` keys — settings, identity, rooms
 * (names only), ui and the TOFU pins (issue #22: first-seen fingerprints,
 * public values only). Exercised after a full settings/identity/rooms/ui
 * workout and again through the panic wipe; no message content, password or
 * key material may ever appear under other keys.
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  useUiStore.setState({ sidebarCollapsed: false })
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  localStorage.clear()
})

function gritosKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith('gritos:'))
}

describe('spec §8.2 — only the documented gritos:* keys', () => {
  it('a full settings + identity + rooms + ui + tofu session leaves exactly the five keys', async () => {
    // A real post-onboarding identity (JWK pair persisted once).
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })

    // Rooms: joins record recents, nickname change re-persists identity.
    await manager.joinRoom('lobby')
    await manager.joinRoom('dev')
    fake.rooms[0].peerJoin('peer-1')
    // Issue #22 — a received `keys` action pins the peer's fingerprint
    // (public value only) under `gritos:tofu`.
    const peerKeypair = await generateSessionKeypair()
    fake.rooms[0].receive('keys', await exportRawPublicKey(peerKeypair.publicKey), 'peer-1')
    // The pin happens on the async computeFingerprint tail.
    await new Promise((resolve) => setTimeout(resolve, 60))
    manager.setNickname('luna-cauta')

    // Settings + UI changes through the stores.
    useSettingsStore.getState().setSettings({
      theme: 'dark',
      trackers: ['wss://tracker.example'],
      maxActiveRooms: 6,
      notifications: true,
      rememberRooms: false,
    })
    useUiStore.getState().setSidebarCollapsed(true)

    expect(gritosKeys().sort()).toEqual(
      [
        SETTINGS_STORAGE_KEY,
        IDENTITY_STORAGE_KEY,
        ROOMS_STORAGE_KEY,
        UI_STORAGE_KEY,
        TOFU_STORAGE_KEY,
      ].sort(),
    )

    // Key contents stay within the documented shapes — the room password
    // surface is empty for public rooms and no message text is persisted.
    const rooms = JSON.parse(localStorage.getItem(ROOMS_STORAGE_KEY) as string) as {
      recent: string[]
    }
    expect(rooms.recent).toEqual(['dev', 'lobby'])
    const identity = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) as string) as Record<
      string,
      unknown
    >
    expect(Object.keys(identity).sort()).toEqual(
      ['createdAt', 'fingerprint', 'nickname', 'privJwk', 'pubJwk'].sort(),
    )
    // TOFU: a flat {peerId: fingerprint} map — fingerprints are public.
    const tofu = JSON.parse(localStorage.getItem(TOFU_STORAGE_KEY) as string) as Record<
      string,
      unknown
    >
    expect(Object.keys(tofu)).toEqual(['peer-1'])
    expect(typeof tofu['peer-1']).toBe('string')
  })

  it('even panic leaves no gritos:* keys behind (and nothing else appears)', async () => {
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: session.identity.fingerprint,
      createdAt: session.identity.createdAt,
      pubJwk,
      privJwk,
    })
    await manager.joinRoom('lobby')
    useSettingsStore.getState().setSettings({ theme: 'dark' })
    useUiStore.getState().setSidebarCollapsed(true)
    localStorage.setItem('other-app:data', 'keep-me')

    vi.stubGlobal('location', { reload: vi.fn() })
    panicWipe()

    expect(gritosKeys()).toEqual([])
    expect(Object.keys(localStorage)).toEqual(['other-app:data'])
    expect(useAppStore.getState().identity).toBeNull()
  })
})
