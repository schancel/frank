import { isMimeType } from './mime-type'
// Type 27: the generic plugin message item (README E5, direct-message.cddl `plugin-message-item`).
// The container names an application item type and carries that plugin's own bytes. The codec
// validates the container; it never interprets the bytes, whatever encoding the plugin chose.
import { cborMap } from './cbor'
import {
  MAX_PLUGIN_ITEM_DATA_BYTES,
  PLUGIN_MESSAGE_ITEM,
  TYPE_PLUGIN_MESSAGE_ITEM,
} from './constants'
import { FrankCodecError } from './errors'
import { encodeFrame } from './frame'
import { isPluginItemType } from './schema'
import type { ParsedFrame, PluginMessageItem, ValidationResult } from './types'
import { parseFrame } from './validate'

export { isPluginItemType }

const bad = (message: string) =>
  new FrankCodecError('schema', '8.2', message, 'plugin-item/writer')

/** One complete type-27 frame for `data`, the bytes the plugin registered for `itemType` wrote. */
export function encodePluginMessageItem(item: {
  itemType: string
  data: Uint8Array
  mimeType?: string
}): Uint8Array {
  if (item === null || typeof item !== 'object')
    throw bad('expected an item object')
  if (!isPluginItemType(item.itemType))
    throw bad(
      'itemType must be 1..64 lowercase letters and digits in hyphen-separated groups',
    )
  if (item.mimeType !== undefined && !isMimeType(item.mimeType)) throw bad('invalid MIME type')
  if (!(item.data instanceof Uint8Array)) throw bad('data must be bytes')
  if (item.data.length > MAX_PLUGIN_ITEM_DATA_BYTES)
    throw bad(
      `data exceeds the maximum of ${MAX_PLUGIN_ITEM_DATA_BYTES} bytes`,
    )
  const bytes = encodeFrame(
    {
      typeId: TYPE_PLUGIN_MESSAGE_ITEM,
      schemaVersion: 1,
      minReaderVersion: 1,
    },
    cborMap([
      [PLUGIN_MESSAGE_ITEM.itemType, item.itemType],
      [PLUGIN_MESSAGE_ITEM.data, new Uint8Array(item.data)],
      ...(item.mimeType === undefined ? [] : [[PLUGIN_MESSAGE_ITEM.mimeType, item.mimeType] as [number, string]]),
    ]),
  )
  parseFrame(bytes)
  return bytes
}

export function isPluginMessageItemFrame(
  frame: ValidationResult,
): frame is ParsedFrame & { typed: PluginMessageItem } {
  return (
    frame.kind === 'parsed' &&
    frame.typeId === TYPE_PLUGIN_MESSAGE_ITEM &&
    frame.typed?.type === TYPE_PLUGIN_MESSAGE_ITEM
  )
}

/** Semantic type, common MIME metadata and a copy of the opaque plugin bytes. */
export function projectPluginMessageItem(frame: ParsedFrame): {
  itemType: string
  data: Uint8Array
  mimeType?: string
} {
  if (!isPluginMessageItemFrame(frame))
    throw bad('frame is not a valid plugin message item')
  return {
    itemType: frame.typed.itemType,
    data: new Uint8Array(frame.typed.data),
    ...(frame.typed.mimeType === undefined ? {} : { mimeType: frame.typed.mimeType }),
  }
}
