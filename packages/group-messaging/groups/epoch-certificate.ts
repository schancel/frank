import type { GroupEpochCertificate } from '@frank/cashweb/groups/types'
import {
  hash32,
  hex,
  int,
  req,
  struct,
} from '@frank/cashweb/message-items/cbor-fields'

export const groupEpochCertificate = struct<GroupEpochCertificate>({
  epoch: req(0, int(0, 1_000_000_000)),
  group_pubkey: req(1, hex(33)),
  prev_epoch_hash: req(2, hash32),
  write_pubkey: req(3, hex(33)),
  read_token_hash: req(4, hash32),
  encrypted_roster: req(5, hex(40, 262144)),
  authority_sig: req(6, hex(64)),
  epoch_hash: req(7, hash32),
})
