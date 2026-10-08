import {
  FILE_ABORTED_TEXT,
  FILE_ACCEPT_BUTTON,
  FILE_CANCEL_BUTTON,
  FILE_CARDS_REGION_LABEL,
  FILE_DECLINE_BUTTON,
  FILE_DISMISS_BUTTON,
  FILE_DONE_TEXT,
  FILE_DOWNLOAD_BUTTON,
  FILE_ENC_STATE_CLEAR,
  FILE_ENC_STATE_SEALED,
  FILE_FAILURE_TEXT,
  FILE_OFFER_PENDING_TEXT,
  FILE_PROGRESS_LABEL,
  FILE_PROGRESS_RECEIVING_TEXT,
  FILE_PROGRESS_SENDING_TEXT,
  FILE_REJECTED_TEXT,
  FILE_UNKNOWN_MIME_TEXT,
  fileCardLabel,
  fileOfferText,
} from '../settings/messages'
import { formatFileSize } from '../../lib/fileSize'
import type { FileTransferRecord } from '../../lib/p2p/fileTransfer'

/**
 * Issue #103 phase 4 — the transfer-cards area (spec §12.4): consent before
 * any byte, progress, honest terminal states. Files are NOT feed rows (the
 * §12.4 store note) and carry no arrival effects, so the cards render in
 * their own strip below the feed and above the typing bar/composer — where
 * the user is looking when an offer or a progress bar needs a decision —
 * instead of inside the role="log" feed. Each card renders straight from
 * its engine record: the card lives and dies with the §12.4 map entry, and
 * dismissal is the explicit `revokeTransferUrl` of the spec.
 */

const cardActionButtonClass =
  'rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-text hover:opacity-90'
const cardSecondaryButtonClass =
  'rounded border border-border px-3 py-1.5 text-xs hover:border-accent'

function MetaLine({ record }: { record: FileTransferRecord }) {
  return (
    <p className="truncate text-sm">
      <span className="font-medium">{record.meta.name}</span>{' '}
      <span className="text-xs text-muted">{formatFileSize(record.meta.size)}</span>
      {' · '}
      <span className="text-xs text-muted">
        {record.meta.mime !== '' ? record.meta.mime : FILE_UNKNOWN_MIME_TEXT}
      </span>
    </p>
  )
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button type="button" onClick={onDismiss} className={`self-start ${cardSecondaryButtonClass}`}>
      {FILE_DISMISS_BUTTON}
    </button>
  )
}

