import type { HtlcRecordItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainIdentifier,
  matching,
  oneOf,
  req,
  timestampMs,
  transactionId,
} from '@frank/cashweb/message-items/cbor-fields'

/**
 * The record of one GenericHTLC call for a swap, in the account's note to itself. The same
 * spelling as the wallet's journal record (`EvmHtlcCallRecord`): a swap id of 64 lowercase hex
 * digits and a lock id of `0x` and 64 lowercase hex digits, so what is decoded is exactly what
 * the sending device journaled.
 */
export const htlcRecordCodec = cborItemCodec<HtlcRecordItem>('htlc-record', {
  chainIdentifier: req(0, chainIdentifier),
  action: req(1, oneOf('lock', 'withdraw', 'refund')),
  swapId: req(
    2,
    matching(/^[0-9a-f]{64}$/, '32 bytes of lowercase hexadecimal'),
  ),
  lockId: req(
    3,
    matching(/^0x[0-9a-f]{64}$/, '0x and 32 bytes of lowercase hexadecimal'),
  ),
  txHash: req(4, transactionId),
  timestamp: req(5, timestampMs),
})
