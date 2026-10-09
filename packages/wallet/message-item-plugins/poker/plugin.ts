import type { PokerItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { pokerCodec } from './codec'

export function initPokerPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('poker', capabilities)
  registry.register<PokerItem>({
    type: 'poker',
    hydrate: raw => raw,
    previewText: raw => {
      if (raw.action === 'create')
        return `Texas Hold'em Table created (${raw.tableId})`
      if (raw.action === 'join') return `Texas Hold'em: Player joined`
      if (raw.action === 'deal')
        return `Texas Hold'em: Hand dealt (pot: ${raw.pot})`
      if (raw.action === 'action' && raw.lastAction) {
        return `Poker: ${raw.lastAction.player.slice(0, 8)} ${
          raw.lastAction.action
        }${raw.lastAction.amount ? ` ${raw.lastAction.amount}` : ''}`
      }
      if (raw.action === 'showdown') return `Texas Hold'em: Showdown!`
      if (raw.action === 'settle') return `Texas Hold'em: Hand settled!`
      return "Texas Hold'em Poker"
    },
    encode: pokerCodec.encode,
    decode: pokerCodec.decode,
  })
}
