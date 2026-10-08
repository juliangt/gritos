/**
 * QR matrix generation for room invite links (issue #100, Phase 1): a pure
 * `text -> module matrix` helper with no DOM usage, so the node test-suite
 * runs it directly and the Phase 2 renderer draws it onto a canvas / exports
 * the PNG without re-encoding.
 *
 * The QR content is exactly `buildRoomLink`'s output (room name only, never
 * the password — RF-05); this module stays decoupled from `shareLinks.ts` and
 * from `window` so any text can be encoded in tests.
 *
 * Design notes:
 *  - Wraps `qrcode-generator` (MIT, zero transitive deps) for the encoding
 *    itself; we only consume its raw matrix (`getModuleCount` / `isDark`),
 *    never its canvas/table/SVG sugar — rendering is Phase 2's job.
 *  - Error correction level M: recovers ~15% of damaged surface, the usual
 *    balance for on-screen URL codes between density and robustness.
 *  - typeNumber 0 = automatic (version 1..40); a link too long even for
 *    version 40 throws `QrCapacityError` — never truncate silently.
 *  - The matrix carries NO quiet zone (the mandatory 4-module border is a
 *    rendering concern: the Phase 2 canvas/PNG renderer adds it, sized from
 *    `moduleCount`).
 */

import qrcode from 'qrcode-generator'

/** Error correction level 'M' — see the module docblock. */
export const QR_EC_LEVEL = 'M' as const

/**
 * The encoded matrix of a QR symbol: an N x N grid of modules addressed
 * `isDark(row, col)`, where `moduleCount === N` (`21 + 4 * version`). No
 * quiet zone included; the renderer owns the border.
 */
export interface QrMatrix {
  /** Side length in modules (`21 + 4 * QR version`, 21..177). */
  moduleCount: number
  /** Whether the module at (row, col) is dark; both in [0, moduleCount). */
  isDark: (row: number, col: number) => boolean
}

/**
 * Thrown when the text cannot fit even a version-40 QR at the configured
 * error correction level. Realistic invite links never come close (the
 * worst case in the tests, a 64-char origin + the RF-02 max 32-char room
 * name, is version 6), but the guard keeps a pathological input loud
 * instead of silently truncated.
 */
export class QrCapacityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QrCapacityError'
  }
}

/**
 * Encodes `text` into a deterministic QR module matrix (EC level M, automatic
 * version up to 40). Same input always yields the same matrix — the encoder
 * picks the lowest sufficient version and its default (best) mask, no
 * randomness anywhere.
 */
export function buildQrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, QR_EC_LEVEL)
  qr.addData(text)
  try {
    qr.make()
  } catch (err) {
    // The library throws a bare string ('code length overflow. (n>m)') once
    // even version 40 cannot hold the data — rethrow typed, message intact.
    throw new QrCapacityError(
      `QR capacity exceeded at EC level ${QR_EC_LEVEL} (version 40): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return {
    moduleCount: qr.getModuleCount(),
    // Zero-copy accessor over the library's matrix; the renderer iterates
    // row/col and paints dark modules only.
    isDark: (row: number, col: number): boolean => qr.isDark(row, col),
  }
}
