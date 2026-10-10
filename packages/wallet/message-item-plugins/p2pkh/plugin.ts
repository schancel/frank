import type { P2PKHSendItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { p2pkhCodec } from './codec'

export function initP2pkhPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('p2pkh', capabilities)
  registry.register<P2PKHSendItem>({
    type: 'p2pkh',
    hydrate: raw => raw,
    // A legacy, Lotus-only send type: `deserializeMessageItems`
    // (`packages/wallet/chain/monad-chain.ts`) already throws if one is ever encountered on Monad,
    // so in practice this only matters for historical Lotus-origin message content.
    previewText: () => 'Sent a payment',
    encode: p2pkhCodec.encode,
    decode: p2pkhCodec.decode,
  })
}
