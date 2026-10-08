import { describe, expect, it } from 'vitest'
import readme from '../README.md?raw'
import spec from '../docs/spec.md?raw'
import qaChecklist from '../docs/qa-checklist.md?raw'

/**
 * Release guard for issue #95 (local moderation: mute peers by identity
 * fingerprint). The docs-only phase of the issue, so the guard pins the
 * documentation to the shipped behavior:
 *
 *  1. the README's "Privacy controls" bullet documents the mute feature and
 *     keeps its five-`gritos:*`-keys claim — the mute list rides inside
 *     `gritos:settings`, it is NOT a sixth key,
 *  2. spec §8.1 grows the `mutedFingerprints` field while §8.2 still lists
 *     exactly five `gritos:*` storage keys plus the explicit no-new-key note,
 *  3. the spec weaves the enforcement semantics (§7.3) and the threat-model
 *     cross-reference with its accepted limits (§9.5), and
 *  4. the manual mute matrix ships in `docs/qa-checklist.md`.
 *
 * All three files are read through vite's `?raw` transform (no `node:fs` —
 * the project deliberately ships no Node types), so the assertions run
 * against the exact bytes on disk.
 */

describe('local moderation documentation (issue #95)', () => {
  it('documents the mute feature under the README privacy controls bullet', () => {
    expect(readme).toContain('**Privacy controls**')
    expect(readme).toContain('mute by identity fingerprint')
    expect(readme).toContain('no server, no reports')
  })

  it('keeps the README five-keys claim alongside the new feature', () => {
    expect(readme).toContain('only five `gritos:*` keys')
  })

  it('adds mutedFingerprints to the spec §8.1 Settings shape', () => {
    expect(spec).toContain('mutedFingerprints: string[]')
  })

  it('keeps spec §8.2 at exactly five gritos:* keys with the mute-list note', () => {
    const storageKeyRows = spec.match(/^\| `gritos:/gm) ?? []
    expect(storageKeyRows).toHaveLength(5)
    expect(spec).toContain('no estrena clave')
  })

  it('pins the enforcement semantics and §9.5 cross-reference', () => {
    expect(spec).toContain('Silenciado local (issue #95)')
    expect(spec).toContain('silenciar pares por fingerprint')
  })

  it('ships the manual mute matrix in docs/qa-checklist.md', () => {
    expect(qaChecklist).toContain('## Issue #95 — local moderation')
    for (let n = 1; n <= 9; n += 1) {
      expect(qaChecklist).toContain(`QA-95-${n}`)
    }
  })
})
