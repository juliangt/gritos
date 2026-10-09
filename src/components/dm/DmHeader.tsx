import { useState } from 'react'
import type { DmChannel } from '../../stores/useAppStore'
import { displayFingerprint } from '../../lib/crypto/identity'
import { tPlural, useT } from '../../i18n/index'
import { SettingsModal } from '../settings/SettingsModal'

/**
 * DM header (spec RF-04/§10.1): the peer's nickname, its fingerprint in the
 * 8×4 format (128 bits, issue #23) with the exact TOFU verification notice,
 * and the connection state — while the peer shares a room the header mirrors
 * the room peer count; once it left every shared room it shows the exact
 * disconnected text instead. Issue #22: when the channel is flagged
 * `keyChanged` (the peer's live fingerprint differs from the pinned
 * first-seen one) a visible warning replaces the verification notice; it is
 * advisory — the pinned fingerprint stays displayed and messages keep
 * flowing. Issue #122: whichever form the transport stored (the room and
 * manual paths keep the spaced display string, the signal path the canonical
 * one) renders through `displayFingerprint` so every DM header shows the
 * identical spaced 8×4 groups.
 */
export function DmHeader(props: { channel: DmChannel | null; onToggleSidebar: () => void }) {
  const t = useT()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const channel = props.channel

  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button
        type="button"
        onClick={props.onToggleSidebar}
        aria-label={t('chat.toggleSidebarAria')}
        title={t('chat.toggleSidebarTitle')}
        className="rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
      >
        ☰
      </button>

      {channel === null ? (
        <h1 className="text-sm font-semibold">gritos</h1>
      ) : (
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{channel.peerNick}</h1>
            <span
              className={`shrink-0 text-xs ${channel.available ? 'text-muted' : 'text-accent'}`}
              role="status"
            >
              {channel.available
                ? tPlural('common.peerCount', 1)
                : t('dm.peerDisconnected')}
            </span>
          </div>
          <p className="truncate text-xs text-muted">
            <span className="font-mono">
              {channel.peerFingerprint === null ? '— — —' : displayFingerprint(channel.peerFingerprint)}
            </span>
            <span>{' · '}</span>
            <span>{channel.keyChanged ? t('dm.keyChangedWarning') : t('dm.verifyNotice')}</span>
          </p>
          {channel.keyChanged && (
            <p className="text-xs text-accent" role="alert">
              {t('dm.keyChangedHint')}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label={t('common.settings')}
        title={t('common.settings')}
        className="ml-auto rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
      >
        ⚙
      </button>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
