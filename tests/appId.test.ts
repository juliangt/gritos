import { describe, expect, it } from 'vitest'
import { MissingAppIdError, resolveTrysteroAppId } from '../src/lib/p2p/appId'

/**
 * Issue #90 — the Trystero appId (§9.4) comes from the build environment
 * (`VITE_TRYSTERO_APP_ID`). A missing or blank value must fail fast (a
 * silent fallback would quietly fork the discovery swarm), and the value is
 * trimmed so a stray space in a host's build configuration cannot split a
 * namespace into two.
 */

describe('resolveTrysteroAppId (issue #90)', () => {
  it('returns the configured value, trimmed', () => {
    expect(resolveTrysteroAppId({ VITE_TRYSTERO_APP_ID: '  my-uuid/gritos-dev \n' })).toBe(
      'my-uuid/gritos-dev',
    )
  })

  it('exposes the vite.config test.env fixture as the default value', () => {
    // Set via `test.env` in vite.config.ts; roomManager tests assert this
    // same value is the appId forwarded to the joinRoom config.
    expect(resolveTrysteroAppId()).toBe('gritos-app-v1')
  })

  it('throws MissingAppIdError when the variable is missing', () => {
    expect(() => resolveTrysteroAppId({})).toThrow(MissingAppIdError)
  })

  it('throws MissingAppIdError when the variable is blank', () => {
    expect(() => resolveTrysteroAppId({ VITE_TRYSTERO_APP_ID: '' })).toThrow(MissingAppIdError)
    expect(() => resolveTrysteroAppId({ VITE_TRYSTERO_APP_ID: '   ' })).toThrow(MissingAppIdError)
  })

  it('names the variable and the fix in the error message', () => {
    expect(() => resolveTrysteroAppId({})).toThrow(/VITE_TRYSTERO_APP_ID/)
    expect(() => resolveTrysteroAppId({})).toThrow(/\.env\.example/)
  })
})
