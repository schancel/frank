import type { GroupControlItem } from '../types'

import {
  cborItemCodec,
  chainAddress,
  hash32,
  hex,
  int,
  oneOf,
  opt,
  req,
} from '@frank/cashweb/message-items/cbor-fields'
import { groupEpochCertificate } from './epoch-certificate'

/**
 * Group epoch transition & membership control item (Issue #70).
 */
export const groupControlCodec = cborItemCodec<GroupControlItem>(
  'group-control',
  {
    groupId: req(0, hash32),
    action: req(
      1,
      oneOf('rotate-epoch', 'add-member', 'remove-member', 'leave'),
    ),
    epoch: req(2, int(0, 1_000_000_000)),
    prevEpochHash: req(3, hash32),
    epochSecretHex: opt(4, hash32),
    targetAddress: opt(5, chainAddress),
    targetMemberIndex: opt(6, int(0, 10_000)),
    targetEpochSigningPubKeyHex: opt(7, hex(33)),
    authoritySigHex: req(8, hex(64)),
    epochFrame: req(11, groupEpochCertificate),
  },
)
