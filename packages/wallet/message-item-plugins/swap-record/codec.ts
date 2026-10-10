import type {
  SwapRecordAsset,
  SwapRecordItem,
} from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  chainAddress,
  chainIdentifier,
  int,
  opt,
  req,
  str,
  struct,
  timestampMs,
  token,
  transactionId,
} from '../shared/cbor-fields'
import { id } from '../shared/limits'

const asset = struct<SwapRecordAsset>({
  symbol: req(0, token(32)),
  // Absent for the chain's native coin.
  address: opt(1, chainAddress),
  decimals: req(2, int(0, 36)),
})

/**
 * The record of one swap: what was signed, in each asset's smallest unit. What the swap then did
 * is read from the chain by `txHash` and is not part of the item.
 */
export const swapRecordCodec = cborItemCodec<SwapRecordItem>('swap-record', {
  swapId: req(0, id),
  chainIdentifier: req(1, chainIdentifier),
  venueId: req(2, token(64)),
  txHash: req(3, transactionId),
  account: req(4, chainAddress),
  assetIn: req(5, asset),
  amountIn: req(6, amount),
  assetOut: req(7, asset),
  quotedAmountOut: req(8, amount),
  minimumAmountOut: req(9, amount),
  interfaceFee: req(10, amount),
  networkFee: req(11, amount),
  // The exchange's own route, as JSON text; at most 1 KiB.
  route: opt(12, str(1024, 1)),
  timestamp: req(13, timestampMs),
})
