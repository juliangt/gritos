import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Accessible modal base (RNF-05): rendered into a portal over a backdrop,
 * with `role="dialog"` + `aria-modal`, a Tab focus trap, Esc to close and
 * focus restored to the opener on close/unmount. Backdrop clicks close.
 *
 * Stacked modals (the ConfirmDialog over the SettingsModal) coordinate
 * through a module-level open stack: only the topmost open modal reacts to
 * Esc, so confirming a dialog never dismisses the settings modal behind it.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Open modal tokens in mount order — the last entry is the fallback top. */
const openModals: symbol[] = []

export interface ModalProps {
  open: boolean
  /** Called on Esc and on backdrop clicks (never on inside clicks). */
  onClose: () => void
  /** Accessible name of the dialog (aria-label). */
  label: string
  children: ReactNode
  /** Additional classes for the dialog panel. */
  className?: string
}

export function Modal(props: ModalProps) {
  const { open, onClose, label } = props
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const tokenRef = useRef<symbol | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return

    const token = Symbol('modal')
    tokenRef.current = token
    openModals.push(token)
    openerRef.current = document.activeElement as HTMLElement | null

    // Initial focus lands on the first focusable element (or the panel
    // itself when the content has none). A dialog mounted INSIDE another
    // dialog (nested portals: ConfirmDialog over SettingsModal) focuses
    // first in effect order — the outer one must not steal it back.
    const dialog = dialogRef.current
    const active = document.activeElement
    const focusInsideAnotherDialog =
      active !== null &&
      active !== document.body &&
      dialog !== null &&
      !dialog.contains(active) &&
      active.closest('[role="dialog"]') !== null
    if (!focusInsideAnotherDialog) {
      const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(firstFocusable ?? dialog)?.focus()
    }

    // Esc and the Tab trap only act when the focus lives inside THIS panel;
    // when the focus escaped to <body> the fallback is the last-mounted
    // modal. Nested dialogs therefore close topmost-first.
    const ownsKeyEvent = (): boolean => {
      const panel = dialogRef.current
      if (panel !== null && panel.contains(document.activeElement)) return true
      return openModals[openModals.length - 1] === token
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (!ownsKeyEvent()) return
        // Both stacked modals listen on document (capture); handling Esc here
        // must not let outer dialogs close in the same dispatch.
        event.stopImmediatePropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const panel = dialogRef.current
      const focusable = Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])
      if (focusable.length === 0) return
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || active === null || !panel?.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || active === null || !panel?.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const index = openModals.indexOf(token)
      if (index !== -1) openModals.splice(index, 1)
      tokenRef.current = null
      // Restore focus to the opener (RF-07/RNF-05) when it still exists.
      openerRef.current?.focus?.()
      openerRef.current = null
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={
          props.className ??
          'w-full max-w-sm rounded-lg border border-border bg-surface p-4 outline-none'
        }
      >
        {props.children}
      </div>
    </div>,
    document.body,
  )
}
