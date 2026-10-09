import type { SwapRecordItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { swapRecordCodec } from './codec'

export function initSwapRecordPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('swap-record', capabilities)
  registry.register<SwapRecordItem>({
    type: 'swap-record',
    hydrate: raw => raw,
    previewText: raw =>
      `Instant Swap: ${raw.fromAmount} ${raw.fromAsset} → ${raw.toAmount} ${
        raw.toAsset
      } on ${raw.chain.toUpperCase()}`,
    encode: swapRecordCodec.encode,
    decode: swapRecordCodec.decode,
  })
}
