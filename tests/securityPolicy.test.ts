import { describe, expect, it } from 'vitest'
import securityPolicy from '../SECURITY.md?raw'

/**
 * Release guard for issue #34 (the repo shipped v1.0.0 with no SECURITY.md
 * and no documented private disclosure path, so researchers had no way to
 * report issues responsibly). Keeps the security policy from silently
 * regressing:
 *
 *  1. the repo-root `SECURITY.md` exists and names GitHub's private
 *     vulnerability reporting as the channel,
 *  2. it declares a supported version line (v1.x), and
 *  3. it points at the authoritative threat model — the accepted trade-offs
 *     in `docs/spec.md` §9.5.
 *
 * The policy is read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk.
 */
describe('security policy (issue #34)', () => {
  it('ships SECURITY.md at the repo root', () => {
    expect(securityPolicy.length).toBeGreaterThan(0)
  })

  it('names GitHub private vulnerability reporting as the channel', () => {
    expect(securityPolicy).toContain('Report a vulnerability')
  })

  it('declares the supported version line (v1.x)', () => {
    expect(securityPolicy).toMatch(/## Supported Versions/i)
    expect(securityPolicy).toContain('v1.')
  })

  it('links the accepted trade-offs in docs/spec.md §9.5', () => {
    expect(securityPolicy).toContain('docs/spec.md §9.5')
    expect(securityPolicy).toContain('](docs/spec.md)')
  })
})
