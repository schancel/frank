import type { HtlcRecordItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { htlcRecordCodec } from './codec'

export function initHtlcRecordPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('htlc-record', capabilities)
  registry.register<HtlcRecordItem>({
    type: 'htlc-record',
    hydrate: raw => raw,
    previewText: raw => `Swap HTLC ${raw.action} on ${raw.chainIdentifier}`,
    encode: htlcRecordCodec.encode,
    decode: htlcRecordCodec.decode,
  })
}
