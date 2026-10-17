import type { JournalCheckpointItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { journalCheckpointCodec } from './codec'

export function initJournalCheckpointPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('journal-checkpoint', capabilities)
  registry.register<JournalCheckpointItem>({
    type: 'journal-checkpoint',
    hydrate: raw => raw,
    previewText: () => 'Journal checkpoint',
    encode: journalCheckpointCodec.encode,
    decode: journalCheckpointCodec.decode,
  })
}
