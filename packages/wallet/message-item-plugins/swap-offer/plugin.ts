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
    // The offered amount is validated as a plain decimal when the item is decoded. An item built
    // locally with anything else adds nothing; this never returns NaN.
    tallyValue: raw => {
      const value = Number(raw.offeredAmount)
      return Number.isFinite(value) ? value : 0
    },
    encode: swapOfferCodec.encode,
    decode: swapOfferCodec.decode,
  })
}
