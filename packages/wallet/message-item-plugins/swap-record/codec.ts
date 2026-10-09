import type { SwapRecordItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  num,
  oneOf,
  opt,
  req,
  text,
} from '../shared/cbor-fields'

export const swapRecordCodec = cborItemCodec<SwapRecordItem>('swap-record', {
  swapId: req(0, text),
  chain: req(1, text),
  fromAsset: req(2, text),
  toAsset: req(3, text),
  fromAmount: req(4, text),
  toAmount: req(5, text),
  txHash: req(6, text),
  route: req(7, text),
  feeDisplay: req(8, text),
  destinationAddress: opt(9, text),
  status: req(10, oneOf('confirmed', 'pending', 'failed')),
  timestamp: req(11, num),
  cborPayload: opt(12, text),
})
