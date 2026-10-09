/**
 * The `digital-goods` message item type (ticket #63), installed by `initDigitalGoodsPlugin`.
 * Simpler than `blackjack-move/plugin.ts`: `hydrate()` needs no async on-chain lookup at all, since a `request`'s payment is that same message's own stamp, and the relay has *already*
 * verified that payment before the message could ever be stored or fetched --
 * `context.message.stampValueWei` is already the real, trustworthy figure. There's simply nothing
 * left to go verify externally, unlike blackjack's wager (a separate transfer the relay knows
 * nothing about).
 */
import { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeDigitalGoods, encodeDigitalGoods } from './codec'

export interface HydratedDigitalGoods extends DigitalGoodsItem {
  /** Only set for `request` -- copied straight from the message's own relay-verified stamp value,
   * never a number read from the wire payload itself (there isn't one to read; see
   * `DigitalGoodsItem`'s own header on `@frank/cashweb/types/messages`). */
  paidWei?: bigint
}

export function initDigitalGoodsPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('digital-goods', capabilities)
  registry.register<DigitalGoodsItem, HydratedDigitalGoods>({
    type: 'digital-goods',
    hydrate(raw, context) {
      return {
        ...raw,
        paidWei: raw.action === 'request' ? context.message.stampValueWei : undefined,
      }
    },
    previewText(raw) {
      switch (raw.action) {
        case 'catalog':
          return `Sent a catalog (${raw.catalog?.length ?? 0} item${raw.catalog?.length === 1 ? '' : 's'})`
        case 'request':
          return `Requested: ${raw.itemId ?? 'an item'}`
        case 'fulfill':
          return 'Delivered a purchase'
        case 'error':
          return raw.message ?? 'Purchase error'
      }
    },
    encode: encodeDigitalGoods,
    decode: decodeDigitalGoods,
  })
}
