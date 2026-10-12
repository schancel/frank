import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import {
  decodeRecipientAssetPaymentItem,
  encodeRecipientAssetPaymentItem,
} from './codec'

export function initRecipientAssetPaymentPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities
): void {
  requirePluginCapabilities('stealth-asset', capabilities)
  registry.register<RecipientAssetPaymentItem>({
    type: 'stealth-asset',
    hydrate: (raw) => raw,
    previewText: () => 'Stealth payment',
    encode: encodeRecipientAssetPaymentItem,
    decode: decodeRecipientAssetPaymentItem,
  })
}
