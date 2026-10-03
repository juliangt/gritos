/**
 * Settings toggle row (RF-07): label + optional hint on the left, checkbox
 * on the right. All changes persist to their store instantly.
 */
export function Toggle(props: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <label className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-sm">
        {props.label}
        {props.hint !== undefined && (
          <span className="block text-xs text-muted">{props.hint}</span>
        )}
      </span>
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.disabled === true}
        onChange={(event) => props.onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
      />
    </label>
  )
}
