// @vitest-environment jsdom
import './dom-setup'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, type RenderResult } from '@testing-library/react'
import { MarkdownRenderer } from '../src/lib/markdown/render'
import { isSafeLinkUrl, parseInline, parseMarkdown } from '../src/lib/markdown/parse'

function renderText(text: string, mentions: readonly string[] = []): RenderResult {
  return render(<MarkdownRenderer text={text} mentions={mentions} />)
}

afterEach(cleanup)

describe('markdown subset (RF-03)', () => {
  it('renders the full subset: bold, italic, code, links', () => {
    renderText('**bold** and *italic* and `code` and [link](https://example.org)')
    expect(screen.getByText('bold').closest('strong')).toBeInTheDocument()
    expect(screen.getByText('italic').closest('em')).toBeInTheDocument()
    expect(screen.getByText('code').closest('code')).toBeInTheDocument()
    const link = screen.getByText('link').closest('a')
    expect(link).toHaveAttribute('href', 'https://example.org')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders fenced code blocks verbatim, without inline markup', () => {
    renderText('before\n```\n**not bold** and <b>html</b>\n```\nafter')
    expect(screen.getByText('**not bold** and <b>html</b>').closest('pre')).toBeInTheDocument()
    expect(screen.queryByText('not bold', { selector: 'strong' })).not.toBeInTheDocument()
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
  })

  it('handles an unterminated fence as a code block', () => {
    renderText('```\nnot closed')
    expect(screen.getByText('not closed').closest('pre')).toBeInTheDocument()
  })

  it('keeps line breaks inside a paragraph', () => {
    const { container } = render(<MarkdownRenderer text={'line 1\nline 2'} />)
    expect(container.querySelector('br')).toBeInTheDocument()
    expect(container.textContent).toContain('line 1')
    expect(container.textContent).toContain('line 2')
  })

  it('renders long messages completely (4 KB, the protocol cap)', () => {
    const text = 'word '.repeat(810) // 4050 chars → capped upstream at 4000
    const { container } = render(<MarkdownRenderer text={text.slice(0, 4000)} />)
    expect(container.textContent?.length).toBeGreaterThanOrEqual(3990)
  })
})

describe('markdown XSS suite (plan §6.1, R5)', () => {
  it('renders <script> inert: no element, escaped as literal text', () => {
    const { container } = renderText('<script>alert(1)</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toBe('<script>alert(1)</script>')
  })

  it('renders <img onerror=…> escaped: no img element', () => {
    const { container } = renderText('<img src=x onerror="alert(1)">')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('never produces a link for javascript: schemes', () => {
    const { container } = renderText('[x](javascript:alert(1))')
    expect(container.querySelector('a')).toBeNull()
    // The whole construct stays visible, inert text.
    expect(container.textContent).toBe('[x](javascript:alert(1))')
  })

  it('restricts link protocols to http/https', () => {
    expect(isSafeLinkUrl('https://ejemplo.org/a?b=1')).toBe(true)
    expect(isSafeLinkUrl('http://ejemplo.org')).toBe(true)
    expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeLinkUrl('JAVASCRIPT:alert(1)')).toBe(false)
    expect(isSafeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeLinkUrl('vbscript:msgbox')).toBe(false)
    expect(isSafeLinkUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeLinkUrl('/relative/path')).toBe(false)
    expect(isSafeLinkUrl('')).toBe(false)
    // Rendered result: unsafe links become plain text, safe ones anchors.
    const { container: unsafe } = renderText('[a](data:text/html,hi)')
    expect(unsafe.querySelector('a')).toBeNull()
  })

  it('keeps HTML attributes and entities as literal text', () => {
    const { container } = renderText('usa &lt;b&gt; y <b class="x">negrita html</b>')
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('&lt;b&gt;')
    expect(container.textContent).toContain('<b class="x">negrita html</b>')
  })

  it('does not interpret nested markdown-ish HTML injections', () => {
    const { container } = renderText('**[clica](javascript:alert(1))**')
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('strong')).toBeInTheDocument()
    expect(container.textContent).toContain('[clica](javascript:alert(1))')
  })
})

describe('mentions (RF-03)', () => {
  it('highlights own/peer nicknames case-insensitively', () => {
    const { container } = renderText('hola @Luna-Cauta y @ZORRO-BRAVO', [
      'luna-cauta',
      'zorro-bravo',
    ])
    const highlights = container.querySelectorAll('span.bg-accent\\/20')
    expect(highlights).toHaveLength(2)
    expect(highlights[0]?.textContent).toBe('@Luna-Cauta')
    expect(highlights[1]?.textContent).toBe('@ZORRO-BRAVO')
  })

  it('respects word boundaries: a word char before @ blocks the mention', () => {
    const tokens = parseInline('escribe x@luna-cauta hoy', ['luna-cauta'])
    expect(tokens.every((token) => token.type !== 'mention')).toBe(true)

    const ok = parseInline('write @luna-cauta today', ['luna-cauta'])
    expect(ok.some((token) => token.type === 'mention')).toBe(true)
  })

  it('leaves non-mention @ alone (emails, unknown nicks)', () => {
    const { container } = renderText('write to a@b.com and @nobody', ['b'])
    // a@b.com: 'a' before @ is a word char → never a mention.
    // @nobody: not in the candidates → plain text.
    expect(container.querySelectorAll('span.bg-accent\\/20')).toHaveLength(0)
    expect(container.textContent).toContain('a@b.com')
    expect(container.textContent).toContain('@nobody')
  })

  it('parses the mention token only when a candidate matches', () => {
    expect(parseInline('@luna jumps', ['luna'])).toEqual([
      { type: 'mention', value: '@luna' },
      { type: 'text', value: ' jumps' },
    ])
    // Without candidates the same characters stay plain text (split on the
    // same token boundaries).
    expect(parseInline('@luna jumps', [])).toEqual([
      { type: 'text', value: '@luna' },
      { type: 'text', value: ' jumps' },
    ])
  })
})

describe('parseMarkdown blocks', () => {
  it('splits fenced blocks from paragraphs', () => {
    const blocks = parseMarkdown('hello\n```\ncode\nlines\n```\nbye')
    expect(blocks).toEqual([
      { type: 'paragraph', tokens: [{ type: 'text', value: 'hello' }] },
      { type: 'codeBlock', code: 'code\nlines' },
      { type: 'paragraph', tokens: [{ type: 'text', value: 'bye' }] },
    ])
  })

  it('keeps unknown syntax as text tokens', () => {
    const tokens = parseInline('1 < 2 && 3 > 2 ~ approx')
    expect(tokens).toEqual([{ type: 'text', value: '1 < 2 && 3 > 2 ~ approx' }])
  })
})
