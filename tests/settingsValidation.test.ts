// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MUTED_FINGERPRINTS, normalizeSettings } from '../src/lib/validateSettings'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../src/stores/useSettingsStore'

/**
 * Issue #29: the raw `gritos:settings` JSON is schema-validated on load.
 * Hostile/corrupt payloads must never reach the store — every field falls
 * back to the documented defaults (spec §8.1) — while the valid parts of a
 * mixed record survive. Covers both the pure pass and the rehydration path.
 */

/** Fresh baseline for the pure pass (normalizeSettings never mutates it). */
const FALLBACK: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS }

/** Issue #95 — a fingerprint in the 8×4 display form and its canonical form. */
const FP_DISPLAY = 'A31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678'
const FP_CANONICAL = 'A31F09BC77D24E5A51C0FFEE12345678'

/** `count` distinct canonical fingerprints, index-encoded in the low digits. */
function mutedList(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `A31F09BC77D24E5A51C0FFEE${index.toString(16).padStart(8, '0').toUpperCase()}`,
  )
}

/** Re-imports the store so it rehydrates from the current localStorage. */
async function rehydrate(): Promise<ReturnType<typeof useSettingsStore.getState>> {
  vi.resetModules()
  const { useSettingsStore: freshStore } = await import('../src/stores/useSettingsStore')
  return freshStore.getState()
}

