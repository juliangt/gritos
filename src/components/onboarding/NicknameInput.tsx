import { NICKNAME_MAX_LENGTH } from '../../lib/nickname'

/**
 * Onboarding nickname field (RF-01): keeps the raw text (trim/collapse
 * happens at validation), reports the inline validation error and surfaces
 * the 2–24 character limit to assistive tech.
 */
export function NicknameInput(props: {
  value: string
  onValueChange: (value: string) => void
  error: string | null
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label="Your nickname"
        name="nickname"
        autoComplete="off"
        spellCheck={false}
        maxLength={NICKNAME_MAX_LENGTH + 16}
        placeholder="e.g. zorro-bravo"
        value={props.value}
        disabled={props.disabled === true}
        aria-invalid={props.error !== null}
        onChange={(event) => props.onValueChange(event.target.value)}
        className="w-full rounded-md border border-border bg-surface px-3 py-2 text-base focus:border-accent"
      />
      {props.error !== null && (
        <p role="alert" className="text-xs text-accent">
          {props.error}
        </p>
      )}
    </div>
  )
}
