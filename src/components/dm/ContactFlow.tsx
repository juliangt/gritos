import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../common/Modal'
import { canonicalFingerprint } from '../../lib/crypto/dm'
import { buildQrMatrix } from '../../lib/qr'
import { QR_ONSCREEN_MODULE_PX, downloadContactQrPng, paintQr } from '../../lib/qrCanvas'
import { NOTE_MAX_LENGTH } from '../../lib/p2p/signalChannelConstants'
import { KnockError, knockPeer, onKnockResolved } from '../../lib/p2p/signalChannel'
import { buildContactLink } from '../../lib/shareLinks'
import { isValidFingerprint } from '../../lib/validateSettings'
import { useAppStore } from '../../stores/useAppStore'
import { useT } from '../../i18n/index'
import { contactNoteCounter, knockErrorText } from '../settings/messages'

/**
 * Issue #105 phase 3 (spec §12.5) — the contact flow behind the DmList's
 * «+ contacto» entry (the manual-wizard entry precedent: one sidebar entry
 * opening one dialog with a pick screen). Two flows:
 *
 * "My contact": the own fingerprint in the 8×4 display form, copyable
 *   (clipboard with the readonly-textarea fallback), plus a QR encoding the
 *   `#contact=<fp>` deep link — the #100 QR machinery reused
 *   (`buildQrMatrix`/`paintQr`/PNG download over `buildContactLink`) with
 *   the same-install caveat.
 * - "Contact by fingerprint": paste a fingerprint → the local canonical-form
 *   check → `knockPeer` (the manager validates presence and throws the typed
 *   `KnockError`, surfaced as its inline line) → waiting → resolved through
 *   the manager's `onKnockResolved` seam: an accept lands the user in the
 *   DM view (the manager already opened the «(global)» channel) and closes
 *   the dialog; a reject shows the inline «rechazado» state.
 *
 * The optional note is capped at the §12.5 140 raw characters AT THE INPUT
 * (`maxLength` plus an onChange slice — paste cannot smuggle an oversize
 * note); the manager re-caps and re-validates on the wire.
 *
 * a11y: the Modal carries the focus trap; every control has an accessible
 * name and progress/errors are live regions (role="status"/role="alert").
 */

/** How long the 'Copiado' feedback stays visible (ChatHeader pattern). */
const COPIED_FEEDBACK_MS = 2_000

type Screen = 'pick' | 'share' | 'knock'

type KnockStatus = 'form' | 'waiting' | 'rejected'

