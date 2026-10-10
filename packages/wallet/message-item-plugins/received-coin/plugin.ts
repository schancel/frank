import type { ReceivedCoinItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { receivedCoinCodec } from './codec'

export function initReceivedCoinPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('received-coin', capabilities)
  registry.register<ReceivedCoinItem>({
    type: 'received-coin',
    hydrate: raw => raw,
    previewText: raw => `Received coin on ${raw.chainIdentifier}`,
    encode: receivedCoinCodec.encode,
    decode: receivedCoinCodec.decode,
  })
}
