import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'

/**
 * UI state that survives reloads — spec §8.2 key `gritos:ui`
 * (`{sidebarCollapsed: boolean}` §10.1). Kept deliberately separate from
 * the settings store so each `gritos:*` key maps 1:1 to its spec row.
 */

export const UI_STORAGE_KEY = 'gritos:ui'

export interface UiPersisted {
  sidebarCollapsed: boolean
}

export const DEFAULT_UI: UiPersisted = { sidebarCollapsed: false }

export interface UiStore extends UiPersisted {
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
}

/** Same defensive raw-JSON storage as the settings store (§8.2). */
const uiStorage: PersistStorage<UiPersisted> = {
  getItem: (name) => {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(name)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as Partial<UiPersisted>
      return { state: { ...DEFAULT_UI, ...parsed } }
    } catch {
      return null
    }
  },
  setItem: (name, value) => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(name, JSON.stringify(value.state))
  },
  removeItem: (name) => {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(name)
  },
}

export const useUiStore = create<UiStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: DEFAULT_UI.sidebarCollapsed,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    {
      name: UI_STORAGE_KEY,
      storage: uiStorage,
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<UiPersisted>),
      }),
    },
  ),
)
