import type { DeviceClaimItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, num, opt, req, text } from '../shared/cbor-fields'

export const deviceClaimCodec = cborItemCodec<DeviceClaimItem>('device-claim', {
  instanceId: req(0, text),
  deviceName: opt(1, text),
  claimedAt: req(2, num),
  leaseDurationMs: opt(3, num),
})
