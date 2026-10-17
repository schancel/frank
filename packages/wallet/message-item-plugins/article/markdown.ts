export type ArticleInlineNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly ArticleInlineNode[] }
  | { readonly type: 'em'; readonly children: readonly ArticleInlineNode[] }
  | { readonly type: 'del'; readonly children: readonly ArticleInlineNode[] }
  | { readonly type: 'code'; readonly code: string }
  | {
      readonly type: 'link'
      readonly href: string
      readonly children: readonly ArticleInlineNode[]
    }

export interface ArticleListItem {
  readonly checked: boolean | null
  readonly inlines: readonly ArticleInlineNode[]
}

export type ArticleTableAlignment = 'left' | 'center' | 'right' | null

export type ArticleMarkdownBlock =
  | {
      readonly type: 'heading'
      readonly level: 1 | 2 | 3 | 4 | 5 | 6
      readonly id: string
      readonly text: string
      readonly inlines: readonly ArticleInlineNode[]
    }
  | {
      readonly type: 'paragraph'
      readonly inlines: readonly ArticleInlineNode[]
    }
  | {
      readonly type: 'code-block'
      readonly language: string
      readonly code: string
    }
  | {
      readonly type: 'blockquote'
      readonly inlines: readonly ArticleInlineNode[]
    }
  | {
      readonly type: 'list'
      readonly ordered: boolean
      readonly start: number
      readonly items: readonly ArticleListItem[]
    }
  | {
      readonly type: 'table'
      readonly headers: readonly (readonly ArticleInlineNode[])[]
      readonly alignments: readonly ArticleTableAlignment[]
      readonly rows: readonly (readonly (readonly ArticleInlineNode[])[])[]
    }
  | {
      readonly type: 'hr'
    }

const ALLOWED_URL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])
const MAX_URL_LENGTH = 2048

