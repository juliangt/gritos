import { useMemo, type ReactNode } from 'react'
import { parseMarkdown, type InlineToken, type MarkdownBlock } from './parse'

/**
 * Safe Markdown-subset renderer — RF-03 (plan §6.1 XSS suite). Consumes the
 * parser output from parse.ts and returns React nodes only: there is no
 * dangerouslySetInnerHTML anywhere, so raw HTML can never execute. See
 * tests/markdown.test.tsx for the attack suite (<script>, onerror=,
 * javascript: links, attribute/entity escaping).
 */

export interface MarkdownRendererProps {
  text: string
  /** Nicknames (own + present peers) whose @mentions get highlighted. */
  mentions?: readonly string[]
}

function renderInlineToken(token: InlineToken, keyPrefix: string): ReactNode {
  switch (token.type) {
    case 'text': {
      // '\n' inside text tokens becomes an explicit line break (RF-03).
      const parts = token.value.split('\n')
      return parts.map((part, index) =>
        index === 0 ? (
          part
        ) : (
          <span key={`${keyPrefix}-br-${index}`}>
            <br />
            {part}
          </span>
        ),
      )
    }
    case 'bold':
      return <strong key={keyPrefix}>{token.value}</strong>
    case 'italic':
      return <em key={keyPrefix}>{token.value}</em>
    case 'code':
      return (
        <code key={keyPrefix} className="rounded bg-surface px-1 font-mono text-[0.9em]">
          {token.value}
        </code>
      )
    case 'link':
      return (
        <a
          key={keyPrefix}
          href={token.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent underline underline-offset-2"
        >
          {token.text}
        </a>
      )
    case 'mention':
      return (
        <span key={keyPrefix} className="rounded bg-accent/20 px-0.5 font-medium text-accent">
          {token.value}
        </span>
      )
  }
}

function renderBlock(block: MarkdownBlock, blockIndex: number): ReactNode {
  if (block.type === 'codeBlock') {
    return (
      <pre
        key={`block-${blockIndex}`}
        className="my-1 overflow-x-auto rounded border border-border bg-surface p-2 font-mono text-xs"
      >
        <code>{block.code}</code>
      </pre>
    )
  }
  return (
    <span key={`block-${blockIndex}`}>
      {block.tokens.map((token, tokenIndex) =>
        renderInlineToken(token, `block-${blockIndex}-${tokenIndex}`),
      )}
    </span>
  )
}

export function MarkdownRenderer({ text, mentions = [] }: MarkdownRendererProps) {
  const blocks = useMemo(() => parseMarkdown(text, mentions), [text, mentions])
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>
}
