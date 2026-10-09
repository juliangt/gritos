import { Modal } from './Modal'
import { useT } from '../../i18n/index'

/**
 * Confirmation dialog (RF-07/RF-08): used for destructive actions
 * (identity regeneration, panic button). Focus starts on the cancel
 * button — the safe choice — and Esc/backdrop/cancel all abort. The
 * default cancel label resolves through `t` on every render (issue #119 —
 * a module-level default would freeze the boot locale).
 */
export function ConfirmDialog(props: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
  /** Red destructive styling on the confirm button (RF-08). */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  return (
    <Modal open={props.open} onClose={props.onCancel} label={props.title}>
      <h2 className="text-base font-semibold">{props.title}</h2>
      <p className="mt-2 text-sm text-text">{props.body}</p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent"
        >
          {props.cancelLabel ?? t('common.cancel')}
        </button>
        <button
          type="button"
          data-testid="confirm-dialog-confirm"
          onClick={props.onConfirm}
          className={
            props.danger === true
              ? 'rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500'
              : 'rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:opacity-90'
          }
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
