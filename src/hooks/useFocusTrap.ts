import { useEffect, useRef, type RefObject } from 'react'

/**
 * Shared focus trap for dialog surfaces (RNF-05): while `open`, focus moves
 * to the first focusable element of the panel (or the panel itself when the
 * content has none), Tab and Shift+Tab cycle inside it and focus returns to
 * the opener on close/unmount. Esc closes through `onEscape` only when this
 * dialog owns the key event (focus inside the panel, or it is the topmost
 * open dialog), so stacked dialogs (the ConfirmDialog over the
 * SettingsModal) close topmost-first. Extracted verbatim from the Modal
 * implementation (issue #48: the mobile drawer needs the same trap).
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open dialog tokens in mount order — the last entry is the fallback top. */
const openDialogs: symbol[] = []

export interface FocusTrapOptions {
  /** Whether the dialog is currently shown. */
  open: boolean
  /** The dialog panel: focus is trapped within this element. */
  panelRef: RefObject<HTMLElement | null>
  /** Called on Esc when this dialog owns the key event. Omit to handle Esc elsewhere. */
  onEscape?: () => void
}

export function useFocusTrap(options: FocusTrapOptions): void {
  const { open, panelRef, onEscape } = options
  const onEscapeRef = useRef(onEscape)
  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!open) return

    const token = Symbol('dialog')
    openDialogs.push(token)
    // The opener gets the focus back on close/unmount (RF-07/RNF-05).
    const opener = document.activeElement as HTMLElement | null

    // Initial focus lands on the first focusable element (or the panel
    // itself when the content has none). A dialog mounted INSIDE another
    // dialog (nested portals: ConfirmDialog over SettingsModal) focuses
    // first in effect order — the outer one must not steal it back.
    const panel = panelRef.current
    const active = document.activeElement
    const focusInsideAnotherDialog =
      active !== null &&
      active !== document.body &&
      panel !== null &&
      !panel.contains(active) &&
      active.closest('[role="dialog"]') !== null
    if (!focusInsideAnotherDialog) {
      const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(firstFocusable ?? panel)?.focus()
    }

    // Esc and the Tab trap only act when the focus lives inside THIS panel;
    // when the focus escaped to <body> the fallback is the last-mounted
    // dialog. Nested dialogs therefore close topmost-first.
    const ownsKeyEvent = (): boolean => {
      const node = panelRef.current
      if (node !== null && node.contains(document.activeElement)) return true
      return openDialogs[openDialogs.length - 1] === token
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (onEscapeRef.current === undefined) return
        if (!ownsKeyEvent()) return
        // Stacked dialogs listen on document (capture); handling Esc here
        // must not let outer dialogs close in the same dispatch.
        event.stopImmediatePropagation()
        onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const node = panelRef.current
      const focusable = Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
      if (focusable.length === 0) return
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      const current = document.activeElement
      if (event.shiftKey) {
        if (current === first || current === null || !node?.contains(current)) {
          event.preventDefault()
          last.focus()
        }
      } else if (current === last || current === null || !node?.contains(current)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = openDialogs.indexOf(token)
      if (index !== -1) openDialogs.splice(index, 1)
      // Restore focus to the opener (RF-07/RNF-05) when it still exists.
      opener?.focus?.()
    }
  }, [open, panelRef])
}
