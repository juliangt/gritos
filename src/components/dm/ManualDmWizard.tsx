import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '../common/Modal'
import { ManualBlobError, ManualPeerError, type ManualPeerState } from '../../lib/p2p/manualPeer'
import {
  MANUAL_BLOB_ERROR_TEXT,
  MANUAL_DM_CANCEL_BUTTON,
  MANUAL_DM_CONNECT_BUTTON,
  MANUAL_DM_COPIED_FEEDBACK,
  MANUAL_DM_COPY_BUTTON,
  MANUAL_DM_DROPPED_TEXT,
  MANUAL_DM_GENERATE_ANSWER_BUTTON,
  MANUAL_DM_INTRO_TEXT,
  MANUAL_DM_INVITE_BLOB_LABEL,
  MANUAL_DM_NETWORK_WARNING,
  MANUAL_DM_PASTE_ANSWER_LABEL,
  MANUAL_DM_PASTE_INVITE_LABEL,
  MANUAL_DM_PROGRESS_CONNECTED,
  MANUAL_DM_PROGRESS_ESTABLISHING,
  MANUAL_DM_PROGRESS_GENERATING,
  MANUAL_DM_RETRY_BUTTON,
  MANUAL_DM_ROLE_ANSWER_BUTTON,
  MANUAL_DM_ROLE_INVITE_BUTTON,
  MANUAL_DM_WIZARD_LABEL,
  MANUAL_PEER_ERROR_TEXT,
} from '../settings/messages'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * Trackerless manual DM wizard (spec §12.2, issue #97 phase 3): role pick →
 * copyable invite blob (A) or pasted invite → answer blob (B) → «Canal P2P
 * establecido» → the manager lands the user in the standard DM view.
 *
 * - The exact §12.2 warning «La invitación puede contener información de tu
 *   net» accompanies EVERY blob shown for copying.
 * - Every state is cancellable («Cancelar», Esc, backdrop): the pending
 *   engine is disposed and the wizard closes with no store trace (channels
 *   are only created on connect).
 * - A rejected paste shows the inline error and keeps the wizard open — the
 *   engine semantics make the paste retryable (state untouched on rejection).
 * - Machine-guard failures (`failed`) and post-connect drops surface the
 *   visible error + «Volver a empezar» (RNF-07): a new exchange always needs
 *   a fresh engine and fresh blobs (§12.2 reconnection).
 * - a11y: the Modal carries the focus trap (useFocusTrap), every control has
 *   an accessible name and the progress line is a polite live region.
 */

/** How long the «Canal P2P establecido» confirmation stays before closing. */
const CONNECTED_FEEDBACK_MS = 800

/** How long the 'Copiado' feedback stays visible (ChatHeader pattern). */
const COPIED_FEEDBACK_MS = 2_000

type Screen =
  | 'pick' // role buttons
  | 'inviteReady' // role A: blob shown (empty while generating) + paste answer
  | 'answerPaste' // role B: paste the invite
  | 'answerReady' // role B: answer blob shown, handshake running
  | 'connecting' // role A: answer accepted, handshake running
  | 'connected' // brief confirmation, then the wizard closes itself
  | 'failed' // guard fired or link dropped: visible error + retry

/** Maps an engine/blob rejection to its exact Spanish inline message. */
function errorTextFor(error: unknown): string {
  if (error instanceof ManualBlobError) return MANUAL_BLOB_ERROR_TEXT[error.reason]
  if (error instanceof ManualPeerError) return MANUAL_PEER_ERROR_TEXT[error.code] ?? error.message
  return error instanceof Error && error.message !== '' ? error.message : 'Error desconocido'
}

export function ManualDmWizard(props: { open: boolean; onClose: () => void }) {
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
        setErrorText(MANUAL_DM_DROPPED_TEXT)
      }
    },
    [onClose, resetFlow],
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
    <Modal open={props.open} onClose={handleCancel} label={MANUAL_DM_WIZARD_LABEL}>
      <div className="flex flex-col gap-3">
        {screen === 'pick' && (
          <>
            <p className="text-xs text-muted">{MANUAL_DM_INTRO_TEXT}</p>
            <button
              type="button"
              onClick={handleCreateInvite}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {MANUAL_DM_ROLE_INVITE_BUTTON}
            </button>
            <button
              type="button"
              onClick={handleStartAnswer}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {MANUAL_DM_ROLE_ANSWER_BUTTON}
            </button>
          </>
        )}

        {(screen === 'inviteReady' || screen === 'answerReady' || screen === 'connecting') && (
          <>
            {blob !== '' ? (
              <>
                <p className="text-xs text-accent" role="note">
                  {MANUAL_DM_NETWORK_WARNING}
                </p>
                <textarea
                  aria-label={MANUAL_DM_INVITE_BLOB_LABEL}
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
                    {MANUAL_DM_COPY_BUTTON}
                  </button>
                  {copied && (
                    <span aria-live="polite" className="text-xs text-muted">
                      {MANUAL_DM_COPIED_FEEDBACK}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <p role="status" className="text-xs text-muted">
                {MANUAL_DM_PROGRESS_GENERATING}
              </p>
            )}
          </>
        )}

        {screen === 'inviteReady' && (
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={MANUAL_DM_PASTE_ANSWER_LABEL}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={4}
              placeholder={MANUAL_DM_PASTE_ANSWER_LABEL}
              className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-[10px] leading-snug focus:border-accent"
            />
            <button
              type="button"
              onClick={handleConnect}
              disabled={pasted.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-40"
            >
              {MANUAL_DM_CONNECT_BUTTON}
            </button>
          </div>
        )}

        {screen === 'connecting' && (
          <p role="status" className="text-xs text-muted">
            {MANUAL_DM_PROGRESS_ESTABLISHING}
          </p>
        )}

        {screen === 'answerReady' && (
          <p role="status" className="text-xs text-muted">
            {MANUAL_DM_PROGRESS_ESTABLISHING}
          </p>
        )}

        {screen === 'answerPaste' && (
          <div className="flex flex-col gap-2">
            <textarea
              aria-label={MANUAL_DM_PASTE_INVITE_LABEL}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              rows={6}
              placeholder={MANUAL_DM_PASTE_INVITE_LABEL}
              className="w-full resize-none break-all rounded-md border border-border bg-bg p-2 font-mono text-[10px] leading-snug focus:border-accent"
            />
            <button
              type="button"
              onClick={handleGenerateAnswer}
              disabled={pasted.trim() === ''}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-text disabled:opacity-40"
            >
              {MANUAL_DM_GENERATE_ANSWER_BUTTON}
            </button>
          </div>
        )}

        {screen === 'connected' && (
          <p role="status" className="text-sm font-semibold">
            {MANUAL_DM_PROGRESS_CONNECTED}
          </p>
        )}

        {screen === 'failed' && (
          <>
            <p role="alert" className="text-xs text-accent">
              {errorText ?? MANUAL_PEER_ERROR_TEXT['illegal-transition']}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="rounded-md border border-border px-2 py-1.5 text-sm font-medium hover:border-accent"
            >
              {MANUAL_DM_RETRY_BUTTON}
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
          {MANUAL_DM_CANCEL_BUTTON}
        </button>
      </div>
    </Modal>
  )
}
