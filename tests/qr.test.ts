import { describe, expect, it } from 'vitest'
import packageJsonRaw from '../package.json?raw'
import qrInstalledPkgRaw from '../node_modules/qrcode-generator/package.json?raw'
import qrDistRaw from '../node_modules/qrcode-generator/dist/qrcode.mjs?raw'
import { QrCapacityError, QR_EC_LEVEL, buildQrMatrix, type QrMatrix } from '../src/lib/qr'

/**
 * Issue #100 (Phase 1) — the pure QR matrix helper. The golden assertions
 * pin dimensions, dark-module counts, individual modules and a raw bit-run
 * against `qrcode-generator@2.0.4`'s own output (the gold standard): their
 * job is to catch accidental drift in the wrapper's encoding parameters
 * (error-correction level, version policy), not upstream re-encodings.
 */

/** Counts dark modules row-major over the full N x N grid. */
function countDark(matrix: QrMatrix): number {
  let count = 0
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      if (matrix.isDark(row, col)) count++
    }
  }
  return count
}

/** Row-major bit string of the whole matrix ('1' = dark). */
function toBits(matrix: QrMatrix): string {
  let bits = ''
  for (let row = 0; row < matrix.moduleCount; row++) {
    for (let col = 0; col < matrix.moduleCount; col++) {
      bits += matrix.isDark(row, col) ? '1' : '0'
    }
  }
  return bits
}

/** True when both matrices agree in size and on every module. */
function sameMatrix(a: QrMatrix, b: QrMatrix): boolean {
  if (a.moduleCount !== b.moduleCount) return false
  return toBits(a) === toBits(b)
}

/** QR version from the module count: `moduleCount = 21 + 4 * version`. */
function qrVersion(matrix: QrMatrix): number {
  return (matrix.moduleCount - 17) / 4
}

const SHORT_ORIGIN = 'https://gritos.example/'
/** The exact share link for room 'lobby' on a short origin. */
const LOBBY_LINK = `${SHORT_ORIGIN}#room=lobby`

