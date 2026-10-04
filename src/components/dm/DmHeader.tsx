import { useState } from 'react'
import type { DmChannel } from '../../stores/useAppStore'
import {
  DM_DISCONNECTED_TEXT,
  DM_KEY_CHANGED_HINT,
  DM_KEY_CHANGED_WARNING,
  DM_VERIFY_NOTICE,
} from '../../lib/feed'
import { SettingsModal } from '../settings/SettingsModal'

/**
 * DM header (spec RF-04/§10.1): the peer's nickname, its fingerprint in the
 * 4×4 format with the exact TOFU verification notice, and the connection
 * state — while the peer shares a room the header mirrors the room peer
 * count; once it left every shared room it shows the exact disconnected
 * text instead. Issue #22: when the channel is flagged `keyChanged` (the
 * peer's live fingerprint differs from the pinned first-seen one) a visible
 * warning replaces the verification notice; it is advisory — the pinned
 * fingerprint stays displayed and messages keep flowing.
 */
export function DmHeader(props: { channel: DmChannel | null; onToggleSidebar: () => void }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const channel = props.channel

  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button
        type="button"
        onClick={props.onToggleSidebar}
        aria-label="Mostrar u ocultar la barra lateral"
        title="Mostrar u ocultar la barra lateral (Ctrl/Cmd+B)"
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
              {channel.available ? '1 par' : DM_DISCONNECTED_TEXT}
            </span>
          </div>
          <p className="truncate text-xs text-muted">
            <span className="font-mono">{channel.peerFingerprint ?? '— — —'}</span>
            <span>{' · '}</span>
            <span>{channel.keyChanged ? DM_KEY_CHANGED_WARNING : DM_VERIFY_NOTICE}</span>
          </p>
          {channel.keyChanged && (
            <p className="text-xs text-accent" role="alert">
              {DM_KEY_CHANGED_HINT}
            </p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        aria-label="Ajustes"
        title="Ajustes"
        className="ml-auto rounded px-1.5 py-1 text-base leading-none hover:bg-bg"
      >
        ⚙
      </button>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
