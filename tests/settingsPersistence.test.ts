// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'

describe('settings persistence (spec §8.2)', () => {
  beforeEach(() => {
    localStorage.clear()
    useSettingsStore.getState().resetSettings()
  })

  it('writes the raw Settings JSON under gritos:settings', () => {
    useSettingsStore.getState().setSettings({ theme: 'dark' })

    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as Record<string, unknown>
    // Raw Settings object — NOT wrapped in zustand's { state, version }.
    expect(parsed.theme).toBe('dark')
    expect(parsed.autoJoinLobby).toBe(true)
    expect(parsed).not.toHaveProperty('state')
    expect(parsed).not.toHaveProperty('version')
  })

  it('rehydrates persisted values on store creation', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark', maxActiveRooms: 6 }))

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import('../src/stores/useSettingsStore')

    expect(freshStore.getState().settings.theme).toBe('dark')
    expect(freshStore.getState().settings.maxActiveRooms).toBe(6)
  })

  it('fills unknown or missing fields with the defaults on rehydration', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' }))

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import('../src/stores/useSettingsStore')

    expect(freshStore.getState().settings.theme).toBe('dark')
    expect(freshStore.getState().settings.autoJoinLobby).toBe(true)
    expect(freshStore.getState().settings.rememberRooms).toBe(true)
  })

  it('survives malformed payloads without throwing', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json')

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import('../src/stores/useSettingsStore')

    expect(freshStore.getState().settings).toEqual(
      expect.objectContaining({ theme: 'system', maxActiveRooms: 4 }),
    )
  })

  it('keeps TURN credentials in gritos:settings while rememberTurnCredentials is on (issue #30)', () => {
    useSettingsStore.getState().setSettings({
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
    })

    const parsed = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as {
      rememberTurnCredentials: boolean
      iceServers: Array<Record<string, unknown>>
    }
    expect(parsed.rememberTurnCredentials).toBe(true)
    expect(parsed.iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
    ])
  })

  it('strips TURN credentials from gritos:settings while rememberTurnCredentials is off (issue #30)', () => {
    useSettingsStore.getState().setSettings({
      rememberTurnCredentials: false,
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
    })

    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY) as string
    const parsed = JSON.parse(raw) as {
      rememberTurnCredentials: boolean
      iceServers: Array<Record<string, unknown>>
    }
    // urls/username still persist; no credential field survives anywhere.
    expect(parsed.rememberTurnCredentials).toBe(false)
    expect(parsed.iceServers).toEqual([{ urls: 'turn:turn.example:3478', username: 'ana' }])
    expect(raw).not.toContain('"credential"')
    // The session store keeps the credential so the relay config keeps
    // working; only the persisted JSON lost it.
    expect(useSettingsStore.getState().settings.iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
    ])
  })

  it('rewrites stored settings without credentials when the toggle turns off (issue #30)', () => {
    useSettingsStore.getState().setSettings({
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
    })
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toContain('"credential"')

    useSettingsStore.getState().setSettings({ rememberTurnCredentials: false })
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY) as string
    expect(raw).not.toContain('"credential"')
  })

  it('persists and rehydrates the history-gossip consent flag (issue #102)', async () => {
    // Off by default; the persisted record carries the field either way
    // (it rides `gritos:settings` — no sixth `gritos:*` key).
    expect(useSettingsStore.getState().settings.shareHistory).toBe(false)
    expect(
      (
        JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as {
          shareHistory: boolean
        }
      ).shareHistory,
    ).toBe(false)

    useSettingsStore.getState().setSettings({ shareHistory: true })
    expect(
      (
        JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as {
          shareHistory: boolean
        }
      ).shareHistory,
    ).toBe(true)

    // A reload restores the consent.
    vi.resetModules()
    const { useSettingsStore: freshStore } = await import('../src/stores/useSettingsStore')
    expect(freshStore.getState().settings.shareHistory).toBe(true)
  })
})