export function escapeHtmlEntities(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Validates and normalizes a candidate link URL against the strict scheme allowlist
 * (`https:`, `http:`, `mailto:`). Rejects `javascript:`, `data:`, `vbscript:`, `file:`,
 * relative protocol-less URLs, credentials, and control characters.
 */
export function sanitizeArticleUrl(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_URL_LENGTH ||
    /[\u0000-\u0020\u007f]/.test(trimmed)
  ) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

export function slugifyHeading(
  rawText: string,
  seenCounts?: Map<string, number>,
): string {
  const normalized = rawText
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = normalized.length > 0 ? `heading-${normalized}` : 'heading-section'
  if (!seenCounts) return base
  const count = (seenCounts.get(base) ?? 0) + 1
  seenCounts.set(base, count)
  return count === 1 ? base : `${base}-${count}`
}

function findClosingParen(text: string, openParenIndex: number): number {
  let depth = 0
  for (let i = openParenIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

export function parseArticleInlines(text: string): ArticleInlineNode[] {
  const nodes: ArticleInlineNode[] = []
  let cursor = 0

  const pushText = (fragment: string) => {
    if (fragment.length === 0) return
    const previous = nodes[nodes.length - 1]
    if (previous && previous.type === 'text') {
      nodes[nodes.length - 1] = {
        type: 'text',
        text: previous.text + fragment,
      }
    } else {
      nodes.push({ type: 'text', text: fragment })
    }
  }

  while (cursor < text.length) {
    const remaining = text.slice(cursor)

    // Inline code: `code`
    if (remaining.startsWith('`')) {
      const closeIdx = remaining.indexOf('`', 1)
      if (closeIdx > 0) {
        nodes.push({
          type: 'code',
          code: remaining.slice(1, closeIdx),
        })
        cursor += closeIdx + 1
        continue
      }
    }

    // Image syntax ![alt](url) -> never auto-load external image beacons; degrade to text/link
    if (remaining.startsWith('![')) {
      const closeBracket = remaining.indexOf('](', 2)
      if (closeBracket >= 2) {
        const closeParen = findClosingParen(remaining, closeBracket + 1)
        if (closeParen > closeBracket + 2) {
          const altText = remaining.slice(2, closeBracket).trim() || 'image'
          const rawUrl = remaining.slice(closeBracket + 2, closeParen)
          const safeHref = sanitizeArticleUrl(rawUrl)
          if (safeHref) {
            nodes.push({
              type: 'link',
              href: safeHref,
              children: [{ type: 'text', text: `[Image: ${altText}]` }],
            })
          } else {
            pushText(`[Image: ${altText}]`)
          }
          cursor += closeParen + 1
          continue
        }
      }
    }

    // Link syntax [label](url)
    if (remaining.startsWith('[')) {
      const closeBracket = remaining.indexOf('](', 1)
      if (closeBracket >= 1) {
        const closeParen = findClosingParen(remaining, closeBracket + 1)
        if (closeParen > closeBracket + 1) {
          const labelSource = remaining.slice(1, closeBracket)
          const rawUrl = remaining.slice(closeBracket + 2, closeParen)
          const safeHref = sanitizeArticleUrl(rawUrl)
          const labelChildren = parseArticleInlines(labelSource)
          if (safeHref) {
            nodes.push({
              type: 'link',
              href: safeHref,
              children:
                labelChildren.length > 0
                  ? labelChildren
                  : [{ type: 'text', text: safeHref }],
            })
          } else {
            // Disallowed scheme (e.g. javascript:, data:, vbscript:, file:): keep label text only
            for (const child of labelChildren) {
              if (child.type === 'text') pushText(child.text)
              else nodes.push(child)
            }
          }
          cursor += closeParen + 1
          continue
        }
      }
    }

    // Bold **...**
    if (remaining.startsWith('**')) {
      const closeIdx = remaining.indexOf('**', 2)
      if (closeIdx > 2) {
        nodes.push({
          type: 'strong',
          children: parseArticleInlines(remaining.slice(2, closeIdx)),
        })
        cursor += closeIdx + 2
        continue
      }
    }

    // Strikethrough ~~...~~
    if (remaining.startsWith('~~')) {
      const closeIdx = remaining.indexOf('~~', 2)
      if (closeIdx > 2) {
        nodes.push({
          type: 'del',
          children: parseArticleInlines(remaining.slice(2, closeIdx)),
        })
        cursor += closeIdx + 2
        continue
      }
    }

    // Italic *...*
    if (remaining.startsWith('*') && !remaining.startsWith('**')) {
      const closeIdx = remaining.indexOf('*', 1)
      if (closeIdx > 1) {
        nodes.push({
          type: 'em',
          children: parseArticleInlines(remaining.slice(1, closeIdx)),
        })
        cursor += closeIdx + 1
        continue
      }
    }

    pushText(remaining[0]!)
    cursor += 1
  }

  return nodes
}

function inlinePlainText(nodes: readonly ArticleInlineNode[]): string {
  return nodes
    .map(node => {
      switch (node.type) {
        case 'text':
          return node.text
        case 'code':
          return node.code
        case 'strong':
        case 'em':
        case 'del':
        case 'link':
          return inlinePlainText(node.children)
      }
    })
    .join('')
}

function splitTableCells(rowLine: string): string[] {
  const trimmed = rowLine.trim()
  const withoutOuterPipes = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
  return withoutOuterPipes.split('|').map(cell => cell.trim())
}

function parseTableSeparator(
  line: string,
  expectedColumns: number,
): ArticleTableAlignment[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|') && !trimmed.includes('-')) return null
  const rawCells = splitTableCells(trimmed)
  if (rawCells.length !== expectedColumns || expectedColumns === 0) return null
  const alignments: ArticleTableAlignment[] = []
  for (const cell of rawCells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) alignments.push('center')
    else if (right) alignments.push('right')
    else if (left) alignments.push('left')
    else alignments.push(null)
  }
  return alignments
}

function isBlockBoundary(line: string, nextLine?: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  if (/^```/.test(trimmed)) return true
  if (/^#{1,6}\s+\S/.test(trimmed)) return true
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true
  if (/^>\s?/.test(trimmed)) return true
  if (/^(?:[-*+]\s+|\d+\.\s+)/.test(trimmed)) return true
  if (trimmed.includes('|') && nextLine !== undefined) {
    const headerCells = splitTableCells(trimmed)
    if (parseTableSeparator(nextLine, headerCells.length) !== null) {
      return true
    }
  }
  return false
}

/**
 * Deterministically parses a Markdown string into a safe block/inline AST.
 * Raw HTML is never interpreted as markup; all text remains plain text or
 * explicitly whitelisted inline nodes.
 */
export function parseArticleMarkdown(
  markdown: string,
): ArticleMarkdownBlock[] {
  if (typeof markdown !== 'string' || markdown.length === 0) {
    return []
  }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ArticleMarkdownBlock[] = []
  const slugCounts = new Map<string, number>()
  let index = 0

  while (index < lines.length) {
    const rawLine = lines[index] ?? ''
    const trimmed = rawLine.trim()

    if (trimmed.length === 0) {
      index += 1
      continue
    }

    // Fenced code block: ```lang
    const fenceMatch = /^```([A-Za-z0-9_+-]{0,32})\s*$/.exec(trimmed)
    if (fenceMatch) {
      const language = (fenceMatch[1] ?? '').toLowerCase()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] ?? ''
        if (/^```\s*$/.test(candidate.trim())) {
          index += 1
          break
        }
        codeLines.push(candidate)
        index += 1
      }
      blocks.push({
        type: 'code-block',
        language,
        code: codeLines.join('\n'),
      })
      continue
    }

    // Horizontal rule
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    // Heading: # .. ######
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed)
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6
      const source = headingMatch[2]!
      const inlines = parseArticleInlines(source)
      const plain = inlinePlainText(inlines)
      const id = slugifyHeading(plain || source, slugCounts)
      blocks.push({
        type: 'heading',
        level,
        id,
        text: plain,
        inlines,
      })
      index += 1
      continue
    }

    // Pipe table: header row + separator row + 0..N body rows
    if (trimmed.includes('|') && index + 1 < lines.length) {
      const headerCells = splitTableCells(trimmed)
      const alignments = parseTableSeparator(
        lines[index + 1] ?? '',
        headerCells.length,
      )
      if (alignments !== null) {
        const headers = headerCells.map(cell => parseArticleInlines(cell))
        const rows: ArticleInlineNode[][][] = []
        index += 2
        while (index < lines.length) {
          const rowLine = (lines[index] ?? '').trim()
          if (rowLine.length === 0 || !rowLine.includes('|')) break
          const rawRowCells = splitTableCells(rowLine)
          const normalizedRow = headers.map((_, colIdx) =>
            parseArticleInlines(rawRowCells[colIdx] ?? ''),
          )
          rows.push(normalizedRow)
          index += 1
        }
        blocks.push({
          type: 'table',
          headers,
          alignments,
          rows,
        })
        continue
      }
    }

    // Blockquote: > ...
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const candidate = (lines[index] ?? '').trim()
        if (!/^>\s?/.test(candidate)) break
        quoteLines.push(candidate.replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({
        type: 'blockquote',
        inlines: parseArticleInlines(quoteLines.join('\n')),
      })
      continue
    }

    // Unordered or ordered list (with optional task list checkboxes)
    const unorderedMatch = /^[-*+]\s+(.*)$/.exec(trimmed)
    const orderedMatch = /^(\d+)\.\s+(.*)$/.exec(trimmed)
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch)
      const start = orderedMatch ? Number.parseInt(orderedMatch[1]!, 10) || 1 : 1
      const items: ArticleListItem[] = []

      while (index < lines.length) {
        const candidate = (lines[index] ?? '').trim()
        const itemMatch = ordered
          ? /^\d+\.\s+(.*)$/.exec(candidate)
          : /^[-*+]\s+(.*)$/.exec(candidate)
        if (!itemMatch) break
        const itemBody = itemMatch[1]!
        const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemBody)
        if (taskMatch) {
          const checked = taskMatch[1]!.toLowerCase() === 'x'
          items.push({
            checked,
            inlines: parseArticleInlines(taskMatch[2]!),
          })
        } else {
          items.push({
            checked: null,
            inlines: parseArticleInlines(itemBody),
          })
        }
        index += 1
      }

      blocks.push({
        type: 'list',
        ordered,
        start,
        items,
      })
      continue
    }

    // Paragraph: collect contiguous non-boundary lines
    const paragraphLines: string[] = [trimmed]
    index += 1
    while (
      index < lines.length &&
      !isBlockBoundary(lines[index] ?? '', lines[index + 1])
    ) {
      paragraphLines.push((lines[index] ?? '').trim())
      index += 1
    }
    blocks.push({
      type: 'paragraph',
      inlines: parseArticleInlines(paragraphLines.join(' ')),
    })
  }

  return blocks
}

