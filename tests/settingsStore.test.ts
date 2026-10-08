import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  getMutedNickname,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../src/stores/useSettingsStore'

/** Issue #95 — a fingerprint in the 8×4 display form and its canonical form. */
const FP_DISPLAY = 'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678'
const FP_CANONICAL = 'A31F09BC77D24E5A51C0FFEE12345678'
const FP_OTHER = 'BBBBCCCCDDDDEEEEFFFF000011112222'

/** `count` distinct canonical fingerprints, index-encoded in the low digits. */
function fingerprintAt(index: number): string {
  return `A31F09BC77D24E5A51C0FFEE${index.toString(16).padStart(8, '0').toUpperCase()}`
}

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
      rememberTurnCredentials: true,
      mutedFingerprints: [],
      // Issue #102 — history gossip is strictly opt-in: the default is
      // silence.
      shareHistory: false,
      // Issue #105 (spec §12.5) — the global DM signaling channel is
      // strictly opt-in: the default is off, the swarm never joins silently.
      globalDm: false,
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

describe('mute list helpers (issue #95)', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetSettings()
  })

  it('defaults to an empty mute list', () => {
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
  })

  it('muteFingerprint stores the canonical form and records the nickname', () => {
    expect(useSettingsStore.getState().muteFingerprint(FP_DISPLAY, 'abuso')).toBe(true)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([FP_CANONICAL])
    // The memory-only map answers for either form of the fingerprint.
    expect(getMutedNickname(FP_DISPLAY)).toBe('abuso')
    expect(getMutedNickname(FP_CANONICAL)).toBe('abuso')
    expect(useSettingsStore.getState().muteFingerprint(FP_OTHER, 'troll')).toBe(true)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([FP_CANONICAL, FP_OTHER])
    expect(getMutedNickname(FP_OTHER)).toBe('troll')
  })

  it('muteFingerprint is idempotent and refreshes the last-seen nickname', () => {
    const store = useSettingsStore.getState()
    expect(store.muteFingerprint(FP_DISPLAY, 'abuso')).toBe(true)
    expect(store.muteFingerprint(FP_DISPLAY, 'abuso-renamed')).toBe(true)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([FP_CANONICAL])
    expect(getMutedNickname(FP_CANONICAL)).toBe('abuso-renamed')
  })

  it('refuses malformed fingerprints without touching the list', () => {
    const store = useSettingsStore.getState()
    for (const bad of [
      'A31F 09BC 77D2 4E5A', // too short
      `${FP_CANONICAL}ABCD`, // too long
      'G31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678', // non-hex
      '',
    ]) {
      expect(store.muteFingerprint(bad, 'x')).toBe(false)
    }
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
  })

  it('unmuteFingerprint removes the entry and its nickname', () => {
    const store = useSettingsStore.getState()
    store.muteFingerprint(FP_DISPLAY, 'abuso')
    expect(store.unmuteFingerprint(FP_DISPLAY)).toBe(true)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
    expect(getMutedNickname(FP_CANONICAL)).toBeNull()
    // Unmuting again (or an unknown fingerprint) reports nothing removed.
    expect(store.unmuteFingerprint(FP_DISPLAY)).toBe(false)
    expect(store.unmuteFingerprint('nope')).toBe(false)
  })

  it('refuses the 101st entry without evicting earlier mutes', () => {
    const store = useSettingsStore.getState()
    for (let index = 0; index < 100; index += 1) {
      expect(store.muteFingerprint(fingerprintAt(index), `nick-${index}`)).toBe(true)
    }
    // The cap refuses the newcomer: the list is untouched, nothing evicted.
    expect(store.muteFingerprint(FP_DISPLAY, 'abuso')).toBe(false)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toHaveLength(100)
    expect(useSettingsStore.getState().settings.mutedFingerprints[0]).toBe(fingerprintAt(0))
    // After an explicit unmute there is room again.
    expect(store.unmuteFingerprint(fingerprintAt(0))).toBe(true)
    expect(store.muteFingerprint(FP_DISPLAY, 'abuso')).toBe(true)
    expect(useSettingsStore.getState().settings.mutedFingerprints).toHaveLength(100)
  })

  it('resetSettings clears the mute list and the nickname cache', () => {
    const store = useSettingsStore.getState()
    store.muteFingerprint(FP_DISPLAY, 'abuso')
    store.resetSettings()
    expect(useSettingsStore.getState().settings.mutedFingerprints).toEqual([])
    expect(getMutedNickname(FP_CANONICAL)).toBeNull()
  })
})
