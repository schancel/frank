import type { P2PKHSendItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, num, req, text } from '../shared/cbor-fields'

export const p2pkhCodec = cborItemCodec<P2PKHSendItem>('p2pkh', {
  address: req(0, text),
  amount: req(1, num),
})
