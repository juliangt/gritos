import { useEffect, useSyncExternalStore } from 'react'
import type { ThemeChoice } from '../stores/useAppStore'
import { useSettingsStore } from '../stores/useSettingsStore'

export type ResolvedTheme = 'light' | 'dark'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeToColorScheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** Resolves 'system' against the live OS preference (RF-10). */
export function resolveTheme(
  theme: ThemeChoice,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light'
  return theme
}

/**
 * Theme foundation (RF-10 / spec §10.6): applies the resolved theme as the
 * `dark` class on <html> — Tailwind 4 class strategy via the
 * `@custom-variant dark` declared in styles/index.css — and keeps it in
 * live sync with prefers-color-scheme, without reloading or losing state.
 * The anti-flash inline script in index.html seeds the same class before
 * this hook runs, so there is no flash on load.
 */
export function useTheme(): ResolvedTheme {
  const theme = useSettingsStore((state) => state.settings.theme)
  const systemPrefersDark = useSyncExternalStore(
    subscribeToColorScheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  )
  const resolved = resolveTheme(theme, systemPrefersDark)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
  }, [resolved])

  return resolved
}
