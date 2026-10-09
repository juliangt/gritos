import type { ThemeChoice } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { useT, type TranslationKey } from '../../i18n/index'
import { Toggle } from './Toggle'

/**
 * Appearance tab (RF-07/RF-10): the theme radio group — the settings store
 * is the single source of truth and useTheme applies it live — and the
 * initial sidebar collapsed state from `gritos:ui`. Labels resolve through
 * `t` at render time (issue #119); the persisted ThemeChoice VALUES
 * ('light'/'dark'/'system') are data and stay literal.
 */

const THEME_OPTIONS: { value: ThemeChoice; labelKey: TranslationKey }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
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
