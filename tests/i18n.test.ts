// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { en, type TranslationKey } from '../src/i18n/en'
import { es } from '../src/i18n/es'
import { getLocale, resolveLocale, setLocale, t, tPlural, useT } from '../src/i18n/index'

/**
 * Issue #119 — the i18n core: pure locale resolution, the module-level
 * locale store (`<html lang>` side effect included), the `t` translator
 * (live snapshot reads, en fallback, dev warn + key echo, `{name}`
 * interpolation), the `…One`/`…Other` plural helper and the `useT` React
 * binding (re-render on switch, no remount). The es key parity side is
 * compile-enforced by `Translations` (verified by `tsc -b`, not here).
 */

/**
 * Shadows jsdom's `Navigator.prototype.language` getter with an own
 * instance property (the shareButton/share stubbing pattern); afterEach
 * deletes it so the jsdom default ('en-US') shines through again.
 */
function stubNavigatorLanguage(value: string): void {
  Object.defineProperty(window.navigator, 'language', { value, configurable: true })
}

afterEach(() => {
  Reflect.deleteProperty(window.navigator, 'language')
  // jsdom's default navigator.language ('en-US') resolves back to 'en',
  // leaving every suite independent of the previous one's locale.
  setLocale('auto')
  cleanup()
})

describe('resolveLocale (pure)', () => {
  it("resolves 'auto' by the es* prefix of the browser language, else en", () => {
    const matrix: readonly (readonly [string | undefined, 'en' | 'es'])[] = [
      ['es-ES', 'es'],
      ['es', 'es'],
      ['en-US', 'en'],
      ['en', 'en'],
      ['fr-FR', 'en'],
      ['', 'en'],
      [undefined, 'en'],
    ]
    for (const [navigatorLanguage, expected] of matrix) {
      expect(resolveLocale('auto', navigatorLanguage)).toBe(expected)
    }
  })

  it('passes a pinned en/es through regardless of the browser language', () => {
    expect(resolveLocale('en', 'es-ES')).toBe('en')
    expect(resolveLocale('en', undefined)).toBe('en')
    expect(resolveLocale('es', 'en-US')).toBe('es')
    expect(resolveLocale('es', undefined)).toBe('es')
  })
})

describe('setLocale / getLocale', () => {
  it("applies an explicit 'es' to the store and to <html lang>", () => {
    setLocale('es')
    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it("applies an explicit 'en' to the store and to <html lang>", () => {
    setLocale('es')
    setLocale('en')
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it("resolves 'auto' against the live navigator.language (es-ES → es)", () => {
    stubNavigatorLanguage('es-ES')
    setLocale('auto')
    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })
})

describe('t', () => {
  it('returns the exact English string under en (components and tests share the keys)', () => {
    setLocale('en')
    expect(t('common.cancel')).toBe(en['common.cancel'])
    expect(t('common.cancel')).toBe('Cancel')
    expect(t('errors.unknown')).toBe('Unknown error')
  })

  it('returns the Spanish string after a locale switch — plain call, no remount', () => {
    setLocale('es')
    expect(t('common.cancel')).toBe(es['common.cancel'])
    expect(t('common.cancel')).toBe('Cancelar')
  })

  it('interpolates {name} placeholders from params', () => {
    setLocale('en')
    expect(t('common.copiedWith', { what: 'the room link' })).toBe('Copied the room link')
    setLocale('es')
    expect(t('common.copiedWith', { what: 'el enlace de la sala' })).toBe(
      'Copiado el enlace de la sala',
    )
  })

  it('leaves placeholders with no matching param as-is', () => {
    setLocale('en')
    expect(t('common.copiedWith', { unrelated: 'x' })).toBe('Copied {what}')
    expect(t('common.copiedWith')).toBe('Copied {what}')
  })

  it('echoes an unknown key and warns once per key in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const bogus = 'test.bogusNeverSeeded' as TranslationKey
      expect(t(bogus)).toBe('test.bogusNeverSeeded')
      // A second miss on the same key stays silent (once per key).
      expect(t(bogus)).toBe('test.bogusNeverSeeded')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('test.bogusNeverSeeded'))
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to English when the active es dictionary lacks the key', () => {
    setLocale('es')
    // Simulate a hostile/es-drifted dictionary: drop the key at runtime and
    // restore it — types forbid this, the runtime net must still hold.
    const seeded = es['common.cancel']
    delete (es as Record<string, string>)['common.cancel']
    try {
      expect(t('common.cancel')).toBe('Cancel')
    } finally {
      es['common.cancel'] = seeded
    }
  })
})

describe('tPlural', () => {
  it('picks …One for count 1 and …Other otherwise, injecting count', () => {
    setLocale('en')
    expect(tPlural('common.peerCount', 1)).toBe('1 peer')
    expect(tPlural('common.peerCount', 0)).toBe('0 peers')
    expect(tPlural('common.peerCount', 2)).toBe('2 peers')
    // The real count wins over a caller-supplied {count} param.
    expect(tPlural('common.peerCount', 2, { count: 999 })).toBe('2 peers')
  })

  it('resolves the plural pair in the active locale', () => {
    setLocale('es')
    expect(tPlural('common.peerCount', 1)).toBe('1 par')
    expect(tPlural('common.peerCount', 3)).toBe('3 pares')
  })
})

describe('useT', () => {
  it('re-renders on a locale switch without remounting', () => {
    let renders = 0
    function TProbe(): ReactNode {
      renders += 1
      const translate = useT()
      return createElement('p', { 'data-testid': 'probe' }, translate('common.cancel'))
    }

    setLocale('en')
    render(createElement(TProbe))
    expect(screen.getByTestId('probe')).toHaveTextContent('Cancel')
    const rendersAfterMount = renders

    act(() => {
      setLocale('es')
    })
    expect(screen.getByTestId('probe')).toHaveTextContent('Cancelar')
    expect(renders).toBeGreaterThan(rendersAfterMount)
  })
})
