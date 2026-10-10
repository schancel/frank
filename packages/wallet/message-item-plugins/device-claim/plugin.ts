import type { DeviceClaimItem } from '@frank/cashweb/types/messages'

import {
  requirePluginCapabilities,
  type MessageItemPluginCapabilities,
  type MessageItemRegistry,
} from '../registry'
import { deviceClaimCodec } from './codec'

export function initDeviceClaimPlugin(
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
): void {
  requirePluginCapabilities('device-claim', capabilities)
  registry.register<DeviceClaimItem>({
    type: 'device-claim',
    hydrate: raw => raw,
    previewText: raw =>
      `Active master claim: ${raw.deviceName || raw.instanceId.slice(0, 8)}`,
    encode: deviceClaimCodec.encode,
    decode: deviceClaimCodec.decode,
  })
}
