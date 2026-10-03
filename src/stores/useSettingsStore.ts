import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
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
 * read `theme` directly. Unknown/missing fields fall back to the defaults,
 * which keeps old payloads forward-compatible. Defensive against
 * environments without `localStorage` (unit tests, potential SSR).
 */
const settingsStorage: PersistStorage<Settings> = {
  getItem: (name) => {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(name)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<Settings>
      return { state: { ...DEFAULT_SETTINGS, ...parsed } }
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(name, JSON.stringify(value.state))
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