export function ContactFlow(props: {
  open: boolean
  onClose: () => void
  /** Canonical fingerprint prefilled into the knock form (the `#contact=` deep link). */
  initialFp?: string | null
}) {
  const t = useT()
  const { open, onClose } = props
  const identity = useAppStore((state) => state.identity)

  // A '#contact=' prefill arrives at MOUNT time only (ChatLayout consumes
  // the hash before the first render), so these lazy initializers seed the
  // knock screen directly. Every close path routes through handleClose —
  // which resets the dialog — so no reset-on-open effect is needed.
  const prefillValid = props.initialFp != null && isValidFingerprint(props.initialFp)
  const [screen, setScreen] = useState<Screen>(() => (prefillValid ? 'knock' : 'pick'))
  const [pasted, setPasted] = useState(() =>
    prefillValid ? canonicalFingerprint(props.initialFp as string) : '',
  )
  const [note, setNote] = useState('')
  const [knockStatus, setKnockStatus] = useState<KnockStatus>('form')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  // Engine events arrive from the manager after awaits; the open flag and
  // the knock this dialog is waiting on ride refs so the (stable) listener
  // never reacts for a closed dialog or a foreign fp.
  const openRef = useRef(open)
  const knockedFpRef = useRef<string | null>(null)
  const statusRef = useRef<KnockStatus>('form')
  useEffect(() => {
    openRef.current = open
  }, [open])

  const setStatus = useCallback((status: KnockStatus) => {
    statusRef.current = status
    setKnockStatus(status)
  }, [])

  /** Closed/finished → pristine dialog (no traces of the previous flow). */
  const resetFlow = useCallback(() => {
    setScreen('pick')
    setPasted('')
    setNote('')
    setStatus('form')
    setErrorText(null)
    setCopied(false)
    knockedFpRef.current = null
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [setStatus])

  /** Cancel/Esc/backdrop: reset, then let the layout close the dialog. */
  const handleClose = useCallback(() => {
    resetFlow()
    onClose()
  }, [onClose, resetFlow])

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  // The waiting state resolves through the manager's seam: an accept lands
  // the dialog in the DM view (the channel already exists — the manager
  // opened it before firing) and closes; a reject shows the inline state.
  useEffect(() => {
    return onKnockResolved((resolution) => {
      if (!openRef.current) return
      if (resolution.fp !== knockedFpRef.current) return
      if (statusRef.current !== 'waiting') return
      knockedFpRef.current = null
      if (resolution.accepted) {
        useAppStore.getState().setActiveView({ kind: 'dm', peerId: resolution.fp })
        handleClose()
      } else {
        setStatus('rejected')
      }
    })
  }, [handleClose, setStatus])

  // Exactly the string the QR encodes (the canonical fp — the spaced
  // display form never travels).
  const link = useMemo(
    () => (identity === null ? '' : buildContactLink(identity.fingerprint)),
    [identity],
  )
  const matrix = useMemo(() => (link === '' ? null : buildQrMatrix(link)), [link])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Paint once the share screen is mounted (the canvas only exists then).
  // Without a 2D context (jsdom) paintQr no-ops and the link fallback below
  // stays the usable surface.
  useEffect(() => {
    if (!open || screen !== 'share' || matrix === null) return
    const canvas = canvasRef.current
    if (canvas === null) return
    paintQr(canvas, matrix, QR_ONSCREEN_MODULE_PX)
  }, [open, screen, matrix])

  const handleCopy = () => {
    if (identity === null) return
    void navigator.clipboard
      ?.writeText(identity.fingerprint)
      .then(() => {
        setCopied(true)
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null
          setCopied(false)
        }, COPIED_FEEDBACK_MS)
      })
      .catch(() => {
        // Clipboard denied — the readonly textarea is the manual fallback.
      })
  }

  const handleKnock = () => {
    setErrorText(null)
    if (!isValidFingerprint(pasted)) {
      setErrorText(t('contact.fpInvalid'))
      return
    }
    const canonical = canonicalFingerprint(pasted)
    const trimmedNote = note.trim()
    try {
      knockPeer(canonical, trimmedNote === '' ? undefined : note)
    } catch (error) {
      setErrorText(
        error instanceof KnockError
          ? knockErrorText(error.reason)
          : knockErrorText('invalid-knock'),
      )
      return
    }
    knockedFpRef.current = canonical
    setStatus('waiting')
  }

  return (
    <Modal open={props.open} onClose={handleClose} label={t('contact.dialogLabel')}>
      <div className="flex flex-col gap-3">
        {screen === 'pick' && (
          <>
            <p className="text-xs text-muted">{t('contact.intro')}</p>
            <button
              type="button"
              onClick={() => setScreen('share')}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {t('contact.shareButton')}
            </button>
            <button
              type="button"
              onClick={() => setScreen('knock')}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {t('contact.knockEntryButton')}
            </button>
          </>
        )}

        {screen === 'share' && (
          <>
            {identity === null ? (
              <p role="note" className="text-xs text-accent">
                No identity in this session.
              </p>
            ) : (
              <>
                <textarea
                  aria-label={t('contact.fpLabel')}
                  readOnly
                  value={identity.fingerprint}
                  rows={2}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-xs leading-snug focus:border-accent"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="rounded-md border border-border px-2 py-1 text-xs font-medium hover:border-accent"
                  >
                    {t('common.copy')}
                  </button>
                  {copied && (
                    <span aria-live="polite" className="text-xs text-muted">
                      {t('common.copied')}
                    </span>
                  )}
                </div>
                <canvas
                  ref={canvasRef}
                  role="img"
                  aria-label={t('contact.qrCanvasLabel')}
                  className="h-44 w-44 self-center rounded border border-border bg-surface"
                />
                {/* Selectable fallback: exactly the string the QR encodes. */}
                <p className="select-all break-all text-center font-mono text-xs text-muted">
                  {link}
                </p>
                <p className="text-center text-xs text-muted">{t('qr.sameInstallNote')}</p>
                <button
                  type="button"
                  onClick={() => downloadContactQrPng(link)}
                  className="self-center rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text"
                >
                  {t('qr.downloadButton')}
                </button>
              </>
            )}
          </>
        )}

        {screen === 'knock' && (
          <>
            <p className="text-xs text-muted">{t('contact.knockIntro')}</p>
            <textarea
              aria-label={t('contact.knockPasteLabel')}
              value={pasted}
              disabled={knockStatus === 'waiting'}
              onChange={(event) => setPasted(event.target.value)}
              rows={2}
              placeholder={t('contact.knockPasteLabel')}
              className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-xs leading-snug focus:border-accent disabled:opacity-50"
            />
            <textarea
              aria-label={t('contact.knockNoteLabel')}
              value={note}
              disabled={knockStatus === 'waiting'}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value.slice(0, NOTE_MAX_LENGTH))}
              rows={2}
              placeholder={t('contact.knockNoteLabel')}
              className="w-full resize-none rounded-md border border-border bg-bg p-2 text-sm focus:border-accent disabled:opacity-50"
            />
            <span aria-live="polite" className="self-end text-[10px] tabular-nums text-muted">
              {contactNoteCounter(note.length)}
            </span>
            {knockStatus === 'waiting' && (
              <p role="status" className="text-xs text-muted">
                {t('contact.knockWaiting')}
              </p>
            )}
            {knockStatus === 'rejected' && (
              <p role="alert" className="text-xs text-accent">
                {t('contact.knockRejected')}
              </p>
            )}
            {errorText !== null && (
              <p role="alert" className="text-xs text-accent">
                {errorText}
              </p>
            )}
            <button
              type="button"
              onClick={handleKnock}
              disabled={knockStatus === 'waiting' || pasted.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-40"
            >
              {t('contact.knockSendButton')}
            </button>
          </>
        )}

        {screen !== 'pick' && (
          <button
            type="button"
            onClick={() => {
              resetFlow()
              setScreen('pick')
            }}
            className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
          >
            {t('contact.backButton')}
          </button>
        )}

        <button
          type="button"
          onClick={handleClose}
          className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
        >
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}
