import {
  abortAllRooms,
  resetSessionIdentity,
} from './p2p/roomManager'
import { clearDmKeyCache } from './crypto/dm'
import { IDENTITY_STORAGE_KEY } from './crypto/identity'
import { wipeKeyVault } from './crypto/keyVault'
import { ROOMS_STORAGE_KEY } from './recentRooms'
import { TOFU_STORAGE_KEY } from './tofu'
import { INITIAL_APP_STATE, useAppStore } from '../stores/useAppStore'
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  useSettingsStore,
} from '../stores/useSettingsStore'
import { DEFAULT_UI, UI_STORAGE_KEY, useUiStore } from '../stores/useUiStore'

/**
 * Panic button — spec RF-08. One call leaves nothing behind: every WebRTC
 * connection is aborted, the FIVE documented `gritos:*` localStorage keys
 * (spec §8.2) are removed — plus any other `gritos:*` key defensively — the
 * IndexedDB key vault holding the identity-wrapping key is cleared
 * (issue #24), in-memory stores return to their initial state and the app
 * reloads into a clean onboarding.
 *
 * Store resets run BEFORE the storage wipe: the persisted stores rewrite
 * their keys on every state change, so clearing last is what leaves the
 * localStorage genuinely empty.
 */

/** The five documented persistent keys of v1 (spec §8.2, incl. issue #22). */
export const PANIC_STORAGE_KEYS: readonly string[] = [
  SETTINGS_STORAGE_KEY,
  IDENTITY_STORAGE_KEY,
  ROOMS_STORAGE_KEY,
  UI_STORAGE_KEY,
  TOFU_STORAGE_KEY,
]

/**
 * Removes the five documented keys and, defensively, every other
 * `gritos:*` key. Never touches keys outside the `gritos:` namespace.
 * Returns the removed key names.
 */
export function clearGritosStorage(): string[] {
  if (typeof localStorage === 'undefined') return []
  const removed: string[] = []
  for (const key of PANIC_STORAGE_KEYS) {
    if (localStorage.getItem(key) !== null) {
      localStorage.removeItem(key)
      removed.push(key)
    }
  }
  // Defensive sweep: anything else under the app namespace (present or
  // future) must not survive the panic.
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (key !== null && key.startsWith('gritos:')) {
      localStorage.removeItem(key)
      if (!removed.includes(key)) removed.push(key)
    }
  }
  return removed
}

export interface PanicWipeOptions {
  /** Defaults to true; tests pass false and assert the reload themselves. */
  reload?: boolean
}

/** Executes the RF-08 wipe. `reload` defaults to `window.location.reload`. */
export function panicWipe(options: PanicWipeOptions = {}): void {
  // 1. Abort every WebRTC connection and drop the session identity.
  abortAllRooms()
  resetSessionIdentity()
  clearDmKeyCache()

  // 2. In-memory stores back to their initial state. The persisted stores
  //    re-write their keys on setState — hence the wipe below comes last.
  useAppStore.setState({ ...INITIAL_APP_STATE })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useUiStore.setState({ sidebarCollapsed: DEFAULT_UI.sidebarCollapsed })

  // 3. localStorage: the documented keys plus any other gritos:* remnant.
  clearGritosStorage()

  // 3b. The IndexedDB key vault (issue #24): the AES key that wraps the
  //     private identity JWK. Fire-and-forget like the rest of the
  //     best-effort teardown — `wipeKeyVault` resolves (never rejects) and
  //     no-ops where IndexedDB does not exist.
  void wipeKeyVault()

  // 4. Reload into the clean first-visit onboarding.
  if (options.reload !== false) {
    window.location.reload()
  }
}
