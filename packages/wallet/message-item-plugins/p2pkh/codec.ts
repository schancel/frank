import type { P2PKHSendItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  decimal,
  req,
} from '../shared/cbor-fields'

export const p2pkhCodec = cborItemCodec<P2PKHSendItem>('p2pkh', {
  address: req(0, chainAddress),
  // A display amount the legacy sender wrote; it may have a fraction.
  amount: req(1, decimal(0, Number.MAX_SAFE_INTEGER)),
})
