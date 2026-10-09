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
import { useT, type TranslationKey } from '../../i18n/index'
import { unmutePeerAction } from './messages'

/**
 * Privacy tab (RF-07/RF-08): the notifications toggle with its
 * permission request flow, remember-recents, the opt-in history-gossip
 * consent (issue #102), the opt-in global-DM channel with its honest
 * §9.5 exposure disclosure (issue #105), the local mute list with per-row
 * unmute (issue #95), the P2P exposure disclosure (issue #35), an at-rest
 * storage note for the wrapped identity key (issue #24) and for the TURN
 * credentials (issue #30), identity regeneration behind a confirming
 * dialog, and the panic button behind a double confirmation. Every rendered
 * string resolves through `t` (issue #119 — locale-live).
 */

/** Issue #95 — canonical fingerprint shortened to its first two 8×4 display
 * groups: enough to tell entries apart without printing the 39-char form. */
function shortFingerprint(canonical: string): string {
  const grouped = canonical.replace(/(.{4})(?=.)/g, '$1 ')
  return `${grouped.split(' ').slice(0, 2).join(' ')}…`
}

/** NotificationPermissionState → dictionary key (resolved through `t`). */
function permissionKey(state: NotificationPermissionState): TranslationKey {
  switch (state) {
    case 'granted':
      return 'settings.permissionGranted'
    case 'denied':
      return 'settings.permissionDenied'
    case 'unsupported':
      return 'settings.permissionUnsupported'
    default:
      return 'settings.permissionDefault'
  }
}

export function PrivacyTab() {
  const t = useT()
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
          label={t('settings.notificationsLabel')}
          checked={settings.notifications}
          disabled={permission !== 'granted'}
          hint={t(permissionKey(permission))}
          onChange={(notifications) => setSettings({ notifications })}
        />
        <button
          type="button"
          onClick={() => void askPermission()}
          disabled={permission !== 'default'}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          {t('settings.allowNotifications')}
        </button>
      </div>

      <Toggle
        label={t('settings.rememberRoomsLabel')}
        checked={settings.rememberRooms}
        onChange={(rememberRooms) => setSettings({ rememberRooms })}
      />

      {/* Issue #102 — opt-in history gossip: default silence. The flag rides
          `gritos:settings`; only an explicit peer request can ever pull
          history, and only while the consent is on. */}
      <Toggle
        label={t('settings.shareHistoryLabel')}
        checked={settings.shareHistory}
        hint={t('settings.shareHistoryHint')}
        onChange={(shareHistory) => setSettings({ shareHistory })}
      />

      {/* Issue #105 (spec §12.5) — the global-DM opt-in: flipping the setting
          is ALL this does; the signal-channel manager's module-level
          subscription performs the actual swarm join/leave (and its teardown
          of the signal-backed channels), so the UI stays declarative. The
          hint is the honest §9.5 exposure disclosure. */}
      <Toggle
        label={t('contact.toggleLabel')}
        checked={settings.globalDm}
        hint={t('contact.toggleHint')}
        onChange={(globalDm) => setSettings({ globalDm })}
      />

      {/* Issue #95 — the local mute list: fingerprints persisted in
          `gritos:settings` with their last-seen nickname when known this
          session (the map rides memory-only); each row unmutes. */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <h3 className="text-sm font-semibold">{t('settings.mutedPeersHeading')}</h3>
        {settings.mutedFingerprints.length === 0 ? (
          <p className="text-xs text-muted">{t('settings.emptyMutedPeers')}</p>
        ) : (
          <>
            <p className="text-xs text-muted">{t('settings.mutedPeersHint')}</p>
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
                      {t('common.unmute')}
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
        <p className="text-xs text-muted">{t('settings.p2pIpExposureNote')}</p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">{t('settings.turnCredentialAtRestNote')}</p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">{t('settings.identityKeyAtRestNote')}</p>
        <p className="text-xs text-muted">{t('settings.regenerateHint')}</p>
        <button
          type="button"
          onClick={() => setRegenerateDialogOpen(true)}
          disabled={regenerating}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          {t('settings.regenerateIdentity')}
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">{t('panic.lastResortNote')}</p>
        <button
          type="button"
          onClick={() => setPanicDialogOpen(true)}
          className="self-start rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-500"
        >
          {t('panic.buttonLabel')}
        </button>
      </div>

      <ConfirmDialog
        open={regenerateDialogOpen}
        title={t('settings.regenerateIdentity')}
        body={t('settings.regenerateDialogBody')}
        confirmLabel={t('settings.regenerateConfirm')}
        danger
        onConfirm={() => void confirmRegenerate()}
        onCancel={() => setRegenerateDialogOpen(false)}
      />

      <ConfirmDialog
        open={panicDialogOpen}
        title={t('panic.buttonLabel')}
        body={t('panic.dialogBody')}
        confirmLabel={t('common.continue')}
        danger
        onConfirm={() => {
          setPanicDialogOpen(false)
          setPanicFinalOpen(true)
        }}
        onCancel={() => setPanicDialogOpen(false)}
      />

      <ConfirmDialog
        open={panicFinalOpen}
        title={t('panic.buttonLabel')}
        body={t('panic.finalDialogBody')}
        confirmLabel={t('panic.buttonLabel')}
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
