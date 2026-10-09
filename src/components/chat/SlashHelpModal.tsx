import { Modal } from '../common/Modal'
import { SLASH_COMMANDS } from '../../lib/slashCommands'
import { useT } from '../../i18n/index'

/**
 * /help overlay (issue #99; English copy per issue #112): a small modal
 * listing the v1 slash commands straight from the parser's SLASH_COMMANDS
 * table — verb, usage and the one-line English help — plus the `\/`
 * escape-hatch explanation the issue requires documented here. Focus trap,
 * Esc and backdrop-close come from the shared Modal base; keyboard-only by
 * construction (RNF-05).
 */
export function SlashHelpModal(props: { open: boolean; onClose: () => void }) {
  const t = useT()
  return (
    <Modal open={props.open} onClose={props.onClose} label={t('slash.helpLabel')}>
      <h2 className="text-base font-semibold">{t('slash.helpTitle')}</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {SLASH_COMMANDS.map((command) => (
          <li key={command.verb} className="text-sm">
            <code className="font-mono text-text">{command.usage}</code>
            <p className="text-muted">{command.help}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">{t('slash.helpEscapeHint')}</p>
    </Modal>
  )
}