describe('normalizeSettings (issue #29 schema validation)', () => {
  it('returns full defaults for non-object payloads', () => {
    expect(normalizeSettings(null, FALLBACK)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(42, FALLBACK)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('[]', FALLBACK)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(true, FALLBACK)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([1, 2], FALLBACK)).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps maxActiveRooms to 1–6 and defaults non-numbers', () => {
    expect(normalizeSettings({ maxActiveRooms: 1e9 }, FALLBACK)).toEqual({
      ...DEFAULT_SETTINGS,
      maxActiveRooms: 6,
    })
    expect(normalizeSettings({ maxActiveRooms: -3 }, FALLBACK).maxActiveRooms).toBe(1)
    expect(normalizeSettings({ maxActiveRooms: 3.9 }, FALLBACK).maxActiveRooms).toBe(3)
    expect(normalizeSettings({ maxActiveRooms: '3' }, FALLBACK).maxActiveRooms).toBe(4)
    expect(normalizeSettings({ maxActiveRooms: NaN }, FALLBACK).maxActiveRooms).toBe(4)
    expect(normalizeSettings({ maxActiveRooms: null }, FALLBACK).maxActiveRooms).toBe(4)
  })

  it('coerces booleans by type only', () => {
    expect(
      normalizeSettings({ autoJoinLobby: false, notifications: 1, rememberRooms: 'yes' }, FALLBACK),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      autoJoinLobby: false,
      notifications: false,
      rememberRooms: true,
    })
  })

  it('coerces rememberTurnCredentials by type only (issue #30)', () => {
    expect(normalizeSettings({ rememberTurnCredentials: false }, FALLBACK)).toEqual({
      ...DEFAULT_SETTINGS,
      rememberTurnCredentials: false,
    })
    // Only the exact `false` boolean turns it off; anything else falls back.
    expect(
      normalizeSettings({ rememberTurnCredentials: 0 }, FALLBACK).rememberTurnCredentials,
    ).toBe(true)
    expect(
      normalizeSettings({ rememberTurnCredentials: 'no' }, FALLBACK).rememberTurnCredentials,
    ).toBe(true)
    expect(normalizeSettings({}, FALLBACK).rememberTurnCredentials).toBe(true)
  })

  it('allows only the real theme enum', () => {
    expect(normalizeSettings({ theme: 'purple' }, FALLBACK).theme).toBe('system')
    expect(normalizeSettings({ theme: 42 }, FALLBACK).theme).toBe('system')
    expect(normalizeSettings({ theme: 'dark' }, FALLBACK).theme).toBe('dark')
    expect(normalizeSettings({ theme: 'light' }, FALLBACK).theme).toBe('light')
  })

  it('keeps only well-formed wss:// trackers', () => {
    expect(
      normalizeSettings(
        { trackers: ['not a url', 'http://x', 'wss://', 42, 'wss://tracker.ejemplo:443'] },
        FALLBACK,
      ).trackers,
    ).toEqual(['wss://tracker.ejemplo:443'])
    expect(normalizeSettings({ trackers: 'wss://solo' }, FALLBACK).trackers).toEqual([])
    expect(normalizeSettings({ trackers: [] }, FALLBACK).trackers).toEqual([])
  })

  it('keeps only well-formed stun:/turn:/turns: ICE entries', () => {
    const { iceServers } = normalizeSettings(
      {
        iceServers: [
          42,
          null,
          {},
          { urls: 'http://bad.example' },
          { urls: 'stun:' },
          { urls: ['stun:one.example:19302', 'turn:two.example:3478'] },
          { urls: ['stun:ok.example', 42] },
          { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
          { urls: 'turn:creds.example', username: 5, credential: 'kept' },
          { urls: 'turns://secure.example:5349', injected: 'junk' },
          { urls: [] },
        ],
      },
      FALLBACK,
    )
    expect(iceServers).toEqual([
      { urls: ['stun:one.example:19302', 'turn:two.example:3478'] },
      { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
      // Non-string username dropped; the rest of the entry survives.
      { urls: 'turn:creds.example', credential: 'kept' },
      // Unknown keys inside an entry are dropped.
      { urls: 'turns://secure.example:5349' },
    ])
  })

  it('keeps TURN credentials on load while rememberTurnCredentials is on (issue #30)', () => {
    const { iceServers, rememberTurnCredentials } = normalizeSettings(
      {
        rememberTurnCredentials: true,
        iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
      },
      FALLBACK,
    )
    expect(rememberTurnCredentials).toBe(true)
    expect(iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
    ])
  })

  it('drops TURN credentials on load when rememberTurnCredentials is false (issue #30)', () => {
    const { iceServers } = normalizeSettings(
      {
        rememberTurnCredentials: false,
        iceServers: [
          { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
          { urls: 'stun:stun.example:19302' },
        ],
      },
      FALLBACK,
    )
    // urls/username survive; only the credential is gone.
    expect(iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'ana' },
      { urls: 'stun:stun.example:19302' },
    ])
  })

  it('keeps the valid parts of a mixed record and drops the rest', () => {
    expect(
      normalizeSettings(
        { maxActiveRooms: 99, theme: 'dark', notifications: 'yes', trackers: ['wss://ok.ejemplo'] },
        FALLBACK,
      ),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      maxActiveRooms: 6,
      theme: 'dark',
      trackers: ['wss://ok.ejemplo'],
    })
  })

  it('drops unknown keys instead of merging them into state', () => {
    const stored: unknown = JSON.parse(
      '{"theme":"dark","__proto__":{"hacked":true},"evil":"wss://x"}',
    )
    const result = normalizeSettings(stored, FALLBACK)
    expect(result).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    expect(Object.keys(result)).toEqual(Object.keys(DEFAULT_SETTINGS))
  })

  it('roundtrips a valid full record unchanged', () => {
    const valid: typeof DEFAULT_SETTINGS = {
      autoJoinLobby: false,
      trackers: ['wss://tracker.ejemplo:443'],
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
      maxActiveRooms: 2,
      theme: 'light',
      notifications: true,
      rememberRooms: false,
      rememberTurnCredentials: true,
      mutedFingerprints: [FP_CANONICAL],
    }
    expect(normalizeSettings(valid, FALLBACK)).toEqual(valid)
  })
})

