import { encodeFrame, validateFrame, standaloneItemBudget, TYPE_MESSAGE_CONTENT_REVISION } from '@frank/codec'
import type { MessageItem } from '@frank/cashweb/types/messages'
import { encodeItemFrames, decodeItemFrames } from '@frank/wallet/message-item-plugins/wire'
import { messageItems } from './message-items'

/** Group content uses the same composed item codecs and limits as direct messages. */
export function encodeGroupItems(items: MessageItem[]): Uint8Array {
  const children = encodeItemFrames(messageItems, items)
  return encodeFrame({ typeId: TYPE_MESSAGE_CONTENT_REVISION, schemaVersion: 1, minReaderVersion: 1 }, new Map<number, string | Uint8Array[]>([[0, 'frank'], [1, children]]))
}

export function decodeGroupItems(payload: Uint8Array): MessageItem[] {
  const frame = validateFrame(payload)
  if (frame.kind !== 'parsed' || frame.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION) throw new Error('Invalid group message content')
  return decodeItemFrames(messageItems, frame.typed.items, standaloneItemBudget())
}
