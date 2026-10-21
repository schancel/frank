import type { GroupWelcomeItem } from '../types'

import {
  cborItemCodec,
  chainAddress,
  hash32,
  hex,
  int,
  opt,
  req,
  str,
} from '@frank/cashweb/message-items/cbor-fields'
import { groupEpochCertificate } from './epoch-certificate'

/**
 * Group invitation item delivered in a 1:1 DM (Issues #70 & #1365).
 */
export const groupWelcomeCodec = cborItemCodec<GroupWelcomeItem>(
  'group-welcome',
  {
    groupId: req(0, hash32),
    groupPubKey: req(1, hex(33)),
    groupName: req(2, str(128, 1)),
    homeRelay: req(3, str(512, 1)),
    epoch: req(4, int(0, 1_000_000_000)),
    epochSecretHex: req(5, hash32),
    memberIndex: req(6, int(0, 10_000)),
    inviterAddress: opt(7, chainAddress),
    epochFrame: req(9, groupEpochCertificate),
    adminSecretKeyHex: opt(10, hash32),
  },
)
