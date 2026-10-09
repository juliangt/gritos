import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'
import packageJsonRaw from '../package.json?raw'
import {
  QR_BUTTON_LABEL,
  QR_DOWNLOAD_BUTTON,
  QR_SAME_INSTALL_NOTE,
} from '../src/components/settings/messages'

/**
 * Release guard for issue #100 (QR invite codes) — the docs phase of the
 * issue. Pins the documentation to the shipped behavior:
 *
 *  1. the README's feature bullet documents the QR under the share story:
 *     scan-to-join, the same password-free deep link the share button copies,
 *     the PNG download and the same-deployment caveat,
 *  2. the README's supply-chain paragraph names the new dependency with its
 *     exact installed pin (`qrcode-generator@<pin>`, MIT, zero transitive
 *     deps) — a Dependabot bump fails here until the docs follow,
 *  3. spec §10.8 documents the share affordance and the QR popover next to
 *     it: same link, never the password (RF-05), the fixed black-on-white
 *     scan surface, the PNG export and the same-install disclosure, and
 *  4. the manual QA matrix ships in `docs/qa-checklist.md` (QA-100-1..7).
 *
 * The docs are also kept in lockstep with the shipped UI strings: the spec
 * quotes the exact popover wording from `settings/messages.ts` (the single
 * source the component and the tests render from). All three files are read
 * through vite's `?raw` transform (no `node:fs` — the project deliberately
 * ships no Node types), so the assertions run against the exact bytes on
 * disk.
 */

describe('QR invite codes documentation (issue #100)', () => {
  it('documents the QR under a README feature bullet with the scan-to-join story', () => {
    expect(readme).toContain('**QR invite codes (issue #100)**')
    expect(readme).toContain('stock camera')
    // Same link as the share button — and therefore never the password.
    expect(readme).toContain('exactly the link the share button copies')
    expect(readme).toContain('never the password')
    expect(readme).toContain('still prompts for it (RF-05)')
  })

  it('documents the PNG download and the same-deployment caveat in the README bullet', () => {
    expect(readme).toContain(QR_DOWNLOAD_BUTTON)
    expect(readme).toContain('fixed near-black-on-white')
    expect(readme).toContain('same deployment')
    expect(readme).toContain('`VITE_TRYSTERO_APP_ID`')
    expect(readme).toContain(`"${QR_SAME_INSTALL_NOTE}"`)
  })

  it('names the new dependency with its exact installed pin in the supply-chain paragraph', () => {
    const packageJson = JSON.parse(packageJsonRaw) as {
      dependencies?: Record<string, string>
    }
    const pin = packageJson.dependencies?.['qrcode-generator']
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    // Lockstep with the qr.test.ts supply-chain guard: bumping the pin
    // without re-reading the docs fails here.
    expect(readme).toContain(`qrcode-generator@${pin}`)
    expect(readme).toContain('MIT')
    expect(readme).toContain('zero transitive dependencies')
  })

  it('documents the share flow and the QR affordance in spec §10.8', () => {
    expect(spec).toContain('### 10.8 Room sharing and QR invite code (issues #41 and #100)')
    // The QR encodes exactly the share link, never anything else.
    expect(spec).toContain('exactly that same link')
    expect(spec).toContain('only the name, never the password')
    expect(spec).toContain('(RF-05)')
  })

  it('pins the fixed scan surface, the PNG export and the same-install note in the spec', () => {
    expect(spec).toContain('near-black modules on white')
    expect(spec).toContain('scannability trumps the theme')
    expect(spec).toContain(`"${QR_DOWNLOAD_BUTTON}"`)
    expect(spec).toContain('gritos-room-<name>.png')
    expect(spec).toContain(`"${QR_SAME_INSTALL_NOTE}"`)
    expect(spec).toContain('`VITE_TRYSTERO_APP_ID`')
  })

  it('keeps the spec §10.1 header inventory pointing at the new section', () => {
    expect(spec).toContain('share and QR invite (section 10.8)')
  })

  it('ships the manual QR matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #100 — QR invite codes')
    expect(qaChecklist.match(/QA-100-\d+/g) ?? []).toHaveLength(7)
    for (let n = 1; n <= 7; n += 1) {
      expect(qaChecklist).toContain(`QA-100-${n}`)
    }
  })

  it('covers the matrix behaviors the issue pins: cameras, password rooms, PNG, themes, subpath', () => {
    for (const needle of [
      'iOS Camera',
      'Android Camera/Google Lens',
      'no password anywhere in the QR',
      '"Download PNG"',
      'BOTH themes',
      '32 chars of [a-z0-9_-]',
      'subpath',
      QR_BUTTON_LABEL,
    ]) {
      expect(qaChecklist).toContain(needle)
    }
  })
})
