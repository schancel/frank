import type { PaymentTransferItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import {
  walletSyncIncomingValue,
  walletSyncPreview,
} from '../shared/wallet-sync-shape'
import { paymentTransferCodec } from './codec'

type Item = PaymentTransferItem & { type: 'payment-transfer' }

export function initPaymentTransferPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('payment-transfer', capabilities)
  registry.register<Item>({
    type: 'payment-transfer',
    hydrate: raw => raw,
    previewText: raw => walletSyncPreview('Payment transfer', raw),
    tallyValue: walletSyncIncomingValue,
    encode: paymentTransferCodec.encode,
    decode: paymentTransferCodec.decode,
  })
}
