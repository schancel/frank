import type { GroupEpochCertificate, GroupWelcomeMember } from '@frank/cashweb/types/messages'
import { chainAddress, hash32, hex, int, oneOf, opt, req, struct } from './cbor-fields'

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

export const groupRosterMember = struct<GroupWelcomeMember>({
  index: req(0, int(0, 255)),
  address: req(1, chainAddress),
  epochSigningPubKeyHex: req(2, hex(33)),
  role: opt(3, oneOf('admin', 'member')),
  identityPubKeyHex: req(4, hex(33)),
})
