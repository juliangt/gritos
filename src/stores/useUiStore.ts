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

/**
 * Issue #99 — session-only UI seams the slash-command executor flips. Never
 * persisted (`partialize` keeps only `sidebarCollapsed`): they describe
 * transient intents (open a popover, show an overlay, confirm a wipe, offer
 * a password form) that must die with the tab.
 */
export interface UiSession {
  /** Room name the sidebar's JoinRoomPopover opens prefilled with; null = closed. */
  joinPopoverName: string | null
  /** The /ayuda overlay. */
  helpOpen: boolean
  /** The /limpiar confirmation dialog. */
  clearFeedOpen: boolean
  /**
   * Room joined by name whose join may still need its password (the issue
   * #41 recovery pattern, armed by /sala): ChatLayout offers the prefilled
   * password form when that room exhausts the not-found heuristic.
   */
  recoveryRoom: string | null
}

export interface UiStore extends UiPersisted, UiSession {
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleSidebar: () => void
  /** /sala on a room that may need a password: opens the popover prefilled. */
  openJoinPopover: (name: string) => void
  closeJoinPopover: () => void
  openHelp: () => void
  closeHelp: () => void
  /** /limpiar: opens the confirmation; the dialog owns the actual wipe. */
  requestClearFeed: () => void
  cancelClearFeed: () => void
  /** /sala joined a room by name: arm its password-recovery offer. */
  armPasswordRecovery: (name: string) => void
  clearPasswordRecovery: () => void
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
      joinPopoverName: null,
      helpOpen: false,
      clearFeedOpen: false,
      recoveryRoom: null,
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      openJoinPopover: (joinPopoverName) => set({ joinPopoverName }),
      closeJoinPopover: () => set({ joinPopoverName: null }),
      openHelp: () => set({ helpOpen: true }),
      closeHelp: () => set({ helpOpen: false }),
      requestClearFeed: () => set({ clearFeedOpen: true }),
      cancelClearFeed: () => set({ clearFeedOpen: false }),
      armPasswordRecovery: (recoveryRoom) => set({ recoveryRoom }),
      clearPasswordRecovery: () => set({ recoveryRoom: null }),
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
