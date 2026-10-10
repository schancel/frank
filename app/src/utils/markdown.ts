import * as marked from 'marked'
import DOMPurify from 'dompurify'

import { colors } from 'quasar'
const { getPaletteColor } = colors

const MAX_CACHE_ENTRIES = 1000
const cache = new Map<string, string>()

export function clearMarkdownCache() {
  cache.clear()
}

const QUOTE_STYLE =
  'border-left: 2px solid; padding-left:8px; margin-left: 4px;'
const linkStyle = (colorHex: string) => 'color: ' + colorHex

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** The attribute a picture placeholder carries: the ID of an attachment of the same message. */
export const ATTACHMENT_ATTRIBUTE = 'data-attachment'
const ATTACHMENT_SOURCE = /^attachment:([a-zA-Z0-9_-]+)$/

/**
 * The one sanitiser. With `attachments`, the content may make the browser fetch nothing. No
 * `<img>` leaves here with a source at all: the only pictures kept are placeholders naming one
 * of the given attachment IDs, which the caller fills in afterwards from the message's own
 * attachments. Everything else that could load a resource (any `src`, `srcset`, media and form
 * elements, style sheets, inline styles other than this renderer's own) is removed.
 */
function sanitize(
  html: string,
  attachments?: ReadonlySet<string>,
  ownStyles: readonly string[] = [],
): string {
  if (!attachments) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], RETURN_DOM: false })
  }
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (!('getAttribute' in node)) return
    const style = node.getAttribute('style')
    if (style !== null && !ownStyles.includes(style))
      node.removeAttribute('style')
    if (node.nodeName === 'IMG') {
      const id = node.getAttribute(ATTACHMENT_ATTRIBUTE)
      if (node.hasAttribute('src') || id === null || !attachments.has(id))
        node.remove()
      return
    }
    node.removeAttribute('src')
    node.removeAttribute(ATTACHMENT_ATTRIBUTE)
  })
  try {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target'],
      FORBID_TAGS: [
        'style',
        'video',
        'audio',
        'source',
        'track',
        'picture',
        'input',
        'form',
      ],
      FORBID_ATTR: ['srcset', 'background', 'poster'],
      RETURN_DOM: false,
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

/**
 * `lineBreaks` renders a single newline as a line break, the way a chat reads (a bot's list of
 * commands, a message typed on several lines); without it a newline inside a paragraph is a
 * space, as Markdown documents (posts, email) expect.
 *
 * `attachments` is for content from someone else that must not make the browser fetch anything
 * (a direct message): the IDs of the message's own pictures that may be shown. A reference
 * `![name](attachment:ID)` to one of them becomes an `<img>` placeholder with no source, marked
 * with `ATTACHMENT_ATTRIBUTE`; the caller sets the picture on it afterwards. The picture's bytes
 * never pass through here, so the HTML stays about the size of the text however often one
 * picture is referenced. Any other Markdown image is written out instead: a web address as a
 * link, anything else as the text it was.
 */
export function renderMarkdown(
  input: string,
  linkColor: boolean,
  lineBreaks = false,
  attachments?: readonly string[],
) {
  const cacheKey = `${linkColor ? 1 : 0}${lineBreaks ? 'b' : ''}${
    attachments ? `i${attachments.join(',')}` : ''
  }:${input}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    cache.delete(cacheKey)
    cache.set(cacheKey, cached)
    return cached
  }

  const renderer = new marked.Renderer()
  // linkColor boolean is true if dark, false otherwise
  const linkColorName = linkColor ? 'blue-2' : 'blue'
  const linkColorHex = getPaletteColor(linkColorName)
  renderer.link = (href, title, text) => {
    let link = '<a target="_blank" '
    // link
    link += 'href="' + href + '" '
    // style
    link += 'style="' + linkStyle(linkColorHex) + '" '
    // Close a tag and return with text
    return link + '>' + text + '</a>'
  }
  renderer.blockquote = text => {
    return '<div class="quote" style="' + QUOTE_STYLE + '">' + text + '</div>'
  }
  const allowed = attachments ? new Set(attachments) : undefined
  if (allowed) {
    // `text` arrives escaped from marked; `href` does not.
    renderer.image = (href, _title, text) => {
      const source = href ?? ''
      const id = ATTACHMENT_SOURCE.exec(source)?.[1]
      if (id !== undefined && allowed.has(id)) {
        return (
          '<img ' + ATTACHMENT_ATTRIBUTE + '="' + id + '" alt="' + text + '">'
        )
      }
      if (/^https?:\/\//i.test(source)) {
        return renderer.link(
          escapeHtml(source),
          null,
          text || escapeHtml(source),
        )
      }
      const shown = source.length > 80 ? source.slice(0, 80) + '…' : source
      return '![' + text + '](' + escapeHtml(shown) + ')'
    }
  }
  const result = sanitize(
    marked.marked(input, { renderer: renderer, breaks: lineBreaks }),
    allowed,
    [QUOTE_STYLE, linkStyle(linkColorHex)],
  )
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey !== undefined) {
      cache.delete(oldestKey)
    }
  }
  cache.set(cacheKey, result)
  return result
}

/**
 * Sanitises HTML. With `attachments` it also keeps the content from fetching anything, as
 * `renderMarkdown` does.
 */
export function purify(input: string, attachments?: readonly string[]) {
  return attachments
    ? sanitize(input, new Set(attachments))
    : DOMPurify.sanitize(input)
}
