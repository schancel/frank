import * as marked from 'marked'
import DOMPurify from 'dompurify'

import { colors } from 'quasar'
import { MAX_MESSAGE_TEXT_BYTES } from './message-limits'
const { getPaletteColor } = colors

export function renderMarkdown(input: string, linkColor: boolean) {
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
  return DOMPurify.sanitize(marked.marked(input, { renderer: renderer }), {
    ADD_ATTR: ['target'],
    RETURN_DOM: false,
  })
}

export function purify(input: string) {
  return DOMPurify.sanitize(input)
}

/** How much of a message is shown when it cannot be rendered in full. */
export const TEXT_PREVIEW_CHARS = 4096

export type RenderedMessageText =
  | { kind: 'html'; html: string }
  /** Shown as plain text (never as HTML); `truncated` when only the start is shown. */
  | { kind: 'plain'; text: string; truncated: boolean }

function plainPreview(input: string): RenderedMessageText {
  let text = input.slice(0, TEXT_PREVIEW_CHARS)
  // Do not end on half of a surrogate pair.
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return { kind: 'plain', text, truncated: text.length < input.length }
}

/**
 * What a chat bubble shows for one text item. Never throws and never hands the markdown parser or
 * the sanitizer an enormous string: text longer than any message that can be sent (a stored item
 * from before the limit was enforced) and text the parser chokes on are shown as a plain-text
 * preview instead, so one bad stored message cannot blank the conversation.
 */
export function renderMessageText(
  input: string,
  dark: boolean,
  isReply = false,
): RenderedMessageText {
  if (input.length > MAX_MESSAGE_TEXT_BYTES) return plainPreview(input)
  try {
    return {
      kind: 'html',
      html: isReply ? purify(input) : renderMarkdown(input, dark),
    }
  } catch (err) {
    console.warn('message text could not be rendered; showing it plain', err)
    return plainPreview(input)
  }
}
