import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '../common/Modal'
import { ManualBlobError, ManualPeerError, type ManualPeerState } from '../../lib/p2p/manualPeer'
import { useT, t } from '../../i18n/index'
import {
  manualBlobErrorText,
  manualPeerErrorText,
} from '../settings/messages'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * Trackerless manual DM wizard (spec §12.2, issue #97 phase 3): role pick →
 * copyable invite blob (A) or pasted invite → answer blob (B) → «P2P channel
 * established» → the manager lands the user in the standard DM view.
 *
 * - The exact §12.2 warning «The invitation may contain information about
 *   your network» accompanies EVERY blob shown for copying.
 * - Every state is cancellable («Cancel», Esc, backdrop): the pending
 *   engine is disposed and the wizard closes with no store trace (channels
 *   are only created on connect).
 * - A rejected paste shows the inline error and keeps the wizard open — the
 *   engine semantics make the paste retryable (state untouched on rejection).
 * - Machine-guard failures (`failed`) and post-connect drops surface the
 *   visible error + «Start over» (RNF-07): a new exchange always needs
 *   a fresh engine and fresh blobs (§12.2 reconnection).
 * - a11y: the Modal carries the focus trap (useFocusTrap), every control has
 *   an accessible name and the progress line is a polite live region.
 */

/** How long the «P2P channel established» confirmation stays before closing. */
const CONNECTED_FEEDBACK_MS = 800

/** How long the 'Copied' feedback stays visible (ChatHeader pattern). */
const COPIED_FEEDBACK_MS = 2_000

type Screen =
  | 'pick' // role buttons
  | 'inviteReady' // role A: blob shown (empty while generating) + paste answer
  | 'answerPaste' // role B: paste the invite
  | 'answerReady' // role B: answer blob shown, handshake running
  | 'connecting' // role A: answer accepted, handshake running
  | 'connected' // brief confirmation, then the wizard closes itself
  | 'failed' // guard fired or link dropped: visible error + retry

/** Maps an engine/blob rejection to its inline message (locale-live: the
 * lookup functions resolve through `t()` at call time). */
function errorTextFor(error: unknown): string {
  if (error instanceof ManualBlobError) return manualBlobErrorText(error.reason)
  if (error instanceof ManualPeerError) return manualPeerErrorText(error.code) ?? error.message
  return error instanceof Error && error.message !== '' ? error.message : t('errors.unknown')
}

export function ManualDmWizard(props: { open: boolean; onClose: () => void }) {
  const t = useT()
  const { open, onClose } = props
  const {
    startManualDmInvite,
    startManualDmAnswer,
    pasteManualInvite,
    pasteManualAnswer,
    cancelManualDm,
  } = useRoomManager()

  const [screen, setScreen] = useState<Screen>('pick')
  /** The blob shown for copying (invite or answer, per role). */
  const [blob, setBlob] = useState('')
  /** Draft of the textarea the user pastes into. */
  const [pasted, setPasted] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const copiedTimerRef = useRef<number | null>(null)
  // Engine events arrive from the manager after awaits; the open flag rides
  // a ref so the (stable) callback never reacts for a closed wizard.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const clearTimers = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [])

  /**
   * Closed → pristine wizard (no traces of the previous flow). Run in the
   * two close paths this wizard owns — the cancel controls and the
   * connected auto-close — never from an effect (setState there would
   * cascade renders); the layout only ever closes it through `onClose`.
   */
  const resetFlow = useCallback(() => {
    clearTimers()
    setScreen('pick')
    setBlob('')
    setPasted('')
    setErrorText(null)
    setCopied(false)
  }, [clearTimers])

  useEffect(() => clearTimers, [clearTimers])

  /** Manager-forwarded engine events: progress, connect, guards and drops. */
  const handleEvent = useCallback(
    (state: ManualPeerState, error?: ManualPeerError) => {
      if (!openRef.current) return
      if (state === 'connected') {
        setErrorText(null)
        setScreen('connected')
        closeTimerRef.current = window.setTimeout(() => {
          closeTimerRef.current = null
          resetFlow()
          onClose()
        }, CONNECTED_FEEDBACK_MS)
      } else if (state === 'failed') {
        setScreen('failed')
        setErrorText(errorTextFor(error))
      } else if (state === 'disconnected') {
        setScreen('failed')
        setErrorText(t('dm.peerDisconnected'))
      }
    },
    [onClose, resetFlow, t],
  )

  /** Cancel/Esc/backdrop: dispose the pending engine, close, no traces. */
  const handleCancel = useCallback(() => {
    resetFlow()
    cancelManualDm()
    onClose()
  }, [cancelManualDm, onClose, resetFlow])

  const handleCreateInvite = () => {
    setErrorText(null)
    setBlob('')
    setScreen('inviteReady')
    startManualDmInvite(handleEvent).then(
      (inviteBlob) => {
        if (!openRef.current) return
        setBlob(inviteBlob)
      },
      (error: unknown) => {
        if (!openRef.current) return
        setScreen('failed')
        setErrorText(errorTextFor(error))
      },
    )
  }

  const handleStartAnswer = () => {
    setErrorText(null)
    setBlob('')
    setPasted('')
    setScreen('answerPaste')
    startManualDmAnswer(handleEvent).then(
      () => {},
      (error: unknown) => {
        if (!openRef.current) return
        setScreen('failed')
        setErrorText(errorTextFor(error))
      },
    )
  }

  const handleGenerateAnswer = () => {
    setErrorText(null)
    pasteManualInvite(pasted).then(
      (answerBlob) => {
        if (!openRef.current) return
        setBlob(answerBlob)
        setPasted('')
        setScreen('answerReady')
      },
      (error: unknown) => {
        // Retryable: the engine rejected the paste and stayed in `idle`.
        if (!openRef.current) return
        setErrorText(errorTextFor(error))
      },
    )
  }

  const handleConnect = () => {
    setErrorText(null)
    pasteManualAnswer(pasted).then(
      () => {
        if (!openRef.current) return
        setPasted('')
        setScreen('connecting')
      },
      (error: unknown) => {
        // Retryable: the engine rejected the paste and stayed `invite-ready`.
        if (!openRef.current) return
        setErrorText(errorTextFor(error))
      },
    )
  }

  const handleRetry = () => {
    cancelManualDm()
    setScreen('pick')
    setBlob('')
    setPasted('')
    setErrorText(null)
  }

  const handleCopy = () => {
    void navigator.clipboard
      ?.writeText(blob)
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

  return (
    <Modal open={props.open} onClose={handleCancel} label={t('wizard.label')}>
      <div className="flex flex-col gap-3">
        {screen === 'pick' && (
          <>
            <p className="text-xs text-muted">{t('wizard.intro')}</p>
            <button
              type="button"
              onClick={handleCreateInvite}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {t('wizard.roleInviteButton')}
            </button>
            <button
              type="button"
              onClick={handleStartAnswer}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {t('wizard.roleAnswerButton')}
            </button>
          </>
        )}

        {(screen === 'inviteReady' || screen === 'answerReady' || screen === 'connecting') && (
          <>
            {blob !== '' ? (
              <>
                <p className="text-xs text-accent" role="note">
                  {t('wizard.networkWarning')}
                </p>
                <textarea
                  aria-label={t('wizard.inviteBlobLabel')}
                  readOnly
                  value={blob}
                  rows={6}
                  onFocus={(event) => event.currentTarget.select()}
                  className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-[10px] leading-snug focus:border-accent"
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
              </>
            ) : (
              <p role="status" className="text-xs text-muted">
                {t('wizard.progressGenerating')}
              </p>
            )}
          </>
        )}

        {screen === 'inviteReady' && (
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={t('wizard.pasteAnswerLabel')}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              placeholder={t('wizard.pasteAnswerLabel')}
              className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-[10px] leading-snug focus:border-accent"
            />
            <button
              type="button"
              onClick={handleConnect}
              disabled={pasted.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-40"
            >
              {t('wizard.connectButton')}
            </button>
          </div>
        )}

        {screen === 'connecting' && (
          <p role="status" className="text-xs text-muted">
            {t('wizard.progressEstablishing')}
          </p>
        )}

        {screen === 'answerReady' && (
          <p role="status" className="text-xs text-muted">
            {t('wizard.progressEstablishing')}
          </p>
        )}

        {screen === 'answerPaste' && (
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={t('wizard.pasteInviteLabel')}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={6}
              placeholder={t('wizard.pasteInviteLabel')}
              className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-[10px] leading-snug focus:border-accent"
            />
            <button
              type="button"
              onClick={handleGenerateAnswer}
              disabled={pasted.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-40"
            >
              {t('wizard.generateAnswerButton')}
            </button>
          </div>
        )}

        {screen === 'connected' && (
          <p role="status" className="text-sm font-semibold">
            {t('wizard.progressConnected')}
          </p>
        )}

        {screen === 'failed' && (
          <>
            <p role="alert" className="text-xs text-accent">
              {errorText ?? manualPeerErrorText('illegal-transition')}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {t('wizard.retryButton')}
            </button>
          </>
        )}

        {errorText !== null && screen !== 'failed' && (
          <p role="alert" className="text-xs text-accent">
            {errorText}
          </p>
        )}

        <button
          type="button"
          onClick={handleCancel}
          className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
        >
          {t('common.cancel')}
        </button>
      </div>
    </Modal>
  )
}
