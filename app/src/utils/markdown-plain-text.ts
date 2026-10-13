import * as marked from 'marked'

/**
 * Decodes all HTML entities including hexadecimal (&#x...), decimal (&#...),
 * and common named entities (&quot;, &amp;, &lt;, &gt;, etc.).
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return ''
  return text
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
      try {
        const code = parseInt(hex, 16)
        return Number.isNaN(code) ? _ : String.fromCodePoint(code)
      } catch {
        return _
      }
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10)
        return Number.isNaN(code) ? _ : String.fromCodePoint(code)
      } catch {
        return _
      }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Strips internal wire fallback headers like `[Email to ...]` or
 * `[Direct P2P Email to ...]` and extracts a clean email snippet
 * (the clean email body preview, or `Subject: ...` if no body is present).
 */
export function cleanEmailSnippet(input: string): string {
  if (!input) return ''

  // Decode entities upfront in case the headers or body contain them
  let text = decodeHtmlEntities(input).trim()

  // Match wire headers:
  // [Email to ...]
  // [Email from ...]
  // [Direct P2P Email to ... (external email recipients not notified)]
  // [Direct P2P Email from ...]
  // Followed optionally by [Cc ...]
  const wireHeaderRegex =
    /^\s*\[(?:(?:Direct P2P\s+)?Email\s+(?:to|from)|Email)[^\]]*\](?:\s*\[Cc\s+[^\]]*\])?\s*/i

  const hasWireHeader = wireHeaderRegex.test(text)
  if (hasWireHeader) {
    text = text.replace(wireHeaderRegex, '').trim()
  }

  // Also check if text starts with ✉️ prefix (from email plugin previewText)
  const pluginPreviewRegex = /^✉️\s*([^:]+):\s*(.*)$/s
  const pluginMatch = text.match(pluginPreviewRegex)
  if (pluginMatch) {
    const subj = pluginMatch[1].trim()
    const body = pluginMatch[2].trim()
    if (body) return body
    return subj && subj !== '(No Subject)' ? `Subject: ${subj}` : ''
  }

  // Check for Subject header: `Subject: ...`
  const subjectMatch = text.match(/^Subject:\s*([^\r\n]*)(?:\r?\n+([\s\S]*))?$/i)
  if (subjectMatch) {
    const subj = subjectMatch[1].trim()
    const body = subjectMatch[2]?.trim() || ''
    if (body) {
      return body
    }
    return subj ? `Subject: ${subj}` : ''
  }

  return text
}

const unescapeHtml = (text: string) => decodeHtmlEntities(text)

interface PlainToken {
  type: string
  text?: string
  tokens?: PlainToken[]
  items?: PlainToken[]
  header?: PlainToken[]
  rows?: PlainToken[][]
}

function plainTextOf(tokens: readonly PlainToken[], imageLabel: string) {
  const parts: string[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'html':
        // A tag is dropped; whatever a raw HTML block holds between its tags is kept as text.
        parts.push((token.text ?? '').replace(/<[^>]*>/g, ''))
        break
      case 'hr':
      case 'def':
        break
      case 'space':
      case 'br':
        parts.push(' ')
        break
      case 'image':
        parts.push(imageLabel || unescapeHtml(token.text ?? ''))
        break
      case 'list':
        for (const item of token.items ?? [])
          parts.push(plainTextOf(item.tokens ?? [], imageLabel), ' ')
        break
      case 'table':
        for (const cell of [
          ...(token.header ?? []),
          ...(token.rows ?? []).flat(),
        ])
          parts.push(plainTextOf(cell.tokens ?? [], imageLabel), ' ')
        break
      case 'code':
        // A code block's text is not escaped by the parser; inline text is.
        parts.push(token.text ?? '', ' ')
        break
      default:
        if (token.tokens) parts.push(plainTextOf(token.tokens, imageLabel))
        else parts.push(unescapeHtml(token.text ?? ''))
        // A block ends where the next one begins: keep their words apart.
        if (
          token.type === 'paragraph' ||
          token.type === 'heading' ||
          token.type === 'blockquote'
        )
          parts.push(' ')
    }
  }
  return parts.join('')
}

/**
 * A message's text as one line of plain text, for the places that show a message without
 * rendering it: the chat list's preview and a desktop notification. It reads the text with the
 * same parser the message view renders with (`marked`) and keeps only the words: emphasis and
 * code markers go, a link is its text, HTML tags are dropped, and a picture is `imageLabel`
 * (its alt text when no label is given). The result is text, never HTML: show it as text.
 */
export function markdownPlainText(input: string, imageLabel = ''): string {
  const cleaned = cleanEmailSnippet(input)
  let text: string
  try {
    text = plainTextOf(marked.lexer(cleaned) as PlainToken[], imageLabel)
  } catch {
    text = cleaned
  }
  return decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * Formats a message snippet for conversation list preview and notifications.
 * If the message is an email or wire email fallback, strips internal headers
 * and returns a clean body preview or subject.
 */
export function formatSnippet(input: string, imageLabel = ''): string {
  return markdownPlainText(input, imageLabel)
}

