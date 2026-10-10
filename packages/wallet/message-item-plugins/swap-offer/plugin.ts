import type { SwapOfferItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { swapOfferCodec } from './codec'

export function initSwapOfferPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('swap-offer', capabilities)
  registry.register<SwapOfferItem>({
    type: 'swap-offer',
    hydrate: raw => raw,
    previewText: raw =>
      `Atomic swap offer: ${raw.offeredAmount} ${raw.offeredAsset} (${raw.offeredChain}) for ${raw.requestedAmount} ${raw.requestedAsset} (${raw.requestedChain})`,
    tallyValue: raw => Number(raw.offeredAmount),
    encode: swapOfferCodec.encode,
    decode: swapOfferCodec.decode,
  })
}
