import type { ThemeChoice } from '../../stores/useAppStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useUiStore } from '../../stores/useUiStore'
import { Toggle } from './Toggle'

/**
 * Apariencia tab (RF-07/RF-10): the theme radio group — the settings store
 * is the single source of truth and useTheme applies it live — and the
 * initial sidebar collapsed state from `gritos:ui`.
 */

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
  { value: 'system', label: 'Sistema' },
]

export function AppearanceTab() {
  const { settings, setSettings } = useSettingsStore()
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Tema</legend>
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
          label="Colapsar barra lateral al iniciar"
          checked={sidebarCollapsed}
          onChange={setSidebarCollapsed}
        />
      </div>
    </div>
  )
}
