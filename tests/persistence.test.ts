// @vitest-environment jsdom
import './dom-setup'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_STORAGE_KEY, loadIdentity, persistIdentity } from '../src/lib/crypto/identity'
import {
  loadRecentRooms,
  pushRecentRoom,
  RECENT_ROOMS_CAP,
  ROOMS_STORAGE_KEY,
  saveRecentRooms,
} from '../src/lib/recentRooms'
import { DEFAULT_UI, UI_STORAGE_KEY, useUiStore } from '../src/stores/useUiStore'

beforeEach(() => {
  localStorage.clear()
})

describe('identity persistence — M2 profile (§8.2, RF-01)', () => {
  it('writes the raw profile JSON under gritos:identity', () => {
    persistIdentity({
      nickname: 'zorro-bravo',
      fingerprint: 'A31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })
    const raw = localStorage.getItem(IDENTITY_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    expect(parsed).toMatchObject({
      nickname: 'zorro-bravo',
      fingerprint: 'A31F 09BC 77D2 4E5A',
      createdAt: 1_700_000_000_000,
    })
  })

  it('roundtrips through loadIdentity', () => {
    expect(loadIdentity()).toBeNull() // first visit
    persistIdentity({
      nickname: 'luna-cauta',
      fingerprint: 'ABCD EF01 2345 6789',
      createdAt: 1,
      pubJwk: { kty: 'EC' },
    })
    expect(loadIdentity()).toEqual({
      nickname: 'luna-cauta',
      fingerprint: 'ABCD EF01 2345 6789',
      createdAt: 1,
      pubJwk: { kty: 'EC' },
      privJwk: undefined,
    })
  })

  it('rejects corrupted or incomplete payloads', () => {
    localStorage.setItem(IDENTITY_STORAGE_KEY, '{not json')
    expect(loadIdentity()).toBeNull()

    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ nickname: 'x' }))
    expect(loadIdentity()).toBeNull()

    localStorage.setItem(IDENTITY_STORAGE_KEY, 'null')
    expect(loadIdentity()).toBeNull()
  })
})

describe('recent rooms persistence (§8.2 gritos:rooms)', () => {
  it('pushes most-recent-first, deduped, capped at 10', () => {
    let list: string[] = []
    for (let i = 1; i <= 12; i += 1) list = pushRecentRoom(list, `sala-${i}`)
    expect(list[0]).toBe('sala-12')
    expect(list).toHaveLength(RECENT_ROOMS_CAP)
    expect(list).not.toContain('sala-1')

    list = pushRecentRoom(list, 'sala-5')
    expect(list[0]).toBe('sala-5')
    expect(list.filter((name) => name === 'sala-5')).toHaveLength(1)
  })

  it('stores and loads the {recent} envelope', () => {
    expect(loadRecentRooms()).toEqual([])
    saveRecentRooms(['dev', 'lobby'])
    expect(JSON.parse(localStorage.getItem(ROOMS_STORAGE_KEY) as string)).toEqual({
      recent: ['dev', 'lobby'],
    })
    expect(loadRecentRooms()).toEqual(['dev', 'lobby'])
  })

  it('survives corrupted payloads', () => {
    localStorage.setItem(ROOMS_STORAGE_KEY, 'nope')
    expect(loadRecentRooms()).toEqual([])
    localStorage.setItem(ROOMS_STORAGE_KEY, JSON.stringify({ recent: [1, 'ok', null] }))
    expect(loadRecentRooms()).toEqual(['ok'])
  })
})

describe('UI state persistence (§8.2 gritos:ui)', () => {
  it('starts expanded by default', () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    expect(DEFAULT_UI).toEqual({ sidebarCollapsed: false })
  })

  it('persists the collapsed flag and rehydrates it', async () => {
    useUiStore.getState().toggleSidebar()
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    expect(JSON.parse(localStorage.getItem(UI_STORAGE_KEY) as string)).toEqual({
      sidebarCollapsed: true,
    })

    vi.resetModules()
    const { useUiStore: fresh } = await import('../src/stores/useUiStore')
    expect(fresh.getState().sidebarCollapsed).toBe(true)

    // Back to expanded for other suites sharing this module instance.
    fresh.getState().toggleSidebar()
  })
})
