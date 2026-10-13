import type { GroupWelcomeItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { groupWelcomeCodec } from './codec'

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
