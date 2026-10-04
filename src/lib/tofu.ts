/**
 * TOFU pin store — issue #22. Persists the first-seen fingerprint per peer
 * under `gritos:tofu` (`{peerId: fingerprint}`, JSON) so a later key
 * rotation is detectable instead of silent (trust on first use — README,
 * spec §9.5). Only public values are stored: fingerprints are the SHA-256
 * of announced public keys, never message content or key material.
 *
 * Same conventions as the other `gritos:*` stores (spec §8.2): null-safe
 * (tests, private modes — never throws) and corruption-safe (invalid JSON
 * → empty map). Wiped by the panic button (RF-08).
 */

export const TOFU_STORAGE_KEY = 'gritos:tofu'

/** Reads the pinned fingerprints; null-safe and corruption-safe. */
export function loadTofuPins(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  const raw = localStorage.getItem(TOFU_STORAGE_KEY)
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const pins: Record<string, string> = {}
    for (const [peerId, fingerprint] of Object.entries(parsed as Record<string, unknown>)) {
      if (peerId !== '' && typeof fingerprint === 'string' && fingerprint !== '') {
        pins[peerId] = fingerprint
      }
    }
    return pins
  } catch {
    return {}
  }
}

/** Writes the pinned fingerprints under `gritos:tofu`; null-safe. */
export function saveTofuPins(pins: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(TOFU_STORAGE_KEY, JSON.stringify(pins))
  } catch {
    // Quota/privacy-mode failures are non-fatal: TOFU degrades to
    // per-session pinning and the advisory warning simply cannot persist.
  }
}

/** The pinned fingerprint of a peer, or null when never seen before. */
export function getTofuFingerprint(peerId: string): string | null {
  return loadTofuPins()[peerId] ?? null
}

/**
 * Pins the first-seen fingerprint of a peer. First write wins: a peer that
 * already has a pin keeps it forever (that is the whole TOFU point); empty
 * ids/fingerprints are ignored.
 */
export function pinTofuFingerprint(peerId: string, fingerprint: string): void {
  if (peerId === '' || fingerprint === '') return
  const pins = loadTofuPins()
  if (pins[peerId] !== undefined) return
  saveTofuPins({ ...pins, [peerId]: fingerprint })
}
