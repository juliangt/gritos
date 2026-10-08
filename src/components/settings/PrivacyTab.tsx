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
 * consent (issue #102), the local mute list with per-row unmute (issue
 * #95), the P2P exposure disclosure (issue #35), an at-rest storage note
 * for the wrapped identity key (issue #24) and for the TURN credentials
 * (issue #30), identity regeneration behind a confirming dialog, and the
 * panic button behind a double confirmation.
 */

const PERMISSION_GRANTED_TEXT = 'Permiso concedido.'
const PERMISSION_DEFAULT_TEXT = 'Permiso no solicitado.'
const PERMISSION_DENIED_TEXT = 'Permiso denegado. Actívalo desde la configuración del navegador.'
const PERMISSION_UNSUPPORTED_TEXT = 'Tu navegador no soporta notificaciones.'

const REGENERATE_DIALOG_TITLE = 'Regenerar identidad'
const REGENERATE_DIALOG_BODY =
  'Se generará un nuevo par de claves: tu fingerprint cambiará y los canales DM con tus pares dejarán de coincidir. ¿Continuar?'

const PANIC_BUTTON_LABEL = 'Borrar todo y salir'
const PANIC_DIALOG_TITLE = PANIC_BUTTON_LABEL
const PANIC_DIALOG_BODY = 'Se borrarán apodo, claves, ajustes y todo rastro local. ¿Continuar?'
const PANIC_FINAL_DIALOG_BODY =
  'Esta acción es definitiva: se cerrarán todas las conexiones y la aplicación se recargará para empezar de cero.'

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
          label="Notificaciones de escritorio"
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
          Permitir notificaciones
        </button>
      </div>

      <Toggle
        label="Recordar salas recientes"
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
          {TURN_CREDENTIAL_STORAGE_HINT} Se configuran en la pestaña Red; desactiva allí «Recordar
          credenciales TURN en este navegador» para que solo vivan en la memoria de la sesión.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Tu clave privada se guarda cifrada en este navegador: la clave que la descifra vive en
          IndexedDB y nada viaja por la red. Aun así, si algo compromete por completo este origen
          (una extensión maliciosa, malware en tu equipo) podría usar esa clave para suplantarte.
        </p>
        <p className="text-xs text-muted">
          Genera un nuevo par de claves ECDH: tu fingerprint cambiará para todos tus pares.
        </p>
        <button
          type="button"
          onClick={() => setRegenerateDialogOpen(true)}
          disabled={regenerating}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50"
        >
          Regenerar identidad
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Último recurso: borra apodo, claves, ajustes y todo rastro local en este navegador.
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
        confirmLabel="Regenerar"
        danger
        onConfirm={() => void confirmRegenerate()}
        onCancel={() => setRegenerateDialogOpen(false)}
      />

      <ConfirmDialog
        open={panicDialogOpen}
        title={PANIC_DIALOG_TITLE}
        body={PANIC_DIALOG_BODY}
        confirmLabel="Continuar"
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
