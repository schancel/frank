import type { LiarsDiceItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { liarsDiceCodec } from './codec'

export function initLiarsDicePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('liars-dice', capabilities)
  registry.register<LiarsDiceItem>({
    type: 'liars-dice',
    hydrate: raw => raw,
    previewText: raw => {
      if (raw.action === 'create')
        return `Liar's Dice: Table created (${raw.tableId})`
      if (raw.action === 'join') return `Liar's Dice: Player joined`
      if (raw.action === 'bid' && raw.currentBid) {
        return `Liar's Dice Bid: ${raw.currentBid.quantity}x [${raw.currentBid.face}]`
      }
      if (raw.action === 'challenge') return `Liar's Dice: Called Liar!`
      if (raw.action === 'showdown') return `Liar's Dice: Showdown!`
      if (raw.action === 'settle') return `Liar's Dice: Table Settled!`
      return "Liar's Dice (Perudo)"
    },
    encode: liarsDiceCodec.encode,
    decode: liarsDiceCodec.decode,
  })
}
