/**
 * A channel update is the canonical type-24 frame, written and projected by the same functions the
 * canonical direct message path uses today, so the bytes are identical.
 */
import {
  encodeChannelUpdateItem,
  isChannelUpdateItemFrame,
  projectChannelUpdateItem,
} from '@frank/codec'
import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  type MessageItemDecodeContext,
} from '../registry'
import { decodeWith, openItemFrame } from '../shared/frame'

export function encodeChannelUpdate(item: ChannelUpdateItem): Uint8Array {
  return encodeChannelUpdateItem(item)
}

export function decodeChannelUpdate(
  bytes: Uint8Array,
  context: MessageItemDecodeContext,
): ChannelUpdateItem {
  const parsed = openItemFrame('channel-update', bytes, context)
  if (!isChannelUpdateItemFrame(parsed))
    throw new MessageItemDecodeError(
      'channel-update',
      'not a channel update item frame',
    )
  return decodeWith('channel-update', () => projectChannelUpdateItem(parsed))
}
