/**
 * A text item is the canonical type-17 frame, written by the same function the canonical direct
 * message path uses today, so the bytes are identical.
 */
import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { TextItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError } from '../registry'
import { openItemFrame } from '../shared/frame'

export function encodeTextItem(item: TextItem): Uint8Array {
  return directMessageText(item.text)
}

export function decodeTextItem(bytes: Uint8Array): TextItem {
  const parsed = openItemFrame('text', bytes)
  if (parsed.typed?.type !== 17)
    throw new MessageItemDecodeError('text', 'not a text item frame')
  return { type: 'text', text: parsed.typed.text }
}
