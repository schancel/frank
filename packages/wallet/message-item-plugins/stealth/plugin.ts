import type { StealthItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeStealthItem, encodeStealthItem } from './codec'

export function initStealthPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('stealth', capabilities)
  registry.register<StealthItem>({
    type: 'stealth',
    hydrate: raw => raw,
    previewText: raw => {
      const network = raw.networkTag ?? raw.chainId
      if (network) {
        return `Sent stealth payment (${network})`
      }
      return 'Sent stealth payment'
    },
    // No `tallyValue`: the item's `amount` is the sender's claim, never value received. What a
    // stealth payment brought is what the wallet saw arrive on chain for the message.
    encode: encodeStealthItem,
    decode: decodeStealthItem,
  })
}
