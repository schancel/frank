import type { SwapRecordItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  displayAmount,
  hex,
  oneOf,
  opt,
  req,
  str,
  timestampMs,
  token,
  transactionId,
} from '../shared/cbor-fields'
import { id } from '../shared/limits'

const asset = token(128)

export const swapRecordCodec = cborItemCodec<SwapRecordItem>('swap-record', {
  swapId: req(0, id),
  // The swap store writes a lowercased chain label here ("monad", "solana"), not a canonical
  // chain identifier, so it is bounded but not checked against the protocol registry.
  chain: req(1, token(64)),
  fromAsset: req(2, asset),
  toAsset: req(3, asset),
  fromAmount: req(4, displayAmount),
  toAmount: req(5, displayAmount),
  txHash: req(6, transactionId),
  route: req(7, str(256)),
  feeDisplay: req(8, str(64)),
  destinationAddress: opt(9, chainAddress),
  status: req(10, oneOf('confirmed', 'pending', 'failed')),
  timestamp: req(11, timestampMs),
  // The record again as hex CBOR; at most 4 KiB.
  cborPayload: opt(12, hex(1, 4096)),
})
