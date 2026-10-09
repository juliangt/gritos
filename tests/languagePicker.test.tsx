// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AppearanceTab } from '../src/components/settings/AppearanceTab'
import { getLocale, setLocale } from '../src/i18n/index'
import { SETTINGS_STORAGE_KEY, useSettingsStore } from '../src/stores/useSettingsStore'

/**
 * Issue #119 phase 5 — the Settings → Appearance language picker (QA-119-3).
 * It proves the write invariant (`setLanguagePreference` persists the choice
 * AND applies the locale) and the no-reload contract end to end: one change
 * event flips the settings store, the i18n runtime and `<html lang>`, and
 * the already-mounted tab re-renders its labels in Spanish in place.
 *
 * The picker drives the same stores the rest of the app reads, so this
 * suite restores both in afterEach (locale re-pinned to 'en', settings
 * reset to defaults) and clears `gritos:settings` between tests.
 */

beforeEach(() => {
  localStorage.clear()
  useSettingsStore.getState().resetSettings()
  setLocale('en')
})

afterEach(() => {
  cleanup()
  setLocale('en')
  useSettingsStore.getState().resetSettings()
  localStorage.clear()
})

function picker(name: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name })
}

describe('language picker (issue #119, Settings → Appearance)', () => {
  it('renders exactly Auto / English / Español, with the persisted value selected', () => {
    render(<AppearanceTab />)

    expect([...picker('Language').options].map((option) => option.textContent)).toEqual([
      'Auto',
      'English',
      'Español',
    ])
    expect(picker('Language')).toHaveValue('auto')
  })

  it('selecting Español persists "es", flips the locale and <html lang>, and relabels the tab in place', () => {
    render(<AppearanceTab />)
    const selectBefore = picker('Language')
    expect(screen.getByText('Theme')).toBeInTheDocument()

    fireEvent.change(selectBefore, { target: { value: 'es' } })

    // The invariant: one call wrote the persisted choice AND the live locale.
    expect(useSettingsStore.getState().settings.language).toBe('es')
    expect(
      (JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) as string) as { language: string })
        .language,
    ).toBe('es')
    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')

    // No reload, no remount: the SAME <select> node re-rendered Spanish —
    // the English label is gone, its Spanish counterpart present.
    expect(screen.queryByText('Theme')).not.toBeInTheDocument()
    expect(screen.getByText('Tema')).toBeInTheDocument()
    expect(screen.getByText('Contraer la barra lateral al iniciar')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Idioma' })).toBe(selectBefore)
    // Only 'Auto' translates; the endonyms stay put.
    expect([...picker('Idioma').options].map((option) => option.textContent)).toEqual([
      'Automático',
      'English',
      'Español',
    ])
  })

  it('Auto resolves the live navigator.language at change time (es-ES → es, en-US → en)', () => {
    render(<AppearanceTab />)
    const select = picker('Language')

    // jsdom declares `language` on Navigator.prototype; an own instance
    // property shadows it and deleting it restores the getter.
    Object.defineProperty(window.navigator, 'language', { value: 'es-ES', configurable: true })
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(useSettingsStore.getState().settings.language).toBe('auto')
    expect(getLocale()).toBe('es')
    expect(document.documentElement.lang).toBe('es')

    Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
    fireEvent.change(select, { target: { value: 'auto' } })
    expect(getLocale()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
