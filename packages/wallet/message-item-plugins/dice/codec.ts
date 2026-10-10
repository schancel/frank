import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'

import {
  amount,
  bool,
  cborItemCodec,
  hash32,
  int,
  oneOf,
  opt,
  req,
  token,
} from '../shared/cbor-fields'
import { diceRoll, id, multiplier, secret } from '../shared/limits'

export const diceCodec = cborItemCodec<SatoshiDiceItem>('dice', {
  action: req(0, oneOf('table', 'roll', 'result')),
  rollId: opt(1, id),
  // The bot accepts targets 1..65535.
  target: opt(2, int(1, 65_535)),
  multiplier: opt(3, multiplier),
  wagerWei: opt(4, amount),
  luckyNumber: opt(5, diceRoll),
  isWin: opt(6, bool),
  serverSecret: opt(7, secret),
  // `<16 hex of the message digest>_<milliseconds>`: about 30 characters.
  userNonce: opt(8, token(96)),
  payoutWei: opt(9, amount),
  txHash: opt(10, hash32),
})
