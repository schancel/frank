import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { diceCodec } from './codec'

export function initDicePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('dice', capabilities)
  registry.register<SatoshiDiceItem>({
    type: 'dice',
    hydrate: raw => raw,
    previewText: raw => {
      if (raw.action === 'result') {
        return `Satoshi Dice: Rolled ${raw.luckyNumber} (${
          raw.isWin ? 'Win!' : 'Loss'
        })`
      }
      return 'Satoshi Dice Roll'
    },
    encode: diceCodec.encode,
    decode: diceCodec.decode,
  })
}
