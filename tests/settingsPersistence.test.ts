// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../src/stores/useSettingsStore'

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
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', maxActiveRooms: 6 }),
    )

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import(
      '../src/stores/useSettingsStore'
    )

    expect(freshStore.getState().settings.theme).toBe('dark')
    expect(freshStore.getState().settings.maxActiveRooms).toBe(6)
  })

  it('fills unknown or missing fields with the defaults on rehydration', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: 'dark' }))

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import(
      '../src/stores/useSettingsStore'
    )

    expect(freshStore.getState().settings.theme).toBe('dark')
    expect(freshStore.getState().settings.autoJoinLobby).toBe(true)
    expect(freshStore.getState().settings.rememberRooms).toBe(true)
  })

  it('survives malformed payloads without throwing', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json')

    vi.resetModules()
    const { useSettingsStore: freshStore } = await import(
      '../src/stores/useSettingsStore'
    )

    expect(freshStore.getState().settings).toEqual(
      expect.objectContaining({ theme: 'system', maxActiveRooms: 4 }),
    )
  })
})
