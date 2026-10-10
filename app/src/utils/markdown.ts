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

/**
 * The one sanitiser. With `onlyImages`, the content may make the browser fetch nothing: the
 * only pictures kept are `<img>` whose source is exactly one of the given data URIs, and
 * everything else that could load a resource (other sources, `srcset`, media and form elements,
 * style sheets, inline styles other than this renderer's own) is removed.
 */
function sanitize(
  html: string,
  onlyImages?: ReadonlySet<string>,
  ownStyles: readonly string[] = [],
): string {
  if (!onlyImages) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], RETURN_DOM: false })
  }
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (!('getAttribute' in node)) return
    const style = node.getAttribute('style')
    if (style !== null && !ownStyles.includes(style))
      node.removeAttribute('style')
    if (!node.hasAttribute('src')) return
    if (node.nodeName !== 'IMG') node.removeAttribute('src')
    else if (!onlyImages.has(node.getAttribute('src') ?? '')) node.remove()
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
 * `onlyImages` is for content from someone else that must not make the browser fetch anything
 * (a direct message): the listed data URIs are the only pictures shown. Any other Markdown
 * image is written out instead: a web address as a link, anything else as the text it was.
 */
export function renderMarkdown(
  input: string,
  linkColor: boolean,
  lineBreaks = false,
  onlyImages?: readonly string[],
) {
  // A picture is large; the cache is for text.
  const cacheable = !onlyImages || onlyImages.length === 0
  const cacheKey = `${linkColor ? 1 : 0}${lineBreaks ? 'b' : ''}${
    onlyImages ? 'i' : ''
  }:${input}`
  const cached = cacheable ? cache.get(cacheKey) : undefined
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
  const allowed = onlyImages ? new Set(onlyImages) : undefined
  if (allowed) {
    // `text` arrives escaped from marked; `href` does not.
    renderer.image = (href, _title, text) => {
      const source = href ?? ''
      if (allowed.has(source)) {
        return '<img src="' + source + '" alt="' + text + '">'
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
  if (!cacheable) return result
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
 * Sanitises HTML. With `onlyImages` it also keeps the content from fetching anything, as
 * `renderMarkdown` does.
 */
export function purify(input: string, onlyImages?: readonly string[]) {
  return onlyImages
    ? sanitize(input, new Set(onlyImages))
    : DOMPurify.sanitize(input)
}
