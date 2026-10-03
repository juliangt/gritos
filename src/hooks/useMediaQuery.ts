import { useSyncExternalStore } from 'react'

/**
 * Subscribes to a media query (spec §10.1: the sidebar becomes a drawer
 * at ≤768 px). Server/render fallback: false.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void) => {
    const mediaQuery = window.matchMedia(query)
    mediaQuery.addEventListener('change', onChange)
    return () => mediaQuery.removeEventListener('change', onChange)
  }
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}
