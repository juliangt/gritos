/**
 * Safe Markdown-subset parser — RF-03. Produces a typed token tree that the
 * React renderer (render.tsx) turns into nodes; raw HTML is NEVER part of
 * the output, so no sanitizer is needed: anything not in the subset falls
 * out as plain text tokens, which React escapes by construction.
 *
 * Subset: **bold**, *italic*, `code`, ``` fenced blocks ```,
 * [text](url) with http/https schemes only, line breaks, @mentions.
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'italic'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'mention'; value: string }

export type MarkdownBlock =
  { type: 'paragraph'; tokens: InlineToken[] } | { type: 'codeBlock'; code: string }

/**
 * Links are restricted to absolute http/https URLs (RF-03). Anything else —
 * javascript:, data:, vbscript:, relative or malformed — is unsafe and the
 * whole `[text](url)` sequence renders as literal text.
 */
export function isSafeLinkUrl(url: string): boolean {
  if (url === '' || /[\s\u0000-\u001f]/.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/** Word characters (unicode letters, digits, underscore) for @ boundaries. */
const WORD_CHAR = /[\p{L}\p{N}_]/u

const INLINE_PATTERN =
  /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\s]+)\)|@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu

/**
 * Parses one line/paragraph into inline tokens. Mentions are `@name`
 * sequences that (case-insensitively) match one of `mentions` at a word
 * boundary; any other `@` stays literal text. URLs outside http/https keep
 * the original bracket syntax as plain text.
 */
export function parseInline(text: string, mentions: readonly string[] = []): InlineToken[] {
  const tokens: InlineToken[] = []
  const loweredMentions = mentions.map((mention) => mention.toLowerCase())
  let lastIndex = 0

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index
    if (start > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, start) })
    }
    const [bold, italic, code, linkText, linkUrl, mentionName] = match.slice(1)

    if (bold !== undefined) {
      tokens.push({ type: 'bold', value: bold })
    } else if (italic !== undefined) {
      tokens.push({ type: 'italic', value: italic })
    } else if (code !== undefined) {
      tokens.push({ type: 'code', value: code })
    } else if (linkText !== undefined && linkUrl !== undefined) {
      if (isSafeLinkUrl(linkUrl)) {
        tokens.push({ type: 'link', text: linkText, url: linkUrl })
      } else {
        // Unsafe scheme: the whole construct stays inert literal text.
        tokens.push({ type: 'text', value: match[0] })
      }
    } else if (mentionName !== undefined) {
      const boundary =
        start === 0 || !(WORD_CHAR.test(text[start - 1] as string) || text[start - 1] === '@')
      const isMention = boundary && loweredMentions.includes(mentionName.toLowerCase())
      tokens.push(
        isMention ? { type: 'mention', value: match[0] } : { type: 'text', value: match[0] },
      )
    }
    lastIndex = start + match[0].length
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) })
  }
  return tokens
}

/**
 * RF-09 helper on top of the M2 mention matcher: true when `text` contains
 * an `@nickname` mention (case-insensitive, word boundary — same rules the
 * renderer highlights with). Used by the desktop-notification gate.
 */
export function mentionsNickname(text: string, nickname: string): boolean {
  const nick = nickname.trim()
  if (nick === '') return false
  return parseInline(text, [nick]).some((token) => token.type === 'mention')
}

const FENCE_MARKER = '```'

/**
 * Parses a full message into blocks. Fenced blocks (``` … ```) swallow
 * every line verbatim — no inline markup inside. Everything else becomes a
 * paragraph block whose text tokens keep '\n' for the renderer to turn
 * into line breaks.
 */
export function parseMarkdown(text: string, mentions: readonly string[] = []): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = text.split('\n')

  let paragraphLines: string[] = []
  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return
    blocks.push({
      type: 'paragraph',
      tokens: parseInline(paragraphLines.join('\n'), mentions),
    })
    paragraphLines = []
  }

  let fenceLines: string[] | null = null
  for (const line of lines) {
    if (fenceLines !== null) {
      if (line.trim() === FENCE_MARKER) {
        blocks.push({ type: 'codeBlock', code: fenceLines.join('\n') })
        fenceLines = null
      } else {
        fenceLines.push(line)
      }
      continue
    }
    if (line.trimStart().startsWith(FENCE_MARKER)) {
      flushParagraph()
      fenceLines = []
      continue
    }
    paragraphLines.push(line)
  }
  // Unterminated fence: render what was collected as a code block.
  if (fenceLines !== null) {
    blocks.push({ type: 'codeBlock', code: fenceLines.join('\n') })
  }
  flushParagraph()
  return blocks
}
