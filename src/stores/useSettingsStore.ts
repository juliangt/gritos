import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { canonicalFingerprint } from '../lib/crypto/dm'
import {
  isValidFingerprint,
  MAX_MUTED_FINGERPRINTS,
  normalizeSettings,
  stripIceCredentials,
} from '../lib/validateSettings'
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
  // Issue #95: the mute list persists inside this same record (spec §8.2,
  // no sixth `gritos:*` key) and is therefore wiped by the panic button.
  mutedFingerprints: [],
  // Issue #102: history gossip is strictly opt-in — the default is silence;
  // only an explicit peer request can ever pull history, and only while
  // this consent flag is on.
  shareHistory: false,
  // Issue #105 (spec §12.5): the global DM signaling channel is strictly
  // opt-in — joining the well-known swarm exposes IP, fingerprint and
  // nickname to every opt-in peer, so the default is OFF and leaving wipes
  // every piece of signal-swarm state.
  globalDm: false,
  // Issue #119: 'auto' follows the browser language (Spanish for es*,
  // English otherwise); the i18n runtime resolves it on boot and on change.
  language: 'auto',
}

export interface SettingsStore {
  settings: Settings
  setSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  /**
   * Issue #95 — mutes a peer by fingerprint. Idempotent (re-muting only
   * refreshes the last-seen nickname); refuses — returns false, list
   * untouched — on a malformed fingerprint or a full list.
   */
  muteFingerprint: (fingerprint: string, nickname: string) => boolean
  /** Issue #95 — removes a mute; true only when something was removed. */
  unmuteFingerprint: (fingerprint: string) => boolean
}

/**
 * Issue #95 — fingerprint (canonical) → last-seen nickname, MEMORY ONLY:
 * spec §8.2 persists the fingerprints alone, never nicknames. The settings
 * list reads it to display names (Phase 3); entries are inert once the
 * matching fingerprint is no longer muted and die with the session.
 */
const mutedNicknames = new Map<string, string>()

/** The last-seen nickname of a muted fingerprint, or null when unknown. */
export function getMutedNickname(fingerprint: string): string | null {
  return mutedNicknames.get(canonicalFingerprint(fingerprint)) ?? null
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
    (set, get) => ({
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (partial) => set((state) => ({ settings: { ...state.settings, ...partial } })),
      // Issue #95: dropping every mute also drops the display cache, so a
      // reset cannot leave stale nicknames for fingerprints it just unmuted.
      resetSettings: () => {
        mutedNicknames.clear()
        set({ settings: { ...DEFAULT_SETTINGS } })
      },
      muteFingerprint: (fingerprint, nickname) => {
        if (!isValidFingerprint(fingerprint)) return false
        const canonical = canonicalFingerprint(fingerprint)
        const muted = get().settings.mutedFingerprints
        // The cap refuses, it never evicts: the 101st entry is a no-op
        // (false) and the list only shrinks via explicit unmutes or the
        // panic wipe — silent eviction could unhide an abusive peer.
        if (!muted.includes(canonical)) {
          if (muted.length >= MAX_MUTED_FINGERPRINTS) return false
          set((state) => ({
            settings: {
              ...state.settings,
              mutedFingerprints: [...state.settings.mutedFingerprints, canonical],
            },
          }))
        }
        // Last-seen nickname refreshes on every mute, idempotent included.
        if (nickname !== '') mutedNicknames.set(canonical, nickname)
        return true
      },
      unmuteFingerprint: (fingerprint) => {
        if (!isValidFingerprint(fingerprint)) return false
        const canonical = canonicalFingerprint(fingerprint)
        if (!get().settings.mutedFingerprints.includes(canonical)) return false
        set((state) => ({
          settings: {
            ...state.settings,
            mutedFingerprints: state.settings.mutedFingerprints.filter((fp) => fp !== canonical),
          },
        }))
        mutedNicknames.delete(canonical)
        return true
      },
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
