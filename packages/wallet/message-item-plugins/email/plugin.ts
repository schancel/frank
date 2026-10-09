import type { EmailItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { decodeEmailItem, encodeEmailItem } from './codec'

export function initEmailPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('email', capabilities)
  registry.register<EmailItem>({
    type: 'email',
    hydrate: raw => raw,
    previewText: raw =>
      `✉️ ${raw.subject || '(No Subject)'}: ${(raw.textBody || '').slice(
        0,
        60,
      )}`,
    encode: encodeEmailItem,
    decode: decodeEmailItem,
  })
}
