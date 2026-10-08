import { useState } from 'react'
import {
  notificationPermissionState,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '../../lib/notifications'
import { panicWipe } from '../../lib/panic'
import { getMutedNickname, useSettingsStore } from '../../stores/useSettingsStore'
import { useRoomManager } from '../../hooks/useRoomManager'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Toggle } from './Toggle'
import {
  EMPTY_MUTED_PEERS_TEXT,
  GLOBAL_DM_TOGGLE_HINT,
  GLOBAL_DM_TOGGLE_LABEL,
  MUTED_PEERS_HEADING,
  MUTED_PEERS_HINT,
  P2P_IP_EXPOSURE_NOTE,
  SHARE_HISTORY_HINT,
  SHARE_HISTORY_LABEL,
  TURN_CREDENTIAL_STORAGE_HINT,
  UNMUTE_PEER_ACTION,
  unmutePeerAction,
} from './messages'

/**
 * Privacidad tab (RF-07/RF-08): the notifications toggle with its
 * permission request flow, remember-recents, the opt-in history-gossip
 * consent (issue #102), the opt-in global-DM channel with its honest
 * §9.5 exposure disclosure (issue #105), the local mute list with per-row
 * unmute (issue #95), the P2P exposure disclosure (issue #35), an at-rest
 * storage note for the wrapped identity key (issue #24) and for the TURN
 * credentials (issue #30), identity regeneration behind a confirming
 * dialog, and the panic button behind a double confirmation.
 */

const PERMISSION_GRANTED_TEXT = 'Permission granted.'
const PERMISSION_DEFAULT_TEXT = 'Permission not requested.'
const PERMISSION_DENIED_TEXT = 'Permission denied. Enable it from the browser settings.'
const PERMISSION_UNSUPPORTED_TEXT = 'Your browser does not support notifications.'

const REGENERATE_DIALOG_TITLE = 'Regenerate identity'
const REGENERATE_DIALOG_BODY =
  'A new key pair will be generated: your fingerprint will change and the DM channels with your peers will stop matching. Continue?'

const PANIC_BUTTON_LABEL = 'Wipe everything and leave'
const PANIC_DIALOG_TITLE = PANIC_BUTTON_LABEL
const PANIC_DIALOG_BODY = 'Nickname, keys, settings and every local trace will be wiped. Continue?'
const PANIC_FINAL_DIALOG_BODY =
  'This action is definitive: every connection will be closed and the app will reload to start from scratch.'

/**
 * Issue #95 — canonical fingerprint shortened to its first two 8×4 display
 * groups: enough to tell entries apart without printing the 39-char form.
 */
function shortFingerprint(canonical: string): string {
  const grouped = canonical.replace(/(.{4})(?=.)/g, '$1 ')
  return `${grouped.split(' ').slice(0, 2).join(' ')}…`
}

function permissionText(state: NotificationPermissionState): string {
  switch (state) {
    case 'granted':
      return PERMISSION_GRANTED_TEXT
    case 'denied':
      return PERMISSION_DENIED_TEXT
    case 'unsupported':
      return PERMISSION_UNSUPPORTED_TEXT
    default:
      return PERMISSION_DEFAULT_TEXT
  }
}