function renderInlinesToHtml(inlines: readonly ArticleInlineNode[]): string {
  return inlines
    .map(node => {
      switch (node.type) {
        case 'text':
          return escapeHtmlEntities(node.text)
        case 'code':
          return `<code>${escapeHtmlEntities(node.code)}</code>`
        case 'strong':
          return `<strong>${renderInlinesToHtml(node.children)}</strong>`
        case 'em':
          return `<em>${renderInlinesToHtml(node.children)}</em>`
        case 'del':
          return `<del>${renderInlinesToHtml(node.children)}</del>`
        case 'link': {
          const safeHref = sanitizeArticleUrl(node.href)
          if (!safeHref) return renderInlinesToHtml(node.children)
          return `<a href="${escapeHtmlEntities(
            safeHref,
          )}" target="_blank" rel="noopener noreferrer">${renderInlinesToHtml(
            node.children,
          )}</a>`
        }
      }
    })
    .join('')
}

/**
 * Renders Markdown to strictly entity-escaped, zero-XSS HTML for deterministic snapshots
 * or non-Vue consumers. Raw HTML tags in source Markdown are always escaped.
 */
export function renderArticleMarkdownToHtml(markdown: string): string {
  const blocks = parseArticleMarkdown(markdown)
  return blocks
    .map(block => {
      switch (block.type) {
        case 'heading':
          return `<h${block.level} id="${escapeHtmlEntities(
            block.id,
          )}">${renderInlinesToHtml(block.inlines)}</h${block.level}>`
        case 'paragraph':
          return `<p>${renderInlinesToHtml(block.inlines)}</p>`
        case 'code-block': {
          const langAttr = block.language
            ? ` class="language-${escapeHtmlEntities(block.language)}"`
            : ''
          return `<pre><code${langAttr}>${escapeHtmlEntities(
            block.code,
          )}</code></pre>`
        }
        case 'blockquote':
          return `<blockquote><p>${renderInlinesToHtml(
            block.inlines,
          )}</p></blockquote>`
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul'
          const startAttr =
            block.ordered && block.start !== 1 ? ` start="${block.start}"` : ''
          const itemsHtml = block.items
            .map(item => {
              if (item.checked === null) {
                return `<li>${renderInlinesToHtml(item.inlines)}</li>`
              }
              const checkedAttr = item.checked ? ' checked' : ''
              return `<li class="task-list-item"><input type="checkbox" disabled${checkedAttr} /> ${renderInlinesToHtml(
                item.inlines,
              )}</li>`
            })
            .join('')
          return `<${tag}${startAttr}>${itemsHtml}</${tag}>`
        }
        case 'table': {
          const headHtml = block.headers
            .map((cell, idx) => {
              const align = block.alignments[idx]
              const alignAttr = align ? ` style="text-align:${align}"` : ''
              return `<th${alignAttr}>${renderInlinesToHtml(cell)}</th>`
            })
            .join('')
          const bodyHtml = block.rows
            .map(
              row =>
                `<tr>${row
                  .map((cell, idx) => {
                    const align = block.alignments[idx]
                    const alignAttr = align
                      ? ` style="text-align:${align}"`
                      : ''
                    return `<td${alignAttr}>${renderInlinesToHtml(cell)}</td>`
                  })
                  .join('')}</tr>`,
            )
            .join('')
          return `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`
        }
        case 'hr':
          return '<hr />'
      }
    })
    .join('\n')
}
