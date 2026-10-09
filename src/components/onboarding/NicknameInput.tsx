import { NICKNAME_MAX_LENGTH } from '../../lib/nickname'
import { useT } from '../../i18n/index'

/**
 * Onboarding nickname field (RF-01): keeps the raw text (trim/collapse
 * happens at validation), reports the inline validation error and surfaces
 * the 2–24 character limit to assistive tech. The placeholder's
 * 'zorro-bravo' example is DATA (an English-wordlist pair, like anything
 * `generateNickname` may produce) — only the surrounding 'e.g.' translates
 * (issue #119).
 */
export function NicknameInput(props: {
  value: string
  onValueChange: (value: string) => void
  error: string | null
  disabled?: boolean
}) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label={t('common.yourNickname')}
        name="nickname"
        autoComplete="off"
        spellCheck={false}
        maxLength={NICKNAME_MAX_LENGTH + 16}
        placeholder={t('onboarding.nicknamePlaceholder')}
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
