import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../src/stores/useSettingsStore'

describe('settings store defaults (spec §8.1)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings()
  })

  it('starts with the documented defaults', () => {
    expect(useSettingsStore.getState().settings).toEqual({
      autoJoinLobby: true,
      trackers: [],
      iceServers: [],
      maxActiveRooms: 4,
      theme: 'system',
      notifications: false,
      rememberRooms: true,
    })
  })

  it('keeps DEFAULT_SETTINGS in sync with the initial state', () => {
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS)
  })

  it('uses the spec §8.2 storage key', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('gritos:settings')
  })

  it('applies partial updates immutably', () => {
    const before = useSettingsStore.getState().settings
    useSettingsStore.getState().setSettings({ theme: 'dark' })
    const after = useSettingsStore.getState().settings
    expect(after.theme).toBe('dark')
    expect(before.theme).toBe('system')
    expect(after).not.toBe(before)
  })

  it('restores the defaults on resetSettings', () => {
    useSettingsStore.getState().setSettings({ maxActiveRooms: 6, theme: 'light' })
    useSettingsStore.getState().resetSettings()
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS)
  })
})
