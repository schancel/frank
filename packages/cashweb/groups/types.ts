/** Signed relay epoch transport record; its nested message CBOR schema is feature-owned. */
export interface GroupEpochCertificate {
  epoch: number
  group_pubkey: string
  prev_epoch_hash: string
  write_pubkey: string
  read_token_hash: string
  encrypted_roster: string
  authority_sig: string
  epoch_hash: string
}
