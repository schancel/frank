import type { WalletSyncItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import {
  walletSyncIncomingValue,
  walletSyncPreview,
} from '../shared/wallet-sync-shape'
import { walletSyncCodec } from './codec'

type Item = WalletSyncItem & { type: 'wallet-sync' }

export function initWalletSyncPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('wallet-sync', capabilities)
  registry.register<Item>({
    type: 'wallet-sync',
    hydrate: raw => raw,
    previewText: raw => walletSyncPreview('Wallet sync', raw),
    tallyValue: walletSyncIncomingValue,
    encode: walletSyncCodec.encode,
    decode: walletSyncCodec.decode,
  })
}
