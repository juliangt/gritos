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
import { resetKeyVaultForTests } from '../src/lib/crypto/keyVault'
import { installFakeIndexedDB } from './fakeIndexedDB'
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
 * key material may ever appear under other keys. Since issue #24 the
 * identity record itself carries no plaintext private material: the
 * private JWK is an AES-GCM-wrapped envelope (`priv`), its wrapping key
 * living in IndexedDB (also panic-wiped).
 */

let fake: ReturnType<typeof installFakeTrystero>

beforeEach(() => {
  localStorage.clear()
  resetKeyVaultForTests()
  installFakeIndexedDB()
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.getState().resetSettings()
  useUiStore.setState({ sidebarCollapsed: false })
  fake = installFakeTrystero()
})

afterEach(() => {
  manager.resetManagerForTests()
  manager.setJoinRoomFactory(null)
  resetKeyVaultForTests()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function gritosKeys(): string[] {
  return Object.keys(localStorage).filter((key) => key.startsWith('gritos:'))
}

describe('spec §8.2 — only the documented gritos:* keys', () => {
  it('a full settings + identity + rooms + ui + tofu session leaves exactly the five keys', async () => {
    // A real post-onboarding identity (keypair persisted once, wrapped).
    const session = await createSessionIdentity('zorro-bravo')
    const { pubJwk, privJwk } = await exportIdentityJwks(session.keypair)
    await persistIdentity({
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

    // Settings + UI changes through the stores. Issue #102 — the
    // history-gossip consent rides inside `gritos:settings` too: setting it
    // must not create a sixth `gritos:*` key either.
    useSettingsStore.getState().setSettings({
      theme: 'dark',
      trackers: ['wss://tracker.example'],
      maxActiveRooms: 6,
      notifications: true,
      rememberRooms: false,
      shareHistory: true,
    })
    useUiStore.getState().setSidebarCollapsed(true)
    // Issue #95 — the mute list rides inside `gritos:settings`: muting a
    // peer must not create a sixth `gritos:*` key.
    useSettingsStore
      .getState()
      .muteFingerprint('A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678', 'molesto')

    expect(gritosKeys().sort()).toEqual(
      [
        SETTINGS_STORAGE_KEY,
        IDENTITY_STORAGE_KEY,
        ROOMS_STORAGE_KEY,
        UI_STORAGE_KEY,
        TOFU_STORAGE_KEY,
      ].sort(),
    )
    // The mute list persists in canonical form inside the settings record,
    // and so does the history-gossip consent (issue #102).
    const settings = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as Record<
      string,
      unknown
    >
    expect(settings.mutedFingerprints).toEqual(['A31F09BC77D24E5A51C0FFEE12345678'])
    expect(settings.shareHistory).toBe(true)

    // Key contents stay within the documented shapes — the room password
    // surface is empty for public rooms and no message text is persisted.
    const rooms = JSON.parse(localStorage.getItem(ROOMS_STORAGE_KEY) as string) as {
      recent: string[]
    }
    expect(rooms.recent).toEqual(['dev', 'lobby'])
    const identityRaw = localStorage.getItem(IDENTITY_STORAGE_KEY) as string
    const identity = JSON.parse(identityRaw) as Record<string, unknown>
    expect(Object.keys(identity).sort()).toEqual(
      ['createdAt', 'fingerprint', 'nickname', 'priv', 'pubJwk'].sort(),
    )
    // Issue #24 — the private key is not greppable in the stored JSON.
    expect(identityRaw).not.toContain('"privJwk"')
    expect(identityRaw).not.toContain(privJwk.d as string)
    expect(JSON.parse(identity.priv as string)).toMatchObject({ v: 1 })
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
    await persistIdentity({
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

// ---------------------------------------------------------------------------
// Issue #31 — password-room names never persist: a password join purges an
// entry recorded earlier with that name (older builds / public join), never
// creates `gritos:rooms` when absent, and a public join of the same name
// still records it.
// ---------------------------------------------------------------------------

describe('issue #31 — password-room names never persist', () => {
  it('a password join purges a pre-existing gritos:rooms entry with that name', async () => {
    localStorage.setItem(ROOMS_STORAGE_KEY, JSON.stringify({ recent: ['secreta', 'lobby'] }))
    await manager.joinRoom('secreta', 'clave-secreta')

    expect(JSON.parse(localStorage.getItem(ROOMS_STORAGE_KEY) as string)).toEqual({
      recent: ['lobby'],
    })
    // Nothing about the password join itself leaked into storage: the
    // settings/ui records above come from the store resets, not the join.
  })

  it('a password join never creates gritos:rooms when nothing is stored', async () => {
    await manager.joinRoom('secreta', 'clave-secreta')

    expect(localStorage.getItem(ROOMS_STORAGE_KEY)).toBeNull()
  })

  it('joining the same name without a password still records it', async () => {
    await manager.joinRoom('secreta')

    expect(JSON.parse(localStorage.getItem(ROOMS_STORAGE_KEY) as string)).toEqual({
      recent: ['secreta'],
    })
  })
})
