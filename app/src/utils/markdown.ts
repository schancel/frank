import * as marked from 'marked'
import DOMPurify from 'dompurify'

import { colors } from 'quasar'
const { getPaletteColor } = colors

const MAX_CACHE_ENTRIES = 1000
const cache = new Map<string, string>()

export function clearMarkdownCache() {
  cache.clear()
}

/**
 * `lineBreaks` renders a single newline as a line break, the way a chat reads (a bot's list of
 * commands, a message typed on several lines); without it a newline inside a paragraph is a
 * space, as Markdown documents (posts, email) expect.
 */
export function renderMarkdown(
  input: string,
  linkColor: boolean,
  lineBreaks = false,
) {
  const cacheKey = `${linkColor ? 1 : 0}${lineBreaks ? 'b' : ''}:${input}`
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
    link += 'style="color: ' + linkColorHex + '" '
    // Close a tag and return with text
    return link + '>' + text + '</a>'
  }
  renderer.blockquote = text => {
    return (
      '<div class="quote" style="border-left: 2px solid; padding-left:8px; margin-left: 4px;">' +
      text +
      '</div>'
    )
  }
  const result = DOMPurify.sanitize(
    marked.marked(input, { renderer: renderer, breaks: lineBreaks }),
    {
      ADD_ATTR: ['target'],
      RETURN_DOM: false,
    },
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

export function purify(input: string) {
  return DOMPurify.sanitize(input)
}
