/**
 * Generates the PWA icon set (issue #104, phase 1) from the brand mark in
 * public/favicon.svg — zero dependencies, Node built-ins only.
 *
 *   public/icons/icon-192.png           purpose "any"
 *   public/icons/icon-512.png           purpose "any"
 *   public/icons/icon-maskable-192.png  purpose "maskable"
 *   public/icons/icon-maskable-512.png  purpose "maskable"
 *
 * Why generated rather than resized: the only raster source is
 * public/apple-touch-icon.png at 180x180 — `sips` upscaling to 512 would
 * ship soft edges, and no SVG rasterizer (rsvg-convert, inkscape,
 * ImageMagick) is assumed on the machine. Instead the exact favicon.svg
 * geometry (viewBox 0 0 32 32) is rasterized analytically at each target
 * size, so every icon is pixel-sharp and consistent with the existing
 * brand mark:
 *
 *   - #1c1917 rounded square (rx 7)  — the icon background
 *   - #fafaf9 chat bubble (rounded rect + tail)
 *   - #1c1917 exclamation mark (tapered bar + dot) knocked out of the bubble
 *
 * The tail's 1-unit arc and the bar's shoulder cubics are approximated with
 * straight segments/union shapes; the deviation is below half a viewBox unit
 * and invisible at icon sizes. Maskable variants use a full-bleed square
 * (masks crop the corners anyway) with the mark scaled to 80% about the
 * center, which keeps it fully inside the maskable safe zone (the inner
 * 80% circle — worst-case corner distance 10.8 < 12.8 viewBox units).
 *
 * Anti-aliasing is 4x4 supersampling per pixel. Run with:
 *
 *   node scripts/generate-pwa-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

// Brand colors, straight from favicon.svg (and the light --gritos-bg token).
const DARK = [28, 25, 23] // #1c1917
const LIGHT = [250, 250, 249] // #fafaf9

// Mark scale for maskable variants (1 = the favicon geometry as drawn).
const MASKABLE_SCALE = 0.8

// --- Point-in-shape tests, all in the 32x32 viewBox space -------------------

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hw = (x1 - x0) / 2 - r
  const hh = (y1 - y0) / 2 - r
  const qx = Math.max(Math.abs(x - cx) - hw, 0)
  const qy = Math.max(Math.abs(y - cy) - hh, 0)
  return qx * qx + qy * qy <= r * r
}

function inCircle(x, y, cx, cy, r) {
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r
}

function inCapsule(x, y, ax, ay, bx, by, r) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  const px = ax + t * dx
  const py = ay + t * dy
  return (x - px) * (x - px) + (y - py) * (y - py) <= r * r
}

/** Even-odd ray casting against a convex polygon (the bubble tail). */
function inPolygon(x, y, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// favicon.svg paths, traced: bubble rect (6,7)-(26,21) rx 2; tail quad from
// the l-4.7 4.3 / a1 1 0 0 1 -1.7 -0.7 / V21 segments; exclamation bar as a
// capsule spanning the same vertical extent (the original's shoulder taper
// is dropped — a rounded "!" bar reads correctly, a sharp apex reads as an
// arrow); dot.
const BUBBLE = [6, 7, 26, 21, 2]
const TAIL = [
  [9, 21],
  [15.4, 21],
  [10.7, 25.3],
  [9, 24.6],
]

/** The color covering a viewBox point, painted in favicon.svg order, or null. */
function markColorAt(x, y, maskable) {
  // Maskable variants shrink the mark about the viewBox center.
  const px = maskable ? 16 + (x - 16) / MASKABLE_SCALE : x
  const py = maskable ? 16 + (y - 16) / MASKABLE_SCALE : y
  let color = null
  if (inRoundedRect(px, py, 0, 0, 32, 32, maskable ? 0 : 7)) color = DARK
  if (inRoundedRect(px, py, ...BUBBLE) || inPolygon(px, py, TAIL)) color = LIGHT
  if (inCapsule(px, py, 16, 10.8, 16, 14.42, 1.2) || inCircle(px, py, 16, 17.9, 1.35)) {
    color = DARK
  }
  return color
}

// --- PNG encoding (8-bit RGBA, no interlace) --------------------------------

let crcTable
function crc32(buf) {
  if (crcTable == null) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  // One filter byte (0 = None) per scanline.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let row = 0; row < size; row++) {
    rgba.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolor with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- Rendering --------------------------------------------------------------

function render(size, maskable) {
  const scale = size / 32
  const samples = 4 // 4x4 supersampling per pixel
  const rgba = Buffer.alloc(size * size * 4)
  let o = 0
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0
      let g = 0
      let b = 0
      let hit = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          // Pixel center sub-samples map back into the 32-unit viewBox.
          const x = (col + (sx + 0.5) / samples) / scale
          const y = (row + (sy + 0.5) / samples) / scale
          const color = markColorAt(x, y, maskable)
          if (color != null) {
            r += color[0]
            g += color[1]
            b += color[2]
            hit++
          }
        }
      }
      if (hit > 0) {
        rgba[o] = Math.round(r / hit)
        rgba[o + 1] = Math.round(g / hit)
        rgba[o + 2] = Math.round(b / hit)
        rgba[o + 3] = Math.round((hit / (samples * samples)) * 255)
      }
      o += 4
    }
  }
  return encodePng(size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of [192, 512]) {
  for (const maskable of [false, true]) {
    const name = `icon-${maskable ? 'maskable-' : ''}${size}.png`
    const png = render(size, maskable)
    writeFileSync(join(OUT_DIR, name), png)
    console.log(`wrote public/icons/${name} (${png.length} bytes)`)
  }
}
