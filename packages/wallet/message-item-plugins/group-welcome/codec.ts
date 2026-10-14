import type { GroupWelcomeItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  hash32,
  hex,
  int,
  listOf,
  opt,
  req,
  str,
} from '../shared/cbor-fields'
import { groupEpochCertificate, groupRosterMember } from '../shared/group-epoch-certificate'

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
    rosterMembers: opt(8, listOf(groupRosterMember, 256, 1)),
    epochFrame: req(9, groupEpochCertificate),
  },
)
