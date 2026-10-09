import { useEffect, useState, type FormEvent } from 'react'
import { normalizeRoomName } from '../../lib/p2p/roomManager'
import { useT } from '../../i18n/index'
import { useRoomManager } from '../../hooks/useRoomManager'

/**
 * '[+ Unirse]' popover (RF-02/RF-05): free-name join with live normalization
 * preview and inline validation (no error modal). The optional encrypted-
 * room password hides behind the 'encrypted room' toggle with the one-line
 * explanation; when the toggle is on a non-empty password is required —
 * the room key and the §9.4 roomId both derive from it. Room-cap rejections
 * surface the exact manager message ('Active room limit reached (N)' under
 * the en locale — the errors.* templates): the popover's own submit sets it as the local error, and `managerError`
 * carries one raised outside (issue #87: a suggested-room join rejected by
 * the sidebar reuses this open popover instead of a hidden paragraph).
 * A wrong password is NOT a join error: the room simply never finds peers,
 * and the not-found message appears in the room view once the error
 * heuristic exhausts (lib/rooms roomStatusText). Esc dismisses the popover
 * when an onDismiss handler exists (RNF-05). `initialName` prefills the
 * field (issue #41: the deep-link password recovery form).
 */
export function JoinRoomPopover(props: {
  /** Called with the joined roomId; joinRoomFocused already focuses it. */
  onJoined?: (roomId: string) => void
  onDismiss?: () => void
  /** Prefilled room name (issue #41 deep-link password recovery). */
  initialName?: string
  /**
   * Manager rejection raised outside the popover (issue #87: the sidebar's
   * joinByName). Shown in the same alert line as the local validation
   * error, which keeps precedence when both exist (an in-popover submit at
   * the cap re-derives the same message).
   */
  managerError?: string | null
}) {
  const t = useT()
  const [name, setName] = useState(props.initialName ?? '')
  const [encrypted, setEncrypted] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { joinRoomFocused } = useRoomManager()
  const managerError = props.managerError ?? null

  const onDismiss = props.onDismiss
  // RNF-05 — Esc closes the popover (the Modal, the peer menu and the mobile
  // drawer cover the rest of the floating surfaces).
  useEffect(() => {
    if (onDismiss === undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onDismiss])

  // Live normalization preview: '#my-room' while typing, '—' when invalid.
  const normalized = normalizeRoomName(name)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    if (normalized === null) {
      setError(t('settings.invalidRoomName'))
      return
    }
    if (encrypted && password === '') {
      setError(t('settings.emptyRoomPassword'))
      return
    }
    setBusy(true)
    const { roomId, error: joinError } = await joinRoomFocused(
      normalized,
      encrypted ? password : undefined,
    )
    setBusy(false)
    if (joinError !== null) {
      setError(joinError)
      return
    }
    if (roomId !== null) props.onJoined?.(roomId)
  }

  return (
    <form
      aria-label={t('sidebar.joinByNameLabel')}
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-2 rounded-md border border-border bg-surface p-2"
    >
      <input
        aria-label={t('sidebar.roomNameAria')}
        autoFocus
        placeholder={t('sidebar.roomNamePlaceholder')}
        spellCheck={false}
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setError(null)
        }}
        className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm focus:border-accent"
      />
      {name.trim() !== '' && (
        <p className="text-xs text-muted">
          {t('sidebar.joinPreview')}{' '}
          <span className="font-mono text-text">#{normalized ?? '—'}</span>
        </p>
      )}
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          aria-label={t('common.encryptedRoomAria')}
          checked={encrypted}
          onChange={(event) => {
            setEncrypted(event.target.checked)
            setError(null)
          }}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span>{t('sidebar.encryptedRoomText')}</span>
      </label>
      {encrypted && (
        <>
          <input
            aria-label={t('sidebar.roomPasswordAria')}
            type="password"
            placeholder={t('sidebar.roomPasswordPlaceholder')}
            spellCheck={false}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              setError(null)
            }}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm focus:border-accent"
          />
          <p className="text-xs text-muted">{t('settings.encryptedRoomHint')}</p>
        </>
      )}
      {(error !== null || managerError !== null) && (
        <p role="alert" className="text-xs text-accent">
          {error ?? managerError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text disabled:opacity-50"
        >
          {t('common.join')}
        </button>
        {props.onDismiss !== undefined && (
          <button
            type="button"
            onClick={props.onDismiss}
            className="rounded border border-border px-3 py-1.5 text-xs"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </form>
  )
}
