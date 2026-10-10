import type { DeviceClaimItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  int,
  opt,
  req,
  str,
  timestampMs,
} from '../shared/cbor-fields'
import { id } from '../shared/limits'

export const deviceClaimCodec = cborItemCodec<DeviceClaimItem>('device-claim', {
  // A UUID, or `inst-<id>-<time>` where there is no UUID source.
  instanceId: req(0, id),
  // A device label such as "iOS Device".
  deviceName: opt(1, str(128)),
  claimedAt: req(2, timestampMs),
  // At most 30 days.
  leaseDurationMs: opt(3, int(0, 2_592_000_000)),
})
