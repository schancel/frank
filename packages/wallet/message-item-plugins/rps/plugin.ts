import type { RpsItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { rpsCodec } from './codec'

export function initRpsPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('rps', capabilities)
  registry.register<RpsItem>({
    type: 'rps',
    hydrate: raw => raw,
    previewText: raw => {
      if (raw.action === 'challenge') return 'Rock-Paper-Scissors Challenge'
      if (raw.action === 'start') return 'Rock-Paper-Scissors Match'
      if (raw.action === 'resolve') {
        return `RPS Result: ${
          raw.outcome === 'win'
            ? 'You won!'
            : raw.outcome === 'lose'
            ? 'You lost'
            : 'Tie'
        }`
      }
      return 'Rock-Paper-Scissors'
    },
    encode: rpsCodec.encode,
    decode: rpsCodec.decode,
  })
}
