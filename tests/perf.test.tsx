import { describe, expect, it } from 'vitest'
import { MessageItem } from '../src/components/chat/MessageItem'

/**
 * M6 (RNF-03): MessageItem must stay memoized — the feed renders up to 500
 * rows, and any prop instability would re-render the whole history on every
 * append. This guards against the memo wrapper being dropped accidentally.
 */
describe('MessageFeed performance', () => {
  it('MessageItem is wrapped in React.memo', () => {
    expect((MessageItem as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for('react.memo'),
    )
  })
})