describe('normalizeSettings mute list (issue #95)', () => {
  it('accepts a valid list and stores it in canonical form', () => {
    // Spaced 8×4 display form and lowercase compact form both canonicalize.
    expect(
      normalizeSettings(
        { mutedFingerprints: [FP_DISPLAY, 'bbbb cccc dddd eeee ffff 0000 1111 2222'] },
        FALLBACK,
      ).mutedFingerprints,
    ).toEqual([FP_CANONICAL, 'BBBBCCCCDDDDEEEEFFFF000011112222'])
  })

  it('drops malformed entries and keeps the well-formed ones', () => {
    const { mutedFingerprints } = normalizeSettings(
      {
        mutedFingerprints: [
          FP_DISPLAY, // the only well-formed one
          'A31F 09BC 77D2 4E5A', // wrong length: 16 hex chars
          `${FP_CANONICAL}ABCD`, // wrong length: 36 hex chars
          'G31F 09BC 77D2 4E5A 51C0 FFEE 1234 5678', // non-hex
          'A31F-09BC-77D2-4E5A-51C0-FFEE-1234-5678', // wrong separator
          '', // empty
          42, // non-string entries
          null,
          {},
        ],
      },
      FALLBACK,
    )
    expect(mutedFingerprints).toEqual([FP_CANONICAL])
  })

  it('falls back to [] for non-array payloads', () => {
    expect(
      normalizeSettings({ mutedFingerprints: FP_CANONICAL }, FALLBACK).mutedFingerprints,
    ).toEqual([])
    expect(normalizeSettings({ mutedFingerprints: 42 }, FALLBACK).mutedFingerprints).toEqual([])
    expect(normalizeSettings({}, FALLBACK).mutedFingerprints).toEqual([])
  })

  it('deduplicates entries that canonicalize to the same fingerprint', () => {
    expect(
      normalizeSettings(
        { mutedFingerprints: [FP_DISPLAY, FP_CANONICAL, FP_CANONICAL.toLowerCase()] },
        FALLBACK,
      ).mutedFingerprints,
    ).toEqual([FP_CANONICAL])
  })

  it('accepts exactly MAX_MUTED_FINGERPRINTS entries', () => {
    const full = mutedList(MAX_MUTED_FINGERPRINTS)
    expect(normalizeSettings({ mutedFingerprints: full }, FALLBACK).mutedFingerprints).toEqual(full)
  })

  it('rejects a list over the cap wholesale instead of truncating', () => {
    const over = mutedList(MAX_MUTED_FINGERPRINTS + 1)
    expect(normalizeSettings({ mutedFingerprints: over }, FALLBACK).mutedFingerprints).toEqual([])
  })
})

describe('settings rehydration falls back to safe defaults (issue #29)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to full defaults on corrupt JSON', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json')
    expect((await rehydrate()).settings).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to full defaults on valid JSON with the wrong shape', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '42')
    expect((await rehydrate()).settings).toEqual(DEFAULT_SETTINGS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, '"[]"')
    expect((await rehydrate()).settings).toEqual(DEFAULT_SETTINGS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, '[]')
    expect((await rehydrate()).settings).toEqual(DEFAULT_SETTINGS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, 'null')
    expect((await rehydrate()).settings).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps hostile numbers and drops junk lists and keys on load', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        maxActiveRooms: 1e9,
        theme: 'purple',
        trackers: ['not a url', 'http://x', 42, 'wss://ok.ejemplo'],
        iceServers: [{ urls: 'javascript:alert(1)' }, { urls: 'stun:real.example' }],
        hackerField: true,
      }),
    )
    const { settings } = await rehydrate()
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      maxActiveRooms: 6,
      trackers: ['wss://ok.ejemplo'],
      iceServers: [{ urls: 'stun:real.example' }],
    })
    expect(settings).not.toHaveProperty('hackerField')
  })

  it('loads a valid record as-is', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        autoJoinLobby: false,
        trackers: ['wss://tracker.ejemplo:443'],
        iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
        maxActiveRooms: 5,
        theme: 'dark',
        notifications: true,
        rememberRooms: false,
      }),
    )
    const { settings } = await rehydrate()
    expect(settings.autoJoinLobby).toBe(false)
    expect(settings.trackers).toEqual(['wss://tracker.ejemplo:443'])
    expect(settings.iceServers).toEqual([
      { urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' },
    ])
    expect(settings.maxActiveRooms).toBe(5)
    expect(settings.theme).toBe('dark')
    expect(settings.notifications).toBe(true)
    expect(settings.rememberRooms).toBe(false)
  })

  it('strips stale stored TURN credentials when remembering is off (issue #30)', async () => {
    // A record written before the toggle existed (or by hand) still honors
    // the toggle on load: credentials never reach the rehydrated state.
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        rememberTurnCredentials: false,
        iceServers: [{ urls: 'turn:turn.example:3478', username: 'ana', credential: 'secreta' }],
      }),
    )
    const { settings } = await rehydrate()
    expect(settings.rememberTurnCredentials).toBe(false)
    expect(settings.iceServers).toEqual([{ urls: 'turn:turn.example:3478', username: 'ana' }])
  })

  it('loads a persisted mute list and drops corrupt entries on the way in (issue #95)', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mutedFingerprints: [FP_DISPLAY, 'A31F 09BC 77D2 4E5A', 'not-a-fingerprint', 42],
      }),
    )
    const { settings } = await rehydrate()
    expect(settings.mutedFingerprints).toEqual([FP_CANONICAL])
  })

  it('rejects an over-cap persisted mute list wholesale (issue #95)', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ mutedFingerprints: mutedList(MAX_MUTED_FINGERPRINTS + 1) }),
    )
    const { settings } = await rehydrate()
    expect(settings.mutedFingerprints).toEqual([])
  })
})
