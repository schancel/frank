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
    previewText: raw => `Group control (${raw.action}, epoch ${raw.epoch})`,
    encode: groupControlCodec.encode,
    decode: groupControlCodec.decode,
  })
}
