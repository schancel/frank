import * as marked from 'marked'

const unescapeHtml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

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
  let text: string
  try {
    text = plainTextOf(marked.lexer(input) as PlainToken[], imageLabel)
  } catch {
    text = input
  }
  return text.replace(/\s+/g, ' ').trim()
}
