import type { GroupControlItem } from '../types'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { groupControlCodec } from './control-codec'

export function initGroupControlPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('group-control', capabilities)
  registry.register<GroupControlItem>({
    type: 'group-control',
    hydrate: raw => raw,
    // The app shows its own line for these; this plain summary never shows protocol fields.
    previewText: raw =>
      raw.action === 'remove-member' && !raw.epochSecretHex
        ? 'Removed from the group'
        : 'Group membership changed',
    encode: groupControlCodec.encode,
    decode: groupControlCodec.decode,
  })
}
