import { useEffect, useMemo, useRef } from 'react'
import { Modal } from '../common/Modal'
import { buildQrMatrix } from '../../lib/qr'
import { QR_ONSCREEN_MODULE_PX, downloadQrPng, paintQr } from '../../lib/qrCanvas'
import { buildRoomLink } from '../../lib/shareLinks'
import { useT } from '../../i18n/index'
import { qrCanvasLabel } from '../settings/messages'
import type { Room } from '../../stores/useAppStore'

/**
 * Issue #100 (Phase 2) — the QR invite popover behind the header's 'QR'
 * button: the exact share link (`buildRoomLink`, room name only — RF-05)
 * rendered as a canvas QR plus the link text below as a selectable fallback
 * and a 'Descargar PNG' export.
 *
 * It reuses the `Modal` primitive (not the inline JoinRoomPopover shape):
 * the QR is a modal read-only surface, and Modal already provides the
 * role="dialog" naming, the Tab focus trap, Esc/backdrop close and the
 * focus return to the opener. The canvas colors are theme-independent on
 * purpose — see `lib/qrCanvas.ts` (scannability trumps theme).
 */
export function QrSharePopover(props: { room: Room; open: boolean; onClose: () => void }) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Exactly the string the share button copies — never any password.
  const link = useMemo(() => buildRoomLink(props.room.name), [props.room.name])
  const matrix = useMemo(() => buildQrMatrix(link), [link])

  // Paint once the dialog is mounted (the canvas only exists while open).
  // Without a 2D context (jsdom) paintQr no-ops and the link fallback below
  // stays the usable surface.
  useEffect(() => {
    if (!props.open) return
    const canvas = canvasRef.current
    if (canvas === null) return
    paintQr(canvas, matrix, QR_ONSCREEN_MODULE_PX)
  }, [props.open, matrix])

  return (
    <Modal open={props.open} onClose={props.onClose} label={t('qr.dialogLabel')}>
      <div className="flex flex-col items-center gap-3">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={qrCanvasLabel(props.room.name)}
          className="h-44 w-44 rounded border border-border bg-surface"
        />
        <p className="select-all break-all text-center font-mono text-xs text-muted">{link}</p>
        <p className="text-center text-xs text-muted">{t('qr.sameInstallNote')}</p>
        <button
          type="button"
          onClick={() => downloadQrPng(link, props.room.name)}
          className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text"
        >
          {t('qr.downloadButton')}
        </button>
      </div>
    </Modal>
  )
}
