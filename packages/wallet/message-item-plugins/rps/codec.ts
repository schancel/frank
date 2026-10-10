import type { RpsItem } from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  evmAddress,
  hash32,
  oneOf,
  opt,
  req,
} from '../shared/cbor-fields'
import { id, secret } from '../shared/limits'

const move = oneOf('rock', 'paper', 'scissors')

export const rpsCodec = cborItemCodec<RpsItem>('rps', {
  action: req(0, oneOf('challenge', 'start', 'move', 'resolve')),
  matchId: opt(1, id),
  commitHash: opt(2, hash32),
  playerMove: opt(3, move),
  botMove: opt(4, move),
  secretSalt: opt(5, secret),
  wagerWei: opt(6, amount),
  outcome: opt(7, oneOf('win', 'lose', 'tie')),
  txHash: opt(8, hash32),
  opponentAddress: opt(9, evmAddress),
})
