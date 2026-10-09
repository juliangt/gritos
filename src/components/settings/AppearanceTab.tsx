import type { ThemeChoice } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { Toggle } from './Toggle'

/**
 * Appearance tab (RF-07/RF-10): the theme radio group — the settings store
 * is the single source of truth and useTheme applies it live — and the
 * initial sidebar collapsed state from `gritos:ui`.
 */

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

export function AppearanceTab() {
  const settings = useSettingsStore((state) => state.settings)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Theme</legend>
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
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="border-t border-border pt-3">
        <Toggle
          label="Collapse sidebar on start"
          checked={sidebarCollapsed}
          onChange={setSidebarCollapsed}
        />
      </div>
    </div>
  )
}
