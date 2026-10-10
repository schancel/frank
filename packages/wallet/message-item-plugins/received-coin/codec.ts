import type { ReceivedCoinItem } from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  chainAddress,
  chainIdentifier,
  hash32,
  hex,
  int,
  listOf,
  oneOf,
  opt,
  req,
  timestampMs,
} from '../shared/cbor-fields'

/**
 * How one received coin's key is derived: the chain, the one-time account, and the data the
 * message carried for it (a stealth payment's ephemeral key, or a stamp's shared point and child
 * index). No key and no message content. Carried only in a note a wallet addresses to itself
 * (`SELF_ONLY_ITEM_TYPES`).
 */
export const receivedCoinCodec = cborItemCodec<ReceivedCoinItem>(
  'received-coin',
  {
    chainIdentifier: req(0, chainIdentifier),
    address: req(1, chainAddress),
    origin: req(2, oneOf('stealth', 'stamp')),
    // A compressed (33-byte) or uncompressed (65-byte) public key.
    ephemeralPubKey: opt(3, hex(33, 65)),
    stampSharedPoint: opt(4, hex(33, 65)),
    // A derivation index: below 2^31.
    childIndex: opt(5, int(0, 2_147_483_647)),
    claimedAmountWei: req(6, amount),
    // Complete signed transactions (each at most 16 KiB, as a payment member carries) or their
    // hashes; at most as many as a stealth item carries.
    transactions: opt(7, listOf(hex(32, 16_384), 16)),
    payloadDigest: opt(8, hash32),
    timestamp: req(9, timestampMs),
  },
)
