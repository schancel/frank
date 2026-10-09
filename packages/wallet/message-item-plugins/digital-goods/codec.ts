/**
 * A digital-goods item travels today as a type-17 text frame whose text is the item's JSON.
 * `encodeDigitalGoods` makes the same call the canonical direct message path makes, so the bytes
 * are identical. `decodeDigitalGoods` is the strict inverse: it accepts only such a frame holding
 * exactly a digital-goods item.
 */
import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError } from '../registry'
import { openItemFrame } from '../shared/frame'

export function encodeDigitalGoods(item: DigitalGoodsItem): Uint8Array {
  return directMessageText(JSON.stringify(item))
}

const ACTIONS = ['catalog', 'request', 'fulfill', 'error']
const ITEM_KEYS = ['type', 'action', 'catalog', 'itemId', 'message']
const ENTRY_KEYS = ['itemId', 'description', 'priceWei', 'thumbnail']

const bad = (detail: string) =>
  new MessageItemDecodeError('digital-goods', detail)

function plainObject(
  value: unknown,
  allowed: string[],
  what: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw bad(`${what} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw bad(`${what} has unknown field ${key}`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, what: string): void {
  if (value !== undefined && typeof value !== 'string')
    throw bad(`${what} must be text`)
}

export function decodeDigitalGoods(bytes: Uint8Array): DigitalGoodsItem {
  const parsed = openItemFrame('digital-goods', bytes)
  if (parsed.typed?.type !== 17) throw bad('not a text item frame')
  let json: unknown
  try {
    json = JSON.parse(parsed.typed.text)
  } catch {
    throw bad('text is not JSON')
  }
  const item = plainObject(json, ITEM_KEYS, 'item')
  if (item.type !== 'digital-goods') throw bad('type must be digital-goods')
  if (typeof item.action !== 'string' || !ACTIONS.includes(item.action))
    throw bad('unknown action')
  optionalString(item.itemId, 'itemId')
  optionalString(item.message, 'message')
  if (item.catalog !== undefined) {
    if (!Array.isArray(item.catalog)) throw bad('catalog must be an array')
    item.catalog.forEach((raw, i) => {
      const entry = plainObject(raw, ENTRY_KEYS, `catalog[${i}]`)
      for (const key of ['itemId', 'description', 'priceWei']) {
        if (typeof entry[key] !== 'string')
          throw bad(`catalog[${i}].${key} must be text`)
      }
      optionalString(entry.thumbnail, `catalog[${i}].thumbnail`)
    })
  }
  return item as unknown as DigitalGoodsItem
}
