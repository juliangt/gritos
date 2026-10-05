import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { normalizeSettings, stripIceCredentials } from '../lib/validateSettings'
import type { Settings } from './useAppStore'

/** spec.md §8.2 — one of the only four persistent `gritos:*` keys. */
export const SETTINGS_STORAGE_KEY = 'gritos:settings'

/** Documented defaults — spec §8.1. */
export const DEFAULT_SETTINGS: Settings = {
  autoJoinLobby: true,
  trackers: [],
  iceServers: [],
  maxActiveRooms: 4,
  theme: 'system',
  notifications: false,
  rememberRooms: true,
  // Issue #30: credentials persist by default; false keeps them session-only.
  rememberTurnCredentials: true,
}

export interface SettingsStore {
  settings: Settings
  setSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
}

/**
 * Persists the raw `Settings` JSON object under `gritos:settings`
 * (spec §8.2: "Settings (JSON)") — deliberately NOT wrapped in zustand's
 * `{ state, version }` envelope, so the anti-flash script in index.html can
 * read `theme` directly. Issue #29: the stored JSON is schema-validated on
 * every load (lib/validateSettings) — unknown/missing/hostile fields fall
 * back to the defaults, which keeps old payloads forward-compatible.
 * Issue #30: TURN credentials live in the zustand store for the whole
 * session either way, so the relay config keeps working within the session;
 * when `rememberTurnCredentials` is off only the persisted JSON loses them,
 * and reloading with the toggle off requires re-entering the credentials.
 * Defensive against environments without `localStorage` (unit tests, SSR).
 */
const settingsStorage: PersistStorage<Settings> = {
  getItem: (name) => {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(name)
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      return { state: normalizeSettings(parsed, DEFAULT_SETTINGS) }
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return
    // Issue #30: with the toggle off the written JSON drops the TURN
    // `credential` fields (urls/username still persist); with it on the
    // whole Settings object is written as before.
    const state =
      value.state.rememberTurnCredentials === false
        ? { ...value.state, iceServers: stripIceCredentials(value.state.iceServers) }
        : value.state
    localStorage.setItem(name, JSON.stringify(state))
  },
  removeItem: (name) => {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(name)
  },
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),
      resetSettings: () => set({ settings: { ...DEFAULT_SETTINGS } }),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      storage: settingsStorage,
      partialize: (state) => state.settings,
      // persisted state IS the Settings object; place it back into the slice.
      merge: (persisted, current) => ({
        ...current,
        settings: { ...current.settings, ...(persisted as Partial<Settings>) },
      }),
    },
  ),
)
