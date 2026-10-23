/**
 * A text item is the canonical type-22 frame, written by the same function the canonical direct
 * message path uses today, so the bytes are identical.
 */
import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { TextItem } from '@frank/cashweb/types/messages'
import { TYPE_TEXT_MESSAGE_ITEM } from '@frank/codec'

import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '@frank/cashweb/message-items/registry'
import { openItemFrame } from '../shared/frame'

export function encodeTextItem(item: TextItem): Uint8Array {
  return directMessageText(item.text)
}

export function decodeTextItem(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): TextItem {
  const parsed = openItemFrame('text', bytes, context)
  if (parsed.typed?.type !== TYPE_TEXT_MESSAGE_ITEM)
    throw new MessageItemDecodeError('text', 'not a text item frame')
  return { type: 'text', text: parsed.typed.text }
}
