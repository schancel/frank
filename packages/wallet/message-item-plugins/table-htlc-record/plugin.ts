import type { TableHtlcRecordItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { tableHtlcRecordCodec } from './codec'

export function initTableHtlcRecordPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('table-htlc-record', capabilities)
  registry.register<TableHtlcRecordItem>({
    type: 'table-htlc-record',
    hydrate: raw => raw,
    previewText: raw =>
      `Table buy-in ${raw.action} (${raw.game}) on ${raw.chainIdentifier}`,
    encode: tableHtlcRecordCodec.encode,
    decode: tableHtlcRecordCodec.decode,
  })
}
