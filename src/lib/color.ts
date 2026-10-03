/**
 * Stable author colors — spec §10.4: the author name takes a stable color
 * derived from hash(peerId) → hue. A tiny FNV-1a is enough: it only needs
 * to be stable and well-spread, never cryptographic.
 */

/** Stable hue (0–359) for an identifier (peerId or 'self'). */
export function authorHue(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 360
}

/**
 * CSS color for an author name. Lightness/saturation chosen to keep AA-ish
 * contrast on both the light and dark theme backgrounds.
 */
export function authorColor(id: string): string {
  return `hsl(${authorHue(id)} 65% 52%)`
}
