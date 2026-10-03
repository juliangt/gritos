import { MarkdownRenderer } from '../../lib/markdown/render'
import { authorColor } from '../../lib/color'
import { disambiguatedNickname } from '../../lib/nickname'
import { formatTimeHHMM } from '../../lib/feed'
import type { Message, Peer } from '../../stores/useAppStore'
import { useAppStore } from '../../stores/useAppStore'

/**
 * One flat feed bubble (spec §10.4): no per-message boxes; author in a
 * stable hash color, HH:MM from the author's ts, Markdown-subset body with
 * mention highlighting. Own messages align right and carry the dimmed
 * ✓/✓✓ receipt marker. System lines ('— nick se ha unido —', FIFO
 * separator) render centered and muted.
 */
export function MessageItem(props: {
  message: Message
  peers: readonly Peer[]
  mentionCandidates: readonly string[]
}) {
  const ownNickname = useAppStore((state) => state.identity?.nickname ?? '')

  if (props.message.kind === 'system') {
    return <p className="my-1 text-center text-xs text-muted">{props.message.text}</p>
  }

  const own = props.message.authorId === 'self'
  const displayName = own
    ? ownNickname
    : disambiguatedNickname(props.message.authorNick, props.message.authorId, props.peers as Peer[])

  return (
    <div className={`flex flex-col ${own ? 'items-end' : 'items-start'}`}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold" style={{ color: authorColor(props.message.authorId) }}>
          {displayName}
        </span>
        <time dateTime={new Date(props.message.ts).toISOString()} className="text-muted">
          {formatTimeHHMM(props.message.ts)}
        </time>
      </div>
      <div className="max-w-[85%] break-words text-sm leading-relaxed">
        <MarkdownRenderer text={props.message.text} mentions={props.mentionCandidates} />
      </div>
      {own && (
        <span
          className="text-xs text-muted"
          aria-label={
            props.message.status === 'delivered' ? 'entregado' : 'enviado, pendiente de recepción'
          }
        >
          {props.message.status === 'delivered' ? '✓✓' : '✓'}
        </span>
      )}
    </div>
  )
}
