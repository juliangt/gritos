import type { ThemeChoice } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import {
  setLanguagePreference,
  useT,
  type LanguageSetting,
  type TranslationKey,
} from '../../i18n/index'
import { Toggle } from './Toggle'

/**
 * Appearance tab (RF-07/RF-10): the theme radio group — the settings store
 * is the single source of truth and useTheme applies it live — the UI
 * language picker (issue #119) and the initial sidebar collapsed state from
 * `gritos:ui`. Labels resolve through `t` at render time (issue #119); the
 * persisted ThemeChoice VALUES ('light'/'dark'/'system') and the
 * LanguageSetting VALUES ('auto'/'en'/'es') are data and stay literal.
 */

const THEME_OPTIONS: { value: ThemeChoice; labelKey: TranslationKey }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
]

/**
 * Issue #119 — the language picker's options in persisted-value order. Only
 * 'Auto' translates (`settings.languageAuto`); 'English'/'Español' are
 * endonyms that render in their own language under every locale, so they
 * stay literal (see the dictionary note on `settings.languageLabel`).
 */
const LANGUAGE_OPTIONS: {
  value: LanguageSetting
  labelKey: TranslationKey | null
  label: string
}[] = [
  { value: 'auto', labelKey: 'settings.languageAuto', label: '' },
  { value: 'en', labelKey: null, label: 'English' },
  { value: 'es', labelKey: null, label: 'Español' },
]

export function AppearanceTab() {
  const t = useT()
  const settings = useSettingsStore((state) => state.settings)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('settings.themeLabel')}</legend>
        <div className="flex flex-col gap-1">
          {THEME_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="theme"
                value={option.value}
                checked={settings.theme === option.value}
                onChange={() => setSettings({ theme: option.value })}
                className="size-4 accent-[var(--color-accent)]"
              />
              {t(option.labelKey)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">{t('settings.languageLabel')}</legend>
        <select
          value={settings.language}
          // Issue #119 invariant: one helper writes the setting AND applies
          // the locale (store-only writes would need a reload to show).
          onChange={(event) => setLanguagePreference(event.target.value as LanguageSetting)}
          aria-label={t('settings.languageLabel')}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm focus:border-accent"
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.labelKey === null ? option.label : t(option.labelKey)}
            </option>
          ))}
        </select>
      </fieldset>

      <div className="border-t border-border pt-3">
        <Toggle
          label={t('settings.collapseSidebarLabel')}
          checked={sidebarCollapsed}
          onChange={setSidebarCollapsed}
        />
      </div>
    </div>
  )
}