/** One transfer's card: consent, progress, result or failure — never a row. */
function FileTransferCard(props: {
  record: FileTransferRecord
  nick: string | null
  onAccept: (key: string) => void
  onDecline: (key: string) => void
  onCancel: (key: string) => void
  onDismiss: (key: string) => void
}) {
  const { record, nick } = props
  const { meta, state } = record
  const incoming = record.direction === 'receive'
  const doneUrl = state === 'done' && incoming && record.url !== null ? record.url : null

  return (
    <article
      aria-label={fileCardLabel(meta.name, nick)}
      className="rounded-md border border-border bg-bg px-3 py-2"
    >
      <div className="flex items-baseline justify-between gap-2">
        <MetaLine record={record} />
        <span className="shrink-0 text-xs text-muted">{nick ?? record.peerId}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {meta.enc ? FILE_ENC_STATE_SEALED : FILE_ENC_STATE_CLEAR}
      </p>

      {state === 'offer' && incoming && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm">{fileOfferText(nick ?? record.peerId)}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => props.onAccept(record.key)}
              className={cardActionButtonClass}
            >
              {FILE_ACCEPT_BUTTON}
            </button>
            <button
              type="button"
              onClick={() => props.onDecline(record.key)}
              className={cardSecondaryButtonClass}
            >
              {FILE_DECLINE_BUTTON}
            </button>
          </div>
        </div>
      )}

      {state === 'offer' && !incoming && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-muted">{FILE_OFFER_PENDING_TEXT}</p>
          <button
            type="button"
            onClick={() => props.onCancel(record.key)}
            className={cardSecondaryButtonClass}
          >
            {FILE_CANCEL_BUTTON}
          </button>
        </div>
      )}

      {state === 'transferring' && (
        <div className="mt-2 flex flex-col gap-1">
          <p className="text-xs text-muted">
            {incoming ? FILE_PROGRESS_RECEIVING_TEXT : FILE_PROGRESS_SENDING_TEXT}{' '}
            {record.transferred}/{meta.chunks}
          </p>
          {/* §12.4 — chunk counts are the honest unit: `transferred` is the
              receiver's contiguous chunks or the sender's acked ones. */}
          <div
            role="progressbar"
            aria-label={FILE_PROGRESS_LABEL}
            aria-valuemin={0}
            aria-valuemax={meta.chunks}
            aria-valuenow={record.transferred}
            className="h-1.5 w-full overflow-hidden rounded bg-border"
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${Math.min(100, (record.transferred / meta.chunks) * 100)}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => props.onCancel(record.key)}
            className={`self-start ${cardSecondaryButtonClass}`}
          >
            {FILE_CANCEL_BUTTON}
          </button>
        </div>
      )}

      {state === 'done' && (
        <>
          <p className="mt-1 text-xs text-muted">{FILE_DONE_TEXT}</p>
          {/* Images (mime image/*, within the engine's 20 MB cap by
              construction) render inline from the revocable blob URL with
              the sanitized name as alt; everything else gets a download
              anchor. Senders keep their original file: no URL, no download. */}
          {doneUrl !== null &&
            (meta.mime.startsWith('image/') ? (
              <img src={doneUrl} alt={meta.name} className="mt-2 max-h-64 rounded-md" />
            ) : (
              <a
                href={doneUrl}
                download={meta.name}
                className={`mt-2 inline-block ${cardActionButtonClass}`}
              >
                {FILE_DOWNLOAD_BUTTON}
              </a>
            ))}
          <div className="mt-2">
            <DismissButton onDismiss={() => props.onDismiss(record.key)} />
          </div>
        </>
      )}

      {state === 'rejected' && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm">{FILE_REJECTED_TEXT}</p>
          <DismissButton onDismiss={() => props.onDismiss(record.key)} />
        </div>
      )}

      {state === 'aborted' && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm">{FILE_ABORTED_TEXT}</p>
          <DismissButton onDismiss={() => props.onDismiss(record.key)} />
        </div>
      )}

      {state === 'failed' && (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-sm">{FILE_FAILURE_TEXT[record.failureReason ?? 'stall']}</p>
          <DismissButton onDismiss={() => props.onDismiss(record.key)} />
        </div>
      )}
    </article>
  )
}

/**
 * The cards strip of one active view (room or DM). Hidden entirely while no
 * transfer is live for the view; the caller scopes the records (the hook's
 * `visibleInRoom`/`visibleWithPeer`) and owns the callbacks.
 */
export function FileTransferCards(props: {
  records: readonly FileTransferRecord[]
  peerNick: (peerId: string) => string | null
  onAccept: (key: string) => void
  onDecline: (key: string) => void
  onCancel: (key: string) => void
  onDismiss: (key: string) => void
}) {
  if (props.records.length === 0) return null
  return (
    <section
      aria-label={FILE_CARDS_REGION_LABEL}
      className="flex flex-col gap-2 border-t border-border bg-surface px-3 py-2"
    >
      {props.records.map((record) => (
        <FileTransferCard
          key={record.key}
          record={record}
          nick={props.peerNick(record.peerId)}
          onAccept={props.onAccept}
          onDecline={props.onDecline}
          onCancel={props.onCancel}
          onDismiss={props.onDismiss}
        />
      ))}
    </section>
  )
}
