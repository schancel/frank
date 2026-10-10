import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'

import {
  bool,
  cborItemCodec,
  num,
  oneOf,
  opt,
  req,
  text,
} from '../shared/cbor-fields'

export const diceCodec = cborItemCodec<SatoshiDiceItem>('dice', {
  action: req(0, oneOf('table', 'roll', 'result')),
  rollId: opt(1, text),
  target: opt(2, num),
  multiplier: opt(3, num),
  wagerWei: opt(4, text),
  luckyNumber: opt(5, num),
  isWin: opt(6, bool),
  serverSecret: opt(7, text),
  userNonce: opt(8, text),
  payoutWei: opt(9, text),
  txHash: opt(10, text),
})
