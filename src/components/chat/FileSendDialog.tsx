import { useState } from 'react'
import { Modal } from '../common/Modal'
import { formatFileSize } from '../../lib/fileSize'
import { useT } from '../../i18n/index'
import { fileRecipientDmText, fileRefusalText } from '../settings/messages'
import type { SendFileOutcome } from '../../lib/p2p/fileTransfer'

/**
 * Issue #103 phase 4 — the pre-send dialog behind the composer's attachment
 * button (room and DM modes, §12.4's explicit consent on the SENDING side
 * too): a styled file picker, then the file's name/size/mime, the
 * encryption notice — room key for a password room, the exact §12.4
 * DTLS-only warning for a public room, DM key in DM mode — and the recipient
 * scope: a native select (the TTL-selector precedent, keyboard-operable by
 * construction) limited to the room's connected peers in room mode, the
 * fixed peer in DM mode. Send delegates to the caller's seam (the real
 * engine through `useFileTransfers`) and closes on success; a local refusal
 * surfaces inline with the engine's own reason wording and the dialog stays
 * open to correct the pick. Cancel, Esc and the backdrop all close without
 * sending anything. Manual (trackerless) DM channels never open this
 * dialog: the file engine rides Trystero rooms only (issue #97 separation).
 */
export function FileSendDialog(props: {
  open: boolean
  onClose: () => void
  /**
   * Sends the chosen file to `peerId`. Resolves the engine's outcome: `ok`
   * closes the dialog, a refusal shows its inline line.
   */
  onSend: (peerId: string, file: File) => Promise<SendFileOutcome>
  /** Room mode: the swarm to offer on. */
  roomId?: string
  /** Room mode: connected peers only (§12.4 — directed 1:1, no broadcast). */
  peers?: ReadonlyArray<{ id: string; nickname: string }>
  /** Room mode: true for a password room (room-key notice), false = public. */
  encryptedRoom?: boolean
  /** DM mode: the fixed recipient; no selector, DM-key notice. */
  dmPeer?: { peerId: string; nickname: string }
}) {
  const t = useT()
  const [file, setFile] = useState<File | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [peerId, setPeerId] = useState<string | null>(props.peers?.[0]?.id ?? null)

  // Every open is a fresh decision: the previous file, refusal and peer
  // pick never survive a close (memory-only, like the TTL selector). Every
  // exit path — the Cancel button, Esc and the backdrop — funnels through
  // here, so resetting on close is complete without an open-transition
  // effect.
  const resetAndClose = () => {
    setFile(null)
    setRefusal(null)
    setSending(false)
    setPeerId(props.peers?.[0]?.id ?? null)
    props.onClose()
  }

  const dmMode = props.dmPeer !== undefined
  const encryptionNotice = dmMode
    ? t('files.encNoticeDm')
    : props.encryptedRoom === true
      ? t('files.encNoticeRoom')
      : t('files.encWarningPublic')

  const noPeers = !dmMode && (props.peers === undefined || props.peers.length === 0)

  const handleSend = async () => {
    const target = dmMode ? props.dmPeer?.peerId : peerId
    if (file === null || target === undefined || target === null || sending) return
    setSending(true)
    try {
      const outcome = await props.onSend(target, file)
      if (outcome.ok) {
        resetAndClose()
      } else {
        setRefusal(fileRefusalText(outcome.reason))
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open={props.open}
      onClose={resetAndClose}
      label={t('files.dialogLabel')}
      className="w-full max-w-md rounded-lg border border-border bg-surface p-4 outline-none"
    >
      <h2 className="text-base font-semibold">{t('files.dialogLabel')}</h2>

      {/* The picker rides first (the meta below appears once a file is
          chosen); the input is sr-only and the styled label is the
          affordance — keyboard users reach the real input directly. */}
      <label className="mt-3 flex cursor-pointer items-center justify-center rounded-md border border-dashed border-border px-3 py-3 text-sm hover:border-accent">
        <input
          type="file"
          aria-label={t('files.pickLabel')}
          className="sr-only"
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            if (chosen !== undefined) {
              setFile(chosen)
              setRefusal(null)
            }
            // Picking the same file again must re-fire the change.
            event.target.value = ''
          }}
        />
        <span aria-hidden="true">{t('files.pickLabel')}</span>
      </label>

      {file !== null && (
        <p data-testid="file-meta-line" className="mt-2 text-sm">
          <span className="font-medium">{file.name}</span>{' '}
          <span className="text-xs text-muted">{formatFileSize(file.size)}</span>
          {' · '}
          <span className="text-xs text-muted">
            {file.type !== '' ? file.type : t('files.unknownMime')}
          </span>
        </p>
      )}

      <p className="mt-2 text-xs text-muted">{encryptionNotice}</p>

      {dmMode ? (
        <p className="mt-2 text-sm">{fileRecipientDmText(props.dmPeer?.nickname ?? '')}</p>
      ) : noPeers ? (
        <p className="mt-2 text-xs text-accent">{t('files.noPeers')}</p>
      ) : (
        <select
          aria-label={t('files.recipientLabel')}
          value={peerId ?? ''}
          onChange={(event) => setPeerId(event.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm focus:border-accent"
        >
          {props.peers?.map((peer) => (
            <option key={peer.id} value={peer.id}>
              {peer.nickname}
            </option>
          ))}
        </select>
      )}

      {refusal !== null && (
        <p role="status" className="mt-2 text-xs text-accent">
          {refusal}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={resetAndClose}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          data-testid="file-dialog-send"
          disabled={file === null || noPeers || sending}
          onClick={() => void handleSend()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text hover:opacity-90 disabled:opacity-40"
        >
          {t('files.sendButton')}
        </button>
      </div>
    </Modal>
  )
}