describe('dependency pin + license (supply-chain guard)', () => {
  // Same ?raw pattern as license.test.ts: no node:fs (the project ships no
  // Node types), the assertions run against the exact bytes on disk.
  const packageJson = JSON.parse(packageJsonRaw) as {
    dependencies?: Record<string, string>
  }
  const installedPkg = JSON.parse(qrInstalledPkgRaw) as {
    version?: string
    license?: string
    dependencies?: Record<string, string>
  }

  it('pins qrcode-generator to an exact version (no ^ or ~ range)', () => {
    const pin = packageJson.dependencies?.['qrcode-generator']
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('pins exactly the version present in node_modules', () => {
    const pin = packageJson.dependencies?.['qrcode-generator']
    expect(pin).toBe(installedPkg.version)
  })

  it('adds zero transitive dependencies', () => {
    expect(Object.keys(installedPkg.dependencies ?? {})).toHaveLength(0)
  })

  it('carries the MIT license: package field plus the embedded license header', () => {
    expect(installedPkg.license).toBe('MIT')
    // The package ships no standalone LICENSE file; the MIT grant lives in
    // the source headers, so pin its presence instead.
    expect(qrDistRaw).toContain('Licensed under the MIT license')
    expect(qrDistRaw).toContain('Kazuhiko Arase')
  })
})

describe('buildQrMatrix golden (guards EC level + version drift)', () => {
  it('uses error correction level M', () => {
    expect(QR_EC_LEVEL).toBe('M')
  })

  it('encodes the lobby link to the pinned version-3 matrix', () => {
    const matrix = buildQrMatrix(LOBBY_LINK)

    expect(qrVersion(matrix)).toBe(3)
    expect(matrix.moduleCount).toBe(29)
    expect(countDark(matrix)).toBe(436)
  })

  it('reproduces the pinned module layout (finder corners + bit runs)', () => {
    const matrix = buildQrMatrix(LOBBY_LINK)
    const n = matrix.moduleCount

    // The three finder patterns: dark corner anchors...
    expect(matrix.isDark(0, 0)).toBe(true)
    expect(matrix.isDark(0, n - 1)).toBe(true)
    expect(matrix.isDark(n - 1, 0)).toBe(true)
    expect(matrix.isDark(6, 6)).toBe(true) // alignment center
    expect(matrix.isDark(3, 3)).toBe(true) // inside the top-left finder
    // ...and the bottom-right quiet corner the finders leave light.
    expect(matrix.isDark(n - 1, n - 1)).toBe(false)

    // First 64 modules (rows 0-2, row-major), pinned verbatim from the
    // library's 2.0.4 output for this input.
    expect(
      toBits(matrix).startsWith('1111111010110111011100111111110000010101101001010001000001101110'),
    ).toBe(true)
  })
})

describe('worst-case realistic link', () => {
  // A 64-char origin (long GitHub Pages project URL) + the RF-02 max room
  // name: `#room=` + 32 chars of [a-z0-9_-], none of which need
  // percent-encoding. 102 chars total -> QR version 6 (moduleCount 41) at
  // EC level M — far under the version-40 ceiling.
  const LONG_ORIGIN =
    'https://a-very-long-64-char-origin-hostname.example.com/gritos-demo-app/'.slice(0, 64)
  const MAX_NAME = 'x'.repeat(32)

  it('operates on a genuinely worst-case 64-char origin + 32-char name', () => {
    expect(LONG_ORIGIN).toHaveLength(64)
    expect(MAX_NAME).toMatch(/^[a-z0-9_-]{1,32}$/)
    expect(`${LONG_ORIGIN}#room=${MAX_NAME}`).toHaveLength(102)
  })

  it('encodes it as a version-6 symbol', () => {
    const matrix = buildQrMatrix(`${LONG_ORIGIN}#room=${MAX_NAME}`)

    expect(qrVersion(matrix)).toBe(6)
    expect(matrix.moduleCount).toBe(41)
    expect(countDark(matrix)).toBe(856)
  })
})

describe('capacity guard', () => {
  it('throws a typed QrCapacityError beyond version-40 capacity (never truncates)', () => {
    // 3000 ASCII chars exceeds the ~2331-byte byte-mode capacity of a
    // version-40 symbol at EC level M; the library throws a bare string
    // ('code length overflow...') that the helper must wrap.
    const oversized = 'a'.repeat(3000)

    let caught: unknown
    try {
      buildQrMatrix(oversized)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(QrCapacityError)
    expect((caught as QrCapacityError).name).toBe('QrCapacityError')
    expect((caught as QrCapacityError).message).toContain('QR capacity exceeded')
  })
})

describe('determinism and growth', () => {
  const CORPUS = [
    LOBBY_LINK,
    'https://gritos.example/#room=mi-sala',
    // Percent-encoded name: the QR encodes the link text verbatim.
    'https://gritos.example/#room=mi%20sala',
    'https://juliangt.github.io/gritos/#room=random_1',
    'http://localhost:5173/#room=dev',
  ]

  it('re-encodes every corpus link to the identical matrix', () => {
    for (const link of CORPUS) {
      expect(sameMatrix(buildQrMatrix(link), buildQrMatrix(link))).toBe(true)
    }
  })

  it('grows the matrix strictly with input length (versions 3..6)', () => {
    // Lengths chosen to cross each version threshold at EC level M:
    // 30 -> v3, 45 -> v4, 63 -> v5, 103 -> v6 total chars.
    const links = [1, 16, 34, 74].map((len) => `${SHORT_ORIGIN}#room=${'x'.repeat(len)}`)
    const counts = links.map((link) => buildQrMatrix(link).moduleCount)

    expect(counts).toEqual([29, 33, 37, 41])
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1])
    }
  })
})
