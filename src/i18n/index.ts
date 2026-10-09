import { create } from 'zustand'
import { useSettingsStore } from '../stores/useSettingsStore'
import { en, type TranslationKey, type Translations } from './en'
import { es } from './es'

export type { TranslationKey, Translations } from './en'

/**
 * Issue #119 — i18n runtime. Both locale dictionaries are sync-loaded in
 * the main chunk (plain static imports, zero new dependencies): the whole
 * dictionary surface is a few hundred short strings even once the copy
 * migration finishes, so laziness would buy nothing and cost a network
 * round-trip on locale switch. Plain prefix logic resolves the locale —
 * no `Intl` calls anywhere (the app targets exactly en/es).
 *
 * Import-graph note: the `LanguageSetting` type below is imported
 * `import type` by the settings store — a type-only import is fully
 * erased, so the runtime graph stays acyclic (i18n → settings store;
 * nothing runtime flows back).
 */

/** The locales the app ships. */
export type Locale = 'en' | 'es'

/**
 * The persisted user choice. `'auto'` follows the browser language
 * (Spanish when `navigator.language` starts with "es", English otherwise —
 * including undefined/empty); `'en'`/`'es'` pin the locale outright.
 */
export type LanguageSetting = Locale | 'auto'

/** Both dictionaries, sync-loaded — indexed by resolved locale. */
const DICTIONARIES: Record<Locale, Translations> = { en, es }

/**
 * Pure locale resolution, testable in isolation: an explicit `'en'`/`'es'`
 * setting wins over the browser; `'auto'` follows the `navigator.language`
 * prefix (`'es-ES'`, `'es'` → Spanish; anything else — `'en-US'`, `'fr-FR'`,
 * `''`, undefined — falls back to English, never to a guess).
 */
export function resolveLocale(
  setting: LanguageSetting,
  navigatorLanguage: string | undefined,
): Locale {
  if (setting === 'en' || setting === 'es') return setting
  return (navigatorLanguage ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
}

/**
 * The locale store — UI-React-facing (subscribed by `useT`) and holding
 * ONLY the resolved locale; the user's `language` choice lives in the
 * settings store. Resolved once on boot and again per `setLocale` call
 * (the resolver is cheap and pure).
 */
const useLocaleStore = create<{ locale: Locale }>()(() => ({ locale: 'en' }))

/** Whether the boot resolution already ran (lazy — see ensureBootLocale). */
let bootResolved = false

/**
 * Applies the boot locale from the settings store exactly once, on the
 * first `t`/`getLocale` call. LAZY on purpose: a module-load init would
 * import the settings store eagerly and close the import cycle i18n →
 * settings store → lib/crypto/dm → lib/p2p/protocol → lib/nickname → i18n,
 * whose partial initialization leaves `useSettingsStore` undefined at
 * evaluation time (surfaced by tests/settingsValidation.test.ts). Deferred
 * to first use, every import order works: the settings store rehydrates
 * synchronously (its PersistStorage.getItem is plain-sync, verified in
 * tests/settingsPersistence.test.ts), so the first translation already
 * sees the persisted language — no async gap, no flash of the wrong
 * language.
 */
function ensureBootLocale(): void {
  if (bootResolved) return
  bootResolved = true
  setLocale(useSettingsStore.getState().settings.language)
}

/** Snapshot of the resolved locale (React-free, for non-component callers). */
export function getLocale(): Locale {
  ensureBootLocale()
  return useLocaleStore.getState().locale
}

/**
 * Applies a language setting: resolves `language` (the CURRENT persisted
 * setting, passed in by the caller — the settings store keeps the user's
 * choice, this module only derives and holds the resolved locale) against
 * the live `navigator.language`, updates the store and mirrors the result
 * into `<html lang>` (a11y/spellcheck). Guarded for non-DOM environments
 * (node test runs import the module transitively).
 */
export function setLocale(language: LanguageSetting): void {
  // Any explicit resolution — including the test suites' pin — counts as
  // the boot resolution: a later lazy ensureBootLocale() must never undo it.
  bootResolved = true
  const navigatorLanguage = typeof navigator !== 'undefined' ? navigator.language : undefined
  const locale = resolveLocale(language, navigatorLanguage)
  useLocaleStore.setState({ locale })
  if (typeof document !== 'undefined') document.documentElement.lang = locale
}

/** Keys whose missing-translation warning already fired (once per key). */
const warnedKeys = new Set<string>()

/**
 * Translates `key` in the resolved locale's dictionary, with `{name}`
 * interpolation. Non-React on purpose: it reads the LIVE store snapshot on
 * every call, so hidden tabs, desktop notifications and other
 * out-of-render callers get the current locale without subscribing.
 * Falls back to the `en` dictionary when the active one lacks the key —
 * a runtime safety net the `Translations` type already makes unreachable
 * for shipped dictionaries (parity is compile-enforced) — and for a key
 * present in neither, warns once per key in dev and echoes the key itself
 * (never an empty string: a missing translation must stay visible).
 * Unknown placeholders in params are left as-is.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[getLocale()]
  const template: string | undefined = Object.hasOwn(dictionary, key) ? dictionary[key] : en[key]
  if (template === undefined) {
    if (import.meta.env.DEV && !warnedKeys.has(key)) {
      warnedKeys.add(key)
      console.warn(`[i18n] missing translation key: ${key}`)
    }
    return key
  }
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  )
}

/**
 * Plural form of `t`: picks the `${base}One` key when `count === 1` and
 * the `${base}Other` key otherwise — the `…One`/`…Other` dictionary
 * convention (English and Spanish only distinguish those two CLDR forms;
 * see ./en). `count` is injected into the params automatically, so the
 * conventional `{count}` placeholder renders the number without the caller
 * repeating it. `base` is a key PREFIX, so the composite key is typed
 * loosely (`string` cast into `TranslationKey`) — parity for both forms is
 * the dictionary author's compile-enforced duty.
 */
export function tPlural(
  base: string,
  count: number,
  params?: Record<string, string | number>,
): string {
  const key = `${base}${count === 1 ? 'One' : 'Other'}` as TranslationKey
  return t(key, { ...params, count })
}

/**
 * React binding: subscribes the component to the resolved locale (a switch
 * re-renders every consumer) and returns `t` itself — the returned function
 * reads the live snapshot, so no remount, memo or prop pass-through is
 * ever needed to observe a locale change.
 */
export function useT(): typeof t {
  useLocaleStore((state) => state.locale)
  return t
}

// Boot locale: resolved lazily by ensureBootLocale() on the first `t` /
// `getLocale` call (see its docblock for why this is not a module-load
// init). Every read path — `t`, `tPlural`, `getLocale`, and therefore
// `useT`'s subscribed components — funnels through it.
