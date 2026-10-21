import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { addressMentionTokens } from './address-mentions'

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
 * The attribute an external picture's placeholder carries: the web address of the picture, which
 * is never in a `src` until the reader asks for it (`utils/external-images.ts`).
 */
export const EXTERNAL_IMAGE_ATTRIBUTE = 'data-external-image'
const EXTERNAL_IMAGE_ALT = 'data-external-alt'
const WEB_ADDRESS = /^https?:\/\//i
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[;,]/i

/** Writes the click-to-load placeholder for an external picture. Its words are filled in later. */
function externalImagePlaceholder(
  doc: Document,
  url: string,
  alt: string,
): HTMLElement | undefined {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return undefined
  }
  const placeholder = doc.createElement('span')
  placeholder.className = 'external-image'
  placeholder.setAttribute(EXTERNAL_IMAGE_ATTRIBUTE, url)
  if (alt) placeholder.setAttribute(EXTERNAL_IMAGE_ALT, alt)
  placeholder.setAttribute('role', 'button')
  placeholder.setAttribute('tabindex', '0')
  placeholder.setAttribute(
    'style',
    'display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; ' +
      'border: 1px dashed currentColor; border-radius: 4px; cursor: pointer; ' +
      'font-size: 0.9em; opacity: 0.8; max-width: 100%;',
  )
  const icon = doc.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '⚠'
  const label = doc.createElement('span')
  label.className = 'external-image__label'
  const shownHost = doc.createElement('span')
  shownHost.className = 'external-image__host'
  shownHost.setAttribute('style', 'font-weight: 600; overflow-wrap: anywhere;')
  shownHost.textContent = host
  placeholder.append(icon, label, shownHost)
  return placeholder
}

/**
 * Removes from CSS everything that could load a resource: a declaration or rule part naming
 * `url(`, `image-set(` or `@import` is dropped, and so is any part with a CSS escape, which could
 * spell one of them. What is left is cut only at `;`, `{` and `}`, which are kept, so two kept
 * parts never join into one of those words.
 */
export function scrubCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/([;{}])/)
    .filter(part => !/url\s*\(|image-set\s*\(|@import|\\/i.test(part))
    .join('')
}

interface SanitizeOptions {
  /**
   * A direct message: the IDs of its own pictures, the only pictures it shows besides external
   * placeholders. Its text cannot carry a picture's bytes inline (`data:`).
   */
  attachments?: ReadonlySet<string>
  /** An email: its own picture parts by Content-ID, as `data:image` URIs, for `cid:` sources. */
  contentIds?: ReadonlyMap<string, string>
  /** The style attributes this renderer wrote itself; Markdown keeps no other. */
  ownStyles?: readonly string[]
  /**
   * An HTML email, shown in its own frame: its style sheets and inline styles stay, with
   * everything that could load a resource taken out of them.
   */
  document?: boolean
}

/** `cid:part@example` as the Content-ID it names, without angle brackets. */
export function contentIdKey(id: string): string {
  return id.trim().replace(/^<|>$/g, '').trim()
}

function cidOf(source: string): string | undefined {
  if (!/^cid:/i.test(source)) return undefined
  try {
    return contentIdKey(decodeURIComponent(source.slice(4)))
  } catch {
    return contentIdKey(source.slice(4))
  }
}

/**
 * The one sanitiser: content from someone else never makes the browser fetch anything by itself.
 * Every way of loading an address is removed (`src` and `srcset` on any element, `background`,
 * `poster`, media, frames, objects, style sheet links, `<meta>` refresh, `<base>`, SVG, CSS
 * `url()` and `@import`). A picture survives only as one of:
 * - a placeholder with no source naming one of the message's own `attachments`, which the caller
 *   fills in from the attachment;
 * - an inline `data:image` picture (not in a direct message), or an email's own `cid:` part
 *   resolved to one;
 * - for a web (http/https) address, a click-to-load placeholder carrying the address in
 *   `EXTERNAL_IMAGE_ATTRIBUTE`, never in `src`.
 * Links stay and open in a new tab without telling the target where they came from.
 */
function sanitize(html: string, options: SanitizeOptions = {}): string {
  const { attachments, contentIds, ownStyles = [], document = false } = options
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style')
      node.textContent = scrubCss(node.textContent ?? '')
  })
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (!('getAttribute' in node)) return
    node.removeAttribute(EXTERNAL_IMAGE_ATTRIBUTE)
    node.removeAttribute(EXTERNAL_IMAGE_ALT)
    const style = node.getAttribute('style')
    if (style !== null) {
      const kept = document
        ? scrubCss(style)
        : ownStyles.includes(style)
        ? style
        : ''
      if (kept.trim()) node.setAttribute('style', kept)
      else node.removeAttribute('style')
    }
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
    if (node.nodeName !== 'IMG') {
      node.removeAttribute('src')
      node.removeAttribute(ATTACHMENT_ATTRIBUTE)
      return
    }
    const source = node.getAttribute('src') ?? ''
    const id = node.getAttribute(ATTACHMENT_ATTRIBUTE)
    node.removeAttribute('src')
    if (!source && id !== null && attachments?.has(id)) return
    node.removeAttribute(ATTACHMENT_ATTRIBUTE)
    if (WEB_ADDRESS.test(source)) {
      node.setAttribute(EXTERNAL_IMAGE_ATTRIBUTE, source)
      return
    }
    const cid = cidOf(source)
    const inline =
      cid !== undefined
        ? contentIds?.get(cid)
        : !attachments && DATA_IMAGE.test(source)
        ? source
        : undefined
    if (inline !== undefined && DATA_IMAGE.test(inline))
      node.setAttribute('src', inline)
    else node.remove()
  })
  try {
    const body = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target'],
      FORBID_TAGS: [
        ...(document ? [] : ['style']),
        'link',
        'meta',
        'base',
        'iframe',
        'frame',
        'object',
        'embed',
        'video',
        'audio',
        'source',
        'track',
        'picture',
        'input',
        'form',
      ],
      FORBID_ATTR: [
        'srcset',
        'background',
        'poster',
        'lowsrc',
        'dynsrc',
        'ping',
        'action',
        'formaction',
        'xlink:href',
      ],
      FORCE_BODY: document,
      RETURN_DOM: true,
    })
    body.querySelectorAll(`img[${EXTERNAL_IMAGE_ATTRIBUTE}]`).forEach(image => {
      const placeholder = externalImagePlaceholder(
        body.ownerDocument,
        image.getAttribute(EXTERNAL_IMAGE_ATTRIBUTE) ?? '',
        image.getAttribute('alt') ?? '',
      )
      if (placeholder) image.replaceWith(placeholder)
      else image.remove()
    })
    return body.innerHTML
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
    DOMPurify.removeHook('uponSanitizeElement')
  }
}

