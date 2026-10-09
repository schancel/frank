import type { SwapOfferItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  num,
  oneOf,
  opt,
  req,
  text,
} from '../shared/cbor-fields'

export const swapOfferCodec = cborItemCodec<SwapOfferItem>('swap-offer', {
  swapId: req(0, text),
  offeredChain: req(1, text),
  offeredAsset: req(2, text),
  offeredAmount: req(3, text),
  requestedChain: req(4, text),
  requestedAsset: req(5, text),
  requestedAmount: req(6, text),
  status: req(
    7,
    oneOf('pending', 'accepted', 'settled', 'cancelled', 'expired'),
  ),
  initiatorAddress: opt(8, text),
  recipientAddress: opt(9, text),
  createdAt: req(10, num),
  expiresAt: opt(11, num),
  hashLock: opt(12, text),
  preimage: opt(13, text),
  legATxHash: opt(14, text),
  legBTxHash: opt(15, text),
  claimTxHash: opt(16, text),
  originInstanceId: opt(17, text),
})
