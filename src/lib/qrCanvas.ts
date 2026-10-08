/**
 * Canvas/PNG rendering of QR matrices (issue #100, Phase 2): draws the
 * `lib/qr.ts` matrix onto a `<canvas>` with the mandatory 4-module quiet
 * zone and exports it as a downloadable PNG. The only DOM-touching piece of
 * the QR stack (`qr.ts` stays pure so the node suite encodes directly).
 *
 * Theme/contrast decision — scannability trumps theme: the modules are
 * ALWAYS painted near-black (`QR_DARK_COLOR`) on a plain white quiet zone
 * (`QR_LIGHT_COLOR`), in light AND dark themes. Reasons:
 *  - Stock phone cameras (the primary scanner per the issue) are tuned for
 *    dark-on-light symbols and several struggle with inverted codes; the
 *    dark theme's `--gritos-text` is near-white, which would paint exactly
 *    such an inverted, hard-to-scan symbol.
 *  - The AA-audited tokens guarantee contrast for text on surfaces to human
 *    eyes, not to machine vision; #000-on-#fff is the maximum (21:1)
 *    luminance separation a decoder can ask for, in both themes.
 * The popover around the canvas keeps the normal theme (border/surface
 * tokens); only the QR surface itself is fixed.
 *
 * jsdom note: without the `canvas` npm package `getContext('2d')` returns
 * null — `paintQr` then no-ops (returns null) instead of throwing, so the
 * popover still renders its link fallback in DOM tests.
 */

import { buildQrMatrix, type QrMatrix } from './qr'

/**
 * The mandatory quiet zone around the symbol (QR spec: 4 modules on every
 * side), expressed in modules and added by this renderer, never by `qr.ts`.
 */
export const QR_QUIET_ZONE_MODULES = 4

/** On-screen canvas: pixels per module (CSS classes fix the display size). */
export const QR_ONSCREEN_MODULE_PX = 4

/** PNG export: minimum pixels per module before the size floor kicks in. */
export const QR_EXPORT_MODULE_PX = 8

/** PNG export: the canvas side never goes below this many pixels. */
export const QR_EXPORT_MIN_PX = 512

/** Fixed module color in both themes — see the module docblock. */
export const QR_DARK_COLOR = '#000000'

/** Fixed quiet-zone/background color in both themes — see the docblock. */
export const QR_LIGHT_COLOR = '#ffffff'

/**
 * Full canvas side (quiet zone included) in pixels for a matrix of
 * `moduleCount` modules at `modulePx` pixels per module.
 */
export function qrPixelSize(moduleCount: number, modulePx: number): number {
  return (moduleCount + 2 * QR_QUIET_ZONE_MODULES) * modulePx
}

/**
 * Whole pixels-per-module for the PNG export: at least
 * `QR_EXPORT_MODULE_PX`, rounded up so the side never drops under
 * `QR_EXPORT_MIN_PX` even for the smallest (version-1) symbols.
 */
export function qrExportModulePx(moduleCount: number): number {
  const side = moduleCount + 2 * QR_QUIET_ZONE_MODULES
  return Math.max(QR_EXPORT_MODULE_PX, Math.ceil(QR_EXPORT_MIN_PX / side))
}

/**
 * Paints `matrix` onto `canvas`: sizes the backing store to the full pixel
 * size (quiet zone included), fills it with `QR_LIGHT_COLOR`, then draws one
 * rect per dark module. Returns the pixel size, or null when no 2D context
 * is available (jsdom) — the caller keeps working without the drawing.
 */
export function paintQr(
  canvas: HTMLCanvasElement,
  matrix: QrMatrix,
  modulePx: number,
): number | null {
  const context = canvas.getContext('2d')
  if (context === null) return null

  const pixelSize = qrPixelSize(matrix.moduleCount, modulePx)
  canvas.width = pixelSize
  canvas.height = pixelSize

  context.fillStyle = QR_LIGHT_COLOR
  context.fillRect(0, 0, pixelSize, pixelSize)
  context.fillStyle = QR_DARK_COLOR
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (!matrix.isDark(row, col)) continue
      context.fillRect(
        (col + QR_QUIET_ZONE_MODULES) * modulePx,
        (row + QR_QUIET_ZONE_MODULES) * modulePx,
        modulePx,
        modulePx,
      )
    }
  }
  return pixelSize
}

/**
 * Download filename for a room's QR PNG. Room names are RF-02-normalized
 * ([a-z0-9_-]) before they ever reach a `Room`, so they are already
 * filesystem-safe without extra escaping.
 */
export function qrPngFilename(roomName: string): string {
  return `gritos-sala-${roomName}.png`
}

/**
 * Exports the QR of `link` as a PNG download (`gritos-sala-<name>.png`):
 * paints an offscreen canvas at the export scale, `toBlob`s a PNG and fires
 * an `<a download>` click on an object URL. No-ops silently when the 2D
 * context is missing (jsdom) or the blob comes back null — same degrade-
 * quietly contract as the denied-clipboard share fallback.
 */
export function downloadQrPng(link: string, roomName: string): void {
  const matrix = buildQrMatrix(link)
  const canvas = document.createElement('canvas')
  if (paintQr(canvas, matrix, qrExportModulePx(matrix.moduleCount)) === null) return

  canvas.toBlob((blob) => {
    if (blob === null) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = qrPngFilename(roomName)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 'image/png')
}
