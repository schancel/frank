import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'
import { MessageItemDecodeError, MessageItemEncodeError } from '@frank/cashweb/message-items/registry'

import {
  amount,
  bool,
  cborItemCodec,
  hash32,
  int,
  oneOf,
  opt,
  req,
  type ItemCodec,
} from '@frank/cashweb/message-items/cbor-fields'
import { diceRoll, id, multiplier, secret } from '../shared/limits'

const fields = cborItemCodec<SatoshiDiceItem>('dice', {
  action: req(0, oneOf('table', 'roll', 'result', 'rejected')),
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
  rejectionReason: opt(
    13,
    oneOf(
      'roll-not-offered',
      'commitment-mismatch',
      'invalid-client-seed',
      'invalid-target',
      'invalid-wager',
      'below-minimum',
      'payout-limit',
      'payment-not-confirmed',
    ),
  ),
})

function refusal(item: SatoshiDiceItem): string | undefined {
  if (item.action === 'rejected') {
    if (!item.rollId || !item.rejectionReason)
      return 'item: a rejected roll requires its original rollId and rejectionReason'
    if (
      [
        item.luckyNumber,
        item.isWin,
        item.serverSecret,
        item.payoutWei,
        item.nextRollId,
        item.nextCommitment,
      ].some(value => value !== undefined)
    )
      return 'item: a rejected roll cannot state a result or next offer'
  } else if (item.rejectionReason !== undefined) {
    return 'item.rejectionReason: only a rejected roll has a rejection reason'
  }
}

export const diceCodec: ItemCodec<SatoshiDiceItem> = {
  encode(item) {
    const bytes = fields.encode(item)
    const why = refusal(item)
    if (why) throw new MessageItemEncodeError('dice', why)
    return bytes
  },
  decode(bytes, context) {
    const item = fields.decode(bytes, context)
    const why = refusal(item)
    if (why) throw new MessageItemDecodeError('dice', why)
    return item
  },
}
