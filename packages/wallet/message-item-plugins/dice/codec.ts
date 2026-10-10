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
  clientSeed: opt(8, secret),
  payoutWei: opt(9, amount),
  commitment: opt(10, hash32),
  nextRollId: opt(11, id),
  nextCommitment: opt(12, hash32),
})
