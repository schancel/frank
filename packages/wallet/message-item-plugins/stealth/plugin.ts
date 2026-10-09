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
    // Reads the item's own self-reported `amount`, not a chain-verified figure: a known,
    // separately tracked gap (ticket #60). See `tallyValue` on the registry contract.
    tallyValue: raw => raw.amount,
    encode: encodeStealthItem,
    decode: decodeStealthItem,
  })
}
