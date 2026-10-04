import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../../hooks/useFocusTrap'

/**
 * Accessible modal base (RNF-05): rendered into a portal over a backdrop,
 * with `role="dialog"` + `aria-modal`, a Tab focus trap, Esc to close and
 * focus restored to the opener on close/unmount. Backdrop clicks close.
 *
 * Stacked modals (the ConfirmDialog over the SettingsModal) coordinate
 * through a module-level open stack: only the topmost open modal reacts to
 * Esc, so confirming a dialog never dismisses the settings modal behind it.
 * (The trap/Esc/focus coordination is shared with the mobile drawer in
 * `useFocusTrap`.)
 */

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
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useFocusTrap({
    open,
    panelRef: dialogRef,
    onEscape: () => onCloseRef.current(),
  })

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
