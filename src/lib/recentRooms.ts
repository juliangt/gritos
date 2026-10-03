/**
 * Recent-rooms persistence — spec §8.2 key `gritos:rooms`
 * (`{recent: string[]}`, names only, never content) and RF-02 semantics:
 * most-recent-first, capped, only kept while `rememberRooms` is active.
 */

import type { AppState } from '../stores/useAppStore'

export const ROOMS_STORAGE_KEY = 'gritos:rooms'

/** Ring size for the recent-rooms list (plan M2: "cap ~10"). */
export const RECENT_ROOMS_CAP = 10

/** Pure: moves `name` to the front of the list, deduped, capped. */
export function pushRecentRoom(list: string[], name: string): string[] {
  const next = [name, ...list.filter((entry) => entry !== name)]
  return next.slice(0, RECENT_ROOMS_CAP)
}

/** Pure: removes a name (used when a room is left and forgotten). */
export function dropRecentRoom(list: string[], name: string): string[] {
  return list.filter((entry) => entry !== name)
}

/** Reads `{recent}` from localStorage; null-safe and corruption-safe. */
export function loadRecentRooms(): AppState['recentRooms'] {
  if (typeof localStorage === 'undefined') return []
  const raw = localStorage.getItem(ROOMS_STORAGE_KEY)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as { recent?: unknown } | null
    if (parsed === null || !Array.isArray(parsed.recent)) return []
    return parsed.recent
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .slice(0, RECENT_ROOMS_CAP)
  } catch {
    return []
  }
}

/** Writes `{recent}` under `gritos:rooms`; null-safe (tests, privacy modes). */
export function saveRecentRooms(recent: string[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ROOMS_STORAGE_KEY, JSON.stringify({ recent }))
  } catch {
    // Quota/privacy-mode failures are non-fatal: recents are cosmetic.
  }
}