export function PrivacyTab() {
  const settings = useSettingsStore((state) => state.settings)
  const setSettings = useSettingsStore((state) => state.setSettings)
  // Never bootstraps an identity: regeneration acts on the session only.
  const { regenerateIdentity, unmuteFromUi } = useRoomManager({ ensureIdentity: false })
  const [permission, setPermission] = useState<NotificationPermissionState>(() =>
    notificationPermissionState(),
  )
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false)
  const [panicDialogOpen, setPanicDialogOpen] = useState(false)
  const [panicFinalOpen, setPanicFinalOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const askPermission = async (): Promise<void> => {
    await requestNotificationPermission()
    setPermission(notificationPermissionState())
  }

  const confirmRegenerate = async (): Promise<void> => {
    setRegenerateDialogOpen(false)
    setRegenerating(true)
    try {
      await regenerateIdentity()
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Toggle
          label="Desktop notifications"
          checked={settings.notifications}
          disabled={permission !== 'granted'}
          hint={permissionText(permission)}
          onChange={(notifications) => setSettings({ notifications })}
        />
        <button
          type="button"
          onClick={() => void askPermission()}
          disabled={permission !== 'default'}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          Allow notifications
        </button>
      </div>

      <Toggle
        label="Remember recent rooms"
        checked={settings.rememberRooms}
        onChange={(rememberRooms) => setSettings({ rememberRooms })}
      />

      {/* Issue #102 — opt-in history gossip: default silence. The flag rides
          `gritos:settings`; only an explicit peer request can ever pull
          history, and only while the consent is on. */}
      <Toggle
        label={SHARE_HISTORY_LABEL}
        checked={settings.shareHistory}
        hint={SHARE_HISTORY_HINT}
        onChange={(shareHistory) => setSettings({ shareHistory })}
      />

      {/* Issue #105 (spec §12.5) — the global-DM opt-in: flipping the setting
          is ALL this does; the signal-channel manager's module-level
          subscription performs the actual swarm join/leave (and its teardown
          of the signal-backed channels), so the UI stays declarative. The
          hint is the honest §9.5 exposure disclosure. */}
      <Toggle
        label={GLOBAL_DM_TOGGLE_LABEL}
        checked={settings.globalDm}
        hint={GLOBAL_DM_TOGGLE_HINT}
        onChange={(globalDm) => setSettings({ globalDm })}
      />

      {/* Issue #95 — the local mute list: fingerprints persisted in
          `gritos:settings` with their last-seen nickname when known this
          session (the map rides memory-only); each row unmutes. */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-sm font-semibold">{MUTED_PEERS_HEADING}</h3>
        {settings.mutedFingerprints.length === 0 ? (
          <p className="text-xs text-muted">{EMPTY_MUTED_PEERS_TEXT}</p>
        ) : (
          <>
            <p className="text-xs text-muted">{MUTED_PEERS_HINT}</p>
            <ul className="flex flex-col gap-1">
              {settings.mutedFingerprints.map((fingerprint) => {
                const nickname = getMutedNickname(fingerprint)
                const shortFp = shortFingerprint(fingerprint)
                return (
                  <li key={fingerprint} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">
                      {nickname !== null && <span className="mr-2">{nickname}</span>}
                      <span className="font-mono text-xs text-muted">{shortFp}</span>
                    </span>
                    <button
                      type="button"
                      aria-label={unmutePeerAction(nickname !== null ? `@${nickname}` : shortFp)}
                      onClick={() => unmuteFromUi(fingerprint)}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                    >
                      {UNMUTE_PEER_ACTION}
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>

      {/* Issue #35 — P2P transparency: what room peers (and trackers) see. */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">{P2P_IP_EXPOSURE_NOTE}</p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">
          {TURN_CREDENTIAL_STORAGE_HINT} They are configured in the Network tab; turn off «Remember
          TURN credentials in this browser» there so they only live in the session’s memory.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Your private key is stored encrypted in this browser: the key that decrypts it lives in
          IndexedDB and nothing travels over the network. Even so, if something fully compromises
          this origin (a malicious extension, malware on your computer) it could use that key to
          impersonate you.
        </p>
        <p className="text-xs text-muted">
          Generate a new ECDH key pair: your fingerprint will change for all your peers.
        </p>
        <button
          type="button"
          onClick={() => setRegenerateDialogOpen(true)}
          disabled={regenerating}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          Regenerate identity
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Last resort: wipes the nickname, keys, settings and every local trace in this browser.
        </p>
        <button
          type="button"
          onClick={() => setPanicDialogOpen(true)}
          className="self-start rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
        >
          {PANIC_BUTTON_LABEL}
        </button>
      </div>

      <ConfirmDialog
        open={regenerateDialogOpen}
        title={REGENERATE_DIALOG_TITLE}
        body={REGENERATE_DIALOG_BODY}
        confirmLabel="Regenerate"
        danger
        onConfirm={() => void confirmRegenerate()}
        onCancel={() => setRegenerateDialogOpen(false)}
      />

      <ConfirmDialog
        open={panicDialogOpen}
        title={PANIC_DIALOG_TITLE}
        body={PANIC_DIALOG_BODY}
        confirmLabel="Continue"
        danger
        onConfirm={() => {
          setPanicDialogOpen(false)
          setPanicFinalOpen(true)
        }}
        onCancel={() => setPanicDialogOpen(false)}
      />

      <ConfirmDialog
        open={panicFinalOpen}
        title={PANIC_BUTTON_LABEL}
        body={PANIC_FINAL_DIALOG_BODY}
        confirmLabel={PANIC_BUTTON_LABEL}
        danger
        onConfirm={() => {
          setPanicFinalOpen(false)
          panicWipe()
        }}
        onCancel={() => setPanicFinalOpen(false)}
      />
    </div>
  )
}
