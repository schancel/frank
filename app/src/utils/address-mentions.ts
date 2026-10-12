import * as marked from 'marked'

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Exact addresses in ordinary Markdown text, never code, links or embedded HTML. */
export function addressMentionTokens(
  input: string,
  names: Readonly<Record<string, string>> = {},
  lineBreaks = false,
): { tokens: marked.TokensList; addresses: string[] } {
  const source = marked.lexer(input, { ...marked.defaults, breaks: lineBreaks })
  const addresses = new Set<string>()
  const textTokens = (text: string): marked.Token[] => {
    const pattern = /(^|[^A-Za-z0-9_@])@(0x[0-9a-f]{40})(?![A-Za-z0-9_])/gi
    const result: marked.Token[] = []
    let end = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index! + match[1].length
      if (start > end)
        result.push({
          type: 'text',
          raw: text.slice(end, start),
          text: text.slice(end, start),
        })
      const address = match[2].toLowerCase()
      const raw = '@' + match[2]
      const label = escapeHtml(names[address] || raw)
      addresses.add(address)
      result.push({
        type: 'link',
        raw,
        href: `/chat/${address}?info=true`,
        title: '',
        text: label,
        tokens: [{ type: 'text', raw: label, text: label }],
      })
      end = start + raw.length
    }
    if (end < text.length)
      result.push({ type: 'text', raw: text.slice(end), text: text.slice(end) })
    return result
  }
  const visit = (tokens: marked.Token[]): marked.Token[] => {
    const output: marked.Token[] = []
    let htmlDepth = 0
    for (const token of tokens) {
      if (token.type === 'html') {
        // Inline HTML tags can surround separate text tokens. Do not resolve their contents.
        for (const tag of token.raw
          .replace(/<!--[\s\S]*?-->/g, '')
          .matchAll(/<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
          if (tag[1]) htmlDepth = Math.max(0, htmlDepth - 1)
          else if (
            !/\/\s*>$/.test(tag[0]) &&
            !/^(?:br|hr|img|input|meta|link|wbr|area|base|embed|source|track|col|param)$/i.test(
              tag[2],
            )
          )
            htmlDepth++
        }
        output.push(token)
        continue
      }
      if (htmlDepth > 0) {
        output.push(token)
        continue
      }
      switch (token.type) {
        case 'code':
        case 'codespan':
        case 'link':
        case 'image':
          output.push(token)
          break
        case 'list':
          output.push({
            ...token,
            items: token.items.map((item: marked.Tokens.ListItem) => ({
              ...item,
              tokens: visit(item.tokens),
            })),
          })
          break
        case 'table': {
          const cell = (value: marked.Tokens.TableCell) => ({
            ...value,
            tokens: visit(value.tokens),
          })
          output.push({
            ...token,
            header: token.header.map(cell),
            rows: token.rows.map((row: marked.Tokens.TableCell[]) =>
              row.map(cell),
            ),
          })
          break
        }
        case 'text':
          if (Array.isArray(token.tokens))
            output.push({ ...token, tokens: visit(token.tokens) })
          else output.push(...textTokens(token.text))
          break
        default:
          output.push(
            'tokens' in token && Array.isArray(token.tokens)
              ? { ...token, tokens: visit(token.tokens) }
              : token,
          )
      }
    }
    return output
  }
  return {
    tokens: Object.assign(visit(source), { links: source.links }),
    addresses: [...addresses],
  }
}
