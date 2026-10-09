// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #119 phase 5 — the boot resolution (QA-119-1/QA-119-2): the FIRST
 * `getLocale()` of a page load resolves the locale from the persisted
 * `gritos:settings` record — or, under the 'auto' default, from the browser
 * language — with no async gap and no flash of the wrong language, and it
 * mirrors the result into `<html lang>`.
 *
 * Each test seeds localStorage BEFORE dynamically importing the i18n
 * runtime: this file deliberately does NOT import tests/dom-setup (whose
 * `setLocale('en')` pin would count as the boot resolution), and
 * `vi.resetModules()` + the dynamic import re-evaluates the whole
 * i18n → settings-store graph against the seeded record — the exact path a
 * real first boot takes (the settings store rehydrates synchronously; the
 * persisted shape is the raw partial Settings JSON written by
 * `settingsStorage.setItem`, as in tests/settingsPersistence.test.ts).
 */

const SETTINGS_KEY = 'gritos:settings'

function stubBrowserLanguage(value: string): void {
  // jsdom declares `language` on Navigator.prototype; an own instance
  // property shadows it, and deleting it restores the getter.
  Object.defineProperty(window.navigator, 'language', { value, configurable: true })
}

function restoreBrowserLanguage(): void {
  delete (window.navigator as { language?: string }).language
}

async function bootI18n(): Promise<typeof import('../src/i18n/index')> {
  vi.resetModules()
  return import('../src/i18n/index')
}

afterEach(() => {
  restoreBrowserLanguage()
  localStorage.clear()
  document.documentElement.lang = 'en'
})

describe('i18n boot locale (issue #119 — fresh installs and persisted choices)', () => {
  it('a fresh install in an es* browser boots Spanish (QA-119-1)', async () => {
    stubBrowserLanguage('es-ES')
    const { getLocale } = await bootI18n()

    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it('a fresh install in any other browser boots English', async () => {
    stubBrowserLanguage('en-US')
    const { getLocale } = await bootI18n()

    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('a persisted language:es record wins over an en browser', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ language: 'es' }))
    stubBrowserLanguage('en-US')
    const { getLocale } = await bootI18n()

    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')
  })

  it('a persisted language:en record wins over an es browser (QA-119-2)', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ language: 'en' }))
    stubBrowserLanguage('es-ES')
    const { getLocale } = await bootI18n()

    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
