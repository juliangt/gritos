import { describe, expect, it } from 'vitest'
import { resolveTheme } from '../src/hooks/useTheme'

describe('resolveTheme (RF-10)', () => {
  it("resolves 'system' against the live OS preference", () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('passes explicit choices through regardless of the OS preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})
