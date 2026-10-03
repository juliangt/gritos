import { useEffect } from 'react'

/**
 * Placeholder — implemented in M5 (RF-07): modal with Network / Privacy /
 * Appearance tabs, focus trap and Esc to close (RNF-05). The M3 shell only
 * needs the shared chrome (Esc closes, backdrop click closes) so both the
 * room and DM headers mount the same entry point.
 */
export function SettingsModal(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ajustes"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-4"
      >
        <h2 className="text-base font-semibold">Ajustes</h2>
        <p className="mt-2 text-sm text-muted">
          El panel de ajustes (red, privacidad y apariencia) llega en la entrega M5.
        </p>
        <button
          type="button"
          onClick={props.onClose}
          autoFocus
          className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text"
        >
          Cerrar
        </button>
      </div>
    </div>
  )
}
