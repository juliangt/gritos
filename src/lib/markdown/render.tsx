/**
 * Safe Markdown-subset renderer — spec RF-03.
 *
 * Supported subset: **bold**, *italic*, `code`, ``` fenced blocks ```,
 * [text](https://…) with http/https schemes only, line breaks. Raw HTML is
 * never interpreted — everything else is escaped. Implemented in M2 with an
 * XSS suite (`<script>`, `onerror=`, `javascript:` links). For M0 the text
 * renders as plain text, which React escapes by construction.
 */

export interface MarkdownRendererProps {
  text: string
}

export function MarkdownRenderer({ text }: MarkdownRendererProps) {
  return <span>{text}</span>
}
