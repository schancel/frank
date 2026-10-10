import type { SwapOfferItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  chainIdentifier,
  displayAmount,
  hash32,
  oneOf,
  opt,
  req,
  timestampMs,
  token,
  transactionId,
} from '../shared/cbor-fields'
import { id } from '../shared/limits'

/** An asset on a chain: a symbol such as "MON", or a token contract or mint address. */
const asset = token(128)

export const swapOfferCodec = cborItemCodec<SwapOfferItem>('swap-offer', {
  swapId: req(0, id),
  offeredChain: req(1, chainIdentifier),
  offeredAsset: req(2, asset),
  // What the person typed, in display units: it may have a fraction.
  offeredAmount: req(3, displayAmount),
  requestedChain: req(4, chainIdentifier),
  requestedAsset: req(5, asset),
  requestedAmount: req(6, displayAmount),
  status: req(
    7,
    oneOf('pending', 'accepted', 'settled', 'cancelled', 'expired'),
  ),
  // The two legs are on different chains, so these are addresses of either.
  initiatorAddress: opt(8, chainAddress),
  recipientAddress: opt(9, chainAddress),
  createdAt: req(10, timestampMs),
  expiresAt: opt(11, timestampMs),
  hashLock: opt(12, hash32),
  preimage: opt(13, hash32),
  legATxHash: opt(14, transactionId),
  legBTxHash: opt(15, transactionId),
  claimTxHash: opt(16, transactionId),
  originInstanceId: opt(17, id),
})
