import type { GroupWelcomeItem } from '../types'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '@frank/cashweb/message-items/registry'
import { groupWelcomeCodec } from './welcome-codec'

export function initGroupWelcomePlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('group-welcome', capabilities)
  registry.register<GroupWelcomeItem>({
    type: 'group-welcome',
    hydrate: raw => raw,
    previewText: raw => `Group invite: ${raw.groupName}`,
    encode: groupWelcomeCodec.encode,
    decode: groupWelcomeCodec.decode,
  })
}