/**
 * `lineBreaks` renders a single newline as a line break, the way a chat reads (a bot's list of
 * commands, a message typed on several lines); without it a newline inside a paragraph is a
 * space, as Markdown documents (posts, email) expect.
 *
 * Nothing rendered here makes the browser fetch anything (see `sanitize`). A Markdown picture with
 * a web address becomes a click-to-load placeholder; one with a `data:image` source shows as it
 * is, except in a direct message.
 *
 * `attachments` is for a direct message: the IDs of the message's own pictures that may be shown.
 * A reference `![name](attachment:ID)` to one of them becomes an `<img>` placeholder with no
 * source, marked with `ATTACHMENT_ATTRIBUTE`; the caller sets the picture on it afterwards. The
 * picture's bytes never pass through here, so the HTML stays about the size of the text however
 * often one picture is referenced. Any other Markdown picture that is not a web address is
 * written out as the text it was.
 */
export function renderMarkdown(
  input: string,
  linkColor: boolean,
  lineBreaks = false,
  attachments?: readonly string[],
  mentionNames?: Readonly<Record<string, string>>,
) {
  const cacheKey = `${linkColor ? 1 : 0}${lineBreaks ? 'b' : ''}${
    attachments ? `i${attachments.join(',')}` : ''
  }:${
    mentionNames === undefined
      ? ''
      : JSON.stringify(Object.entries(mentionNames).sort())
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
  // `text` arrives escaped from marked; `href` does not.
  renderer.image = (href, _title, text) => {
    const source = href ?? ''
    const id = ATTACHMENT_SOURCE.exec(source)?.[1]
    if (id !== undefined && allowed?.has(id)) {
      return (
        '<img ' + ATTACHMENT_ATTRIBUTE + '="' + id + '" alt="' + text + '">'
      )
    }
    if (WEB_ADDRESS.test(source) || (!allowed && DATA_IMAGE.test(source))) {
      return '<img src="' + escapeHtml(source) + '" alt="' + text + '">'
    }
    const shown = source.length > 80 ? source.slice(0, 80) + '…' : source
    return '![' + text + '](' + escapeHtml(shown) + ')'
  }
  const result = sanitize(
    mentionNames === undefined
      ? marked(input, { renderer: renderer, breaks: lineBreaks })
      : marked.parser(
          addressMentionTokens(input, mentionNames, lineBreaks).tokens,
          { renderer: renderer, breaks: lineBreaks },
        ),
    { attachments: allowed, ownStyles: [QUOTE_STYLE, linkStyle(linkColorHex)] },
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
 * Sanitises an HTML fragment with the same rules as `renderMarkdown`; `attachments` as there.
 */
export function purify(input: string, attachments?: readonly string[]) {
  return sanitize(input, {
    attachments: attachments ? new Set(attachments) : undefined,
  })
}

/**
 * Sanitises an HTML email for its own frame. It keeps the email's styles, minus anything that
 * loads, and shows the pictures the email carries: `data:image` sources, and `cid:` references
 * resolved through `contentIds` (Content-ID, without angle brackets, to a `data:image` URI).
 */
export function purifyEmailHtml(
  input: string,
  contentIds: ReadonlyMap<string, string> = new Map(),
) {
  return sanitize(input, { contentIds, document: true })
}
